-- ============================================================================
-- 计数一致性加固（增量升级）
-- 说明：v1 已建库的项目执行本文件即可；新项目直接跑 init.sql（已包含同样逻辑）。
--
-- 问题：post_votes / comment_likes / favorites 的 user_id 都带 on delete cascade，
--       管理员封禁并删除账号（或用户注销）时，明细行被级联删除，
--       但 posts.like_count / comments.like_count / posts.favorite_count 没人扣减，
--       计数会永久偏高（自查时发现 1 条评论 like_count=1 但明细为 0）。
--
-- 修复：给三张明细表加 AFTER DELETE 触发器，按被删行反向扣减计数；
--       并把 comment_likes 也纳入 recount_posts 的修复范围。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 明细行被删（含级联删除）时反向扣减计数
-- ---------------------------------------------------------------------------
create or replace function public.sync_vote_count_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts as p
     set like_count    = greatest(p.like_count    - (case when old.value =  1 then 1 else 0 end), 0),
         dislike_count = greatest(p.dislike_count - (case when old.value = -1 then 1 else 0 end), 0)
   where p.id = old.post_id;
  return old;
end;
$$;

drop trigger if exists trg_post_votes_sync_on_delete on public.post_votes;
create trigger trg_post_votes_sync_on_delete
  after delete on public.post_votes
  for each row execute function public.sync_vote_count_on_delete();

create or replace function public.sync_comment_like_count_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.comments as c
     set like_count = greatest(c.like_count - 1, 0)
   where c.id = old.comment_id;
  return old;
end;
$$;

drop trigger if exists trg_comment_likes_sync_on_delete on public.comment_likes;
create trigger trg_comment_likes_sync_on_delete
  after delete on public.comment_likes
  for each row execute function public.sync_comment_like_count_on_delete();

create or replace function public.sync_favorite_count_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts as p
     set favorite_count = greatest(p.favorite_count - 1, 0)
   where p.id = old.post_id;
  return old;
end;
$$;

drop trigger if exists trg_favorites_sync_on_delete on public.favorites;
create trigger trg_favorites_sync_on_delete
  after delete on public.favorites
  for each row execute function public.sync_favorite_count_on_delete();

revoke all on function public.sync_vote_count_on_delete() from public, anon, authenticated;
revoke all on function public.sync_comment_like_count_on_delete() from public, anon, authenticated;
revoke all on function public.sync_favorite_count_on_delete() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) recount_posts 顺带把评论点赞数也对齐（返回修复的帖子行数，签名不变）
-- ---------------------------------------------------------------------------
create or replace function public.recount_posts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if not public.is_super_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;

  update public.posts p
     set like_count = coalesce((
           select count(*) from public.post_votes v
           where v.post_id = p.id and v.value = 1
         ), 0),
         dislike_count = coalesce((
           select count(*) from public.post_votes v
           where v.post_id = p.id and v.value = -1
         ), 0),
         favorite_count = coalesce((
           select count(*) from public.favorites f
           where f.post_id = p.id
         ), 0),
         comment_count = coalesce((
           select count(*) from public.comments c
           where c.post_id = p.id and not c.is_deleted
         ), 0);
  get diagnostics v_n = row_count;

  -- 评论点赞数一并对齐（历史脏数据 / 级联删除残留）
  update public.comments c
     set like_count = coalesce((
           select count(*) from public.comment_likes l
           where l.comment_id = c.id
         ), 0);

  return v_n;
end;
$$;

grant execute on function public.recount_posts() to authenticated;

notify pgrst, 'reload schema';
