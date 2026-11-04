-- ============================================================================
-- 帖子时间筛选（增量升级）
-- 说明：v1 已建库的项目执行本文件即可；新项目直接跑 init.sql（已包含同样逻辑）。
--
-- 变更：search_posts 增加两个可选参数
--   p_since timestamptz default null  —— 只要 created_at >= p_since 的帖子
--   p_until timestamptz default null  —— 只要 created_at <  p_until 的帖子
-- 两个都传 null 时行为与旧版完全一致，旧调用（5 个参数）不受影响。
-- ============================================================================

-- 旧签名的函数先删掉，避免 create or replace 生成重载后 grant 指向旧签名
drop function if exists public.search_posts(text, text, text, int, int);

create or replace function public.search_posts(
  p_query  text,
  p_board  text default null,
  p_sort   text default 'new',
  p_limit  int  default 20,
  p_offset int  default 0,
  p_since  timestamptz default null,
  p_until  timestamptz default null
)
returns table (
  id                 uuid,
  board_slug         text,
  author_id          uuid,
  title              text,
  content            text,
  images             text[],
  like_count         int,
  dislike_count      int,
  comment_count      int,
  favorite_count     int,
  is_pinned          boolean,
  is_locked          boolean,
  created_at         timestamptz,
  updated_at         timestamptz,
  author_display_name text,
  author_avatar      text
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_query   text := btrim(coalesce(p_query, ''));
  v_pattern text;
begin
  if v_query = '' then
    return;  -- 空关键词：返回空集，前端不应发请求
  end if;

  -- 转义 ilike 通配符：先转义反斜杠，再转义 % 和 _
  v_pattern := '%'
    || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_')
    || '%';

  return query
  select
    p.id, p.board_slug, p.author_id, p.title, p.content, p.images,
    p.like_count, p.dislike_count, p.comment_count, p.favorite_count,
    p.is_pinned, p.is_locked, p.created_at, p.updated_at,
    pr.display_name, pr.avatar
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  where not p.is_deleted
    and (p_board is null or btrim(p_board) = '' or p.board_slug = btrim(p_board))
    and (p_since is null or p.created_at >= p_since)
    and (p_until is null or p.created_at <  p_until)
    and (p.title ilike v_pattern or p.content ilike v_pattern)
  order by
    p.is_pinned desc,
    (case when lower(coalesce(p_sort, 'new')) = 'hot' then p.like_count else 0 end) desc,
    p.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

grant execute on function public.search_posts(text, text, text, int, int, timestamptz, timestamptz)
  to anon, authenticated;

notify pgrst, 'reload schema';
