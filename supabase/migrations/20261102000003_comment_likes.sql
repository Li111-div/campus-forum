-- ============================================================================
-- 评论点赞（增量升级）
-- 说明：v1 已建库的项目执行本文件即可；新项目直接跑 init.sql（已包含同样逻辑）。
--
-- 1) comments 增加 like_count 计数列（默认 0，只由 toggle_comment_like 维护）
-- 2) 新增 comment_likes 明细表（前端禁止直写，只走 RPC）
-- 3) 新增 toggle_comment_like(p_comment_id) → { like_count, liked }
-- 4) 权限：明细表只给 SELECT（RLS 只返回本人行），写入只能走 RPC
-- ============================================================================

-- 1) 计数列
alter table public.comments
  add column if not exists like_count int not null default 0;

-- 2) 点赞明细
create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create index if not exists comment_likes_user_idx on public.comment_likes (user_id);

-- 3) RPC：点一次赞 / 再点一次取消（重复点赞只算一次）
create or replace function public.toggle_comment_like(p_comment_id uuid)
returns table (like_count int, liked boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exists boolean;
  v_count  int;
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception '账号当前无法操作' using errcode = '42501';
  end if;

  if p_comment_id is null or not exists (
    select 1 from public.comments c
    where c.id = p_comment_id
      and not c.is_deleted
      and public.can_read_post(c.post_id)
  ) then
    raise exception '评论不存在或已删除' using errcode = 'P0002';
  end if;

  select exists (
    select 1 from public.comment_likes l
    where l.comment_id = p_comment_id and l.user_id = auth.uid()
  ) into v_exists;

  if v_exists then
    delete from public.comment_likes l
    where l.comment_id = p_comment_id and l.user_id = auth.uid();

    -- OUT 参数名 like_count 与列同名，必须 c. 限定
    update public.comments as c
       set like_count = greatest(c.like_count - 1, 0)
     where c.id = p_comment_id
     returning c.like_count into v_count;
  else
    insert into public.comment_likes (comment_id, user_id)
    values (p_comment_id, auth.uid());

    update public.comments as c
       set like_count = c.like_count + 1
     where c.id = p_comment_id
     returning c.like_count into v_count;
  end if;

  return query select v_count, not v_exists;
end;
$$;

-- 4) 权限与 RLS
revoke all on public.comment_likes from anon, authenticated;
grant select on public.comment_likes to authenticated;

alter table public.comment_likes enable row level security;

drop policy if exists comment_likes_select on public.comment_likes;
create policy comment_likes_select on public.comment_likes
  for select to authenticated
  using (user_id = auth.uid());

revoke all on function public.toggle_comment_like(uuid) from public, anon, authenticated;
grant execute on function public.toggle_comment_like(uuid) to authenticated;

notify pgrst, 'reload schema';
