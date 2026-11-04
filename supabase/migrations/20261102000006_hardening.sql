-- ============================================================================
-- 安全加固（增量升级）
-- 说明：v1 已建库的项目执行本文件即可；新项目直接跑 init.sql（已包含同样逻辑）。
--
-- 1) 收回 PUBLIC 的 EXECUTE 默认权限
--    PostgreSQL 每 create function 都会默认 GRANT EXECUTE TO PUBLIC，
--    之前几个增量迁移只写了 grant、没写 revoke，导致 anon 也能"调用"管理类 RPC
--    （函数内部有鉴权兜底，没有真正越权，但违反"先 revoke 再按需 grant"的约定）。
-- 2) 简介（bio）也过违禁词：原来只校验 display_name，可以拿 bio 发广告。
-- 3) 举报校验：目标必须存在，且不能举报自己。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 函数权限：先全部收回，再按需授予
-- ---------------------------------------------------------------------------
revoke all on all functions in schema public from public;

-- 内部辅助函数：谁都不要直接调
revoke all on function public.invisible_chars() from public, anon, authenticated;
revoke all on function public.find_banned_word(text) from public, anon, authenticated;
revoke all on function public.assert_no_banned_word(text, text) from public, anon, authenticated;
revoke all on function public.check_post_words() from public, anon, authenticated;
revoke all on function public.check_comment_words() from public, anon, authenticated;
revoke all on function public.check_profile_words() from public, anon, authenticated;
revoke all on function public.check_handle_words() from public, anon, authenticated;
revoke all on function public.check_feedback_words() from public, anon, authenticated;
revoke all on function public.cfg_int(text, int) from public, anon, authenticated;
revoke all on function public.prepare_post_insert() from public, anon, authenticated;
revoke all on function public.prepare_comment_insert() from public, anon, authenticated;
revoke all on function public.notify_on_comment() from public, anon, authenticated;
revoke all on function public.notify_followers_on_post() from public, anon, authenticated;
revoke all on function public.sync_comment_count() from public, anon, authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- 基础判断函数（RLS 策略内部要调，anon 也要能执行）
grant execute on function public.is_admin()               to anon, authenticated;
grant execute on function public.is_super_admin()         to anon, authenticated;
grant execute on function public.is_active_user()         to anon, authenticated;
grant execute on function public.can_read_post(uuid)      to anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- 公开查询类
grant execute on function public.search_posts(text, text, text, int, int, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.posts_by_author(uuid, int, int) to anon, authenticated;
grant execute on function public.author_profile(uuid)            to anon, authenticated;
grant execute on function public.check_banned_word(text)         to anon, authenticated;

-- 登录用户类
grant execute on function public.vote_post(uuid, smallint)       to authenticated;
grant execute on function public.toggle_favorite(uuid)           to authenticated;
grant execute on function public.toggle_comment_like(uuid)       to authenticated;
grant execute on function public.toggle_follow(uuid)             to authenticated;
grant execute on function public.soft_delete_post(uuid)          to authenticated;
grant execute on function public.soft_delete_comment(uuid)       to authenticated;
grant execute on function public.mark_all_notifications_read()   to authenticated;
grant execute on function public.mark_notification_read(uuid)    to authenticated;
grant execute on function public.my_following(int, int)          to authenticated;
grant execute on function public.my_followers(int, int)          to authenticated;
grant execute on function public.my_profile()                    to authenticated;
grant execute on function public.submit_feedback(text, text, text) to authenticated;
grant execute on function public.my_feedback()                   to authenticated;

-- Supabase 在 public schema 上配了 ALTER DEFAULT PRIVILEGES，
-- 新建函数会自动 grant 给 anon；这几个只有登录用户/管理员能调，必须显式收回。
revoke all on function public.submit_feedback(text, text, text) from anon;
revoke all on function public.my_feedback()                     from anon;

-- 管理员类（函数内部再判 is_admin / is_super_admin）
grant execute on function public.admin_set_role(uuid, public.user_role)                 to authenticated;
grant execute on function public.admin_set_active(uuid, boolean, text, timestamptz)     to authenticated;
grant execute on function public.admin_set_pinned(uuid, boolean)                        to authenticated;
grant execute on function public.admin_lock_post(uuid, boolean)                         to authenticated;
grant execute on function public.admin_soft_delete_post(uuid)                           to authenticated;
grant execute on function public.admin_soft_delete_comment(uuid)                        to authenticated;
grant execute on function public.admin_resolve_report(uuid, public.report_status, text) to authenticated;
grant execute on function public.recount_posts()                                        to authenticated;
grant execute on function public.admin_banned_words()                                   to authenticated;
grant execute on function public.admin_add_banned_word(text, text)                      to authenticated;
grant execute on function public.admin_delete_banned_word(uuid)                         to authenticated;
grant execute on function public.admin_feedback(text)                                   to authenticated;
grant execute on function public.admin_resolve_feedback(uuid, text)                     to authenticated;

revoke all on function public.admin_feedback(text)               from anon;
revoke all on function public.admin_resolve_feedback(uuid, text) from anon;

grant execute on all functions in schema public to service_role;

-- ---------------------------------------------------------------------------
-- 2) 简介（bio）也要过违禁词
-- ---------------------------------------------------------------------------
create or replace function public.check_profile_words()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.display_name is distinct from old.display_name then
    perform public.assert_no_banned_word(new.display_name, '昵称');
  end if;
  if tg_op = 'INSERT' or new.bio is distinct from old.bio then
    perform public.assert_no_banned_word(new.bio, '简介');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_check_words on public.profiles;
create trigger trg_profiles_check_words
  before insert or update of display_name, bio on public.profiles
  for each row execute function public.check_profile_words();

-- ---------------------------------------------------------------------------
-- 3) 举报校验：目标必须存在，且不能举报自己
--    reports.target_id 没有外键（要同时指向 3 张表），只能在触发器里判。
-- ---------------------------------------------------------------------------
create or replace function public.validate_report_target()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.target_type = 'post' then
    if not exists (select 1 from public.posts p where p.id = new.target_id and not p.is_deleted) then
      raise exception '举报的帖子不存在或已被删除' using errcode = 'P0002';
    end if;
  elsif new.target_type = 'comment' then
    if not exists (select 1 from public.comments c where c.id = new.target_id and not c.is_deleted) then
      raise exception '举报的评论不存在或已被删除' using errcode = 'P0002';
    end if;
  elsif new.target_type = 'user' then
    if new.target_id = auth.uid() then
      raise exception '不能举报自己' using errcode = '22023';
    end if;
    if not exists (select 1 from public.profiles p where p.id = new.target_id) then
      raise exception '举报的用户不存在' using errcode = 'P0002';
    end if;
  end if;
  return new;
end;
$$;

-- 新函数同样要收回 PUBLIC 默认执行权（create function 时会自动授予）
revoke all on function public.validate_report_target() from public, anon, authenticated;

drop trigger if exists trg_reports_validate_target on public.reports;
create trigger trg_reports_validate_target
  before insert on public.reports
  for each row execute function public.validate_report_target();

notify pgrst, 'reload schema';
