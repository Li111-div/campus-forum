-- ============================================================================
-- 楼中楼（回复评论）增量升级
-- 说明：v1 已建库的项目执行本文件即可；新项目直接跑 init.sql（已包含同样逻辑）。
--
-- 1) notify_on_comment：回复别人的评论 → 给被回复者发 type='reply' 通知；
--    同时（若帖子作者既不是回复者也不是被回复者）仍给帖子作者发 type='comment' 通知。
-- 2) soft_delete_comment：删除评论时连带软删除它下面的一层回复，避免柱子被删后
--    留下没有上下文的孤儿回复；comment_count 由 sync_comment_count 触发器自动扣减。
-- ============================================================================

create or replace function public.notify_on_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post_author   uuid;
  v_parent_author uuid;
begin
  if new.is_deleted then
    return null;
  end if;

  select p.author_id into v_post_author
  from public.posts p
  where p.id = new.post_id;

  -- ① 回复某条评论：通知被回复的人
  if new.parent_id is not null then
    select c.author_id into v_parent_author
    from public.comments c
    where c.id = new.parent_id;

    if v_parent_author is not null and v_parent_author <> new.author_id then
      insert into public.notifications (user_id, type, post_id, comment_id, actor_id)
      values (v_parent_author, 'reply', new.post_id, new.id, new.author_id);
    end if;

    -- ② 帖子作者也要收到“有人评论了你的帖子”（如果作者与回复者/被回复者都不同）
    if v_post_author is not null
       and v_post_author <> new.author_id
       and v_post_author <> coalesce(v_parent_author, '00000000-0000-0000-0000-000000000000'::uuid) then
      insert into public.notifications (user_id, type, post_id, comment_id, actor_id)
      values (v_post_author, 'comment', new.post_id, new.id, new.author_id);
    end if;

    return null;
  end if;

  -- ③ 普通评论：只通知帖子作者（自己评论自己不通知）
  if v_post_author is null or v_post_author = new.author_id then
    return null;
  end if;

  insert into public.notifications (user_id, type, post_id, comment_id, actor_id)
  values (v_post_author, 'comment', new.post_id, new.id, new.author_id);

  return null;
end;
$$;

create or replace function public.soft_delete_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if p_comment_id is null or not exists (
    select 1 from public.comments c
    where c.id = p_comment_id
      and (c.author_id = auth.uid() or public.is_admin())
  ) then
    raise exception '无权删除该评论' using errcode = '42501';
  end if;

  -- 先删子回复（一层），再删主评论；comment_count 由触发器逐条扣减
  update public.comments
     set is_deleted = true
   where parent_id = p_comment_id and not is_deleted;

  update public.comments
     set is_deleted = true
   where id = p_comment_id and not is_deleted;
end;
$$;

-- 管理员删除评论同样连带删除一层回复
create or replace function public.admin_soft_delete_comment(p_comment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if p_comment_id is null or not exists (
    select 1 from public.comments c where c.id = p_comment_id
  ) then
    raise exception '评论不存在' using errcode = 'P0002';
  end if;

  update public.comments
     set is_deleted = true
   where parent_id = p_comment_id and not is_deleted;

  update public.comments
     set is_deleted = true
   where id = p_comment_id and not is_deleted;
end;
$$;

-- 函数权限沿用 init.sql 中已有的 grant；重新创建不会丢失原有授权。
-- 通知 PostgREST 刷新 schema 缓存
notify pgrst, 'reload schema';
