-- ============================================================================
-- 校园论坛 v1 · Supabase 数据库初始化脚本（单文件版）
-- ----------------------------------------------------------------------------
-- 用法：
--   Supabase Dashboard → SQL Editor → New query → 粘贴本文件全文 → Run
--   Supabase 项目必须是「空库」（或至少没有同名的表 / 类型）。
--
-- 依据：docs/设计方案.md v2.5 第 10–12 节、19.1；docs/验收清单.md M0 段。
--
-- 简化口径（与设计方案 v2.5 的差异，已按这些口径落地）：
--   1) 不做 Edge Function、不做用户名登录。注册只传 邮箱 + 昵称 + 密码，
--      前端 signUp 时 options.data = { display_name }（可选 username）。
--      触发器 handle_new_user 负责写 profiles 与 user_handles。
--   2) 不做图片上传：保留 posts.images 与「≤9 张」CHECK，但不建 Storage 桶、
--      不写 storage.* 策略；max_images_per_post 种子值为 0。
--   3) 限额机制保留（触发器读 app_config），但种子值放宽：
--      post_cooldown_minutes=0, comment_cooldown_minutes=0,
--      post_daily_limit=50, comment_daily_limit=200, max_images_per_post=0。
--
-- 执行顺序（务必保持，见设计方案「教训 4」）：
--   枚举 → 表 → 函数 → 触发器 → 权限(revoke + 列级 grant) → RLS 策略 → 种子
--   RLS 策略里引用的函数必须在策略之前创建，故本文件的顺序就是最终顺序。
--
-- 三层防线（设计方案第 11 节）：
--   ① revoke all on tables          —— 收回 Supabase 默认给 anon/authenticated 的全部表权限
--   ② 列级 grant                    —— 只放行允许读 / 允许写的列（计数列、role、is_pinned 等一律不放）
--   ③ RPC（security definer）       —— 点赞/收藏/关注/软删/管理动作只能走 RPC，函数内再校验一次权限
--
-- 本文件可重复执行（幂等）：表用 if not exists，函数用 create or replace，
-- 触发器 / 策略先 drop if exists，索引 if not exists，种子 on conflict。
-- ============================================================================


-- ============================================================================
-- 1. 枚举类型
--   CREATE TYPE 没有 IF NOT EXISTS，用 DO 块吞掉 duplicate_object，保证可重跑。
-- ============================================================================

do $$
begin
  create type public.user_role as enum ('user', 'moderator', 'admin');
exception when duplicate_object then null;
end
$$;

do $$
begin
  create type public.report_status as enum ('pending', 'resolved', 'rejected');
exception when duplicate_object then null;
end
$$;

do $$
begin
  create type public.report_target as enum ('post', 'comment', 'user');
exception when duplicate_object then null;
end
$$;

-- follow_post = 关注的人发了新帖（v2.4）
do $$
begin
  create type public.notification_type as enum
    ('comment', 'reply', 'like', 'system', 'follow_post');
exception when duplicate_object then null;
end
$$;


-- ============================================================================
-- 2. 表（11 张）
--   注意：外键约束不显式命名，让 PostgreSQL 用默认名，前端 PostgREST 嵌入查询
--   依赖这些默认名：posts_author_id_fkey / comments_author_id_fkey /
--   comments_post_id_fkey / favorites_post_id_fkey /
--   notifications_actor_id_fkey / notifications_post_id_fkey /
--   reports_reporter_id_fkey ...
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 2.1 profiles：用户资料
--   严禁出现 password / username / email 列（密码在 auth.users，用户名在 user_handles）
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  display_name    text not null,
  avatar          text not null default 'avatar-1',
  bio             text not null default '',
  role            public.user_role not null default 'user',
  is_active       boolean not null default true,
  banned_reason   text,
  banned_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint profiles_display_name_len
    check (char_length(display_name) between 2 and 20),
  constraint profiles_bio_len
    check (char_length(bio) <= 200)
);

create index if not exists profiles_role_idx
  on public.profiles (role) where role <> 'user';

-- ---------------------------------------------------------------------------
-- 2.2 user_handles：用户名句柄（独立表，不公开）
-- ---------------------------------------------------------------------------
create table if not exists public.user_handles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  username    text not null,
  is_current  boolean not null default true,
  released_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint user_handles_username_fmt
    check (username ~ '^[a-z0-9_]{3,20}$'),
  -- 释放的句柄必须带时间戳，用于防抢注
  constraint user_handles_released_ck
    check ((is_current and released_at is null) or (not is_current))
);

-- 当前句柄全局唯一（只有 is_current = true 的行参与）
create unique index if not exists user_handles_current_key
  on public.user_handles (username) where is_current;

-- 每个用户最多一个当前句柄
create unique index if not exists user_handles_one_current_per_user
  on public.user_handles (user_id) where is_current;

-- 历史句柄索引（防抢注查询用）
create index if not exists user_handles_username_idx
  on public.user_handles (username, released_at desc);

-- ---------------------------------------------------------------------------
-- 2.3 boards：板块（slug 作文本主键）
-- ---------------------------------------------------------------------------
create table if not exists public.boards (
  slug          text primary key,
  name          text not null,
  description   text not null default '',
  icon          text not null default '',
  accent        text not null default 'primary',
  sort_order    int not null default 0,
  is_anonymous  boolean not null default false,
  is_locked     boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2.4 posts：帖子
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id              uuid primary key default gen_random_uuid(),
  board_slug      text not null references public.boards(slug) on update cascade,
  author_id       uuid not null references public.profiles(id) on delete cascade,
  title           text not null,
  content         text not null,
  images          text[] not null default '{}',
  like_count      int not null default 0,
  dislike_count   int not null default 0,
  comment_count   int not null default 0,
  favorite_count  int not null default 0,
  is_pinned       boolean not null default false,
  is_locked       boolean not null default false,
  is_deleted      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint posts_title_len
    check (char_length(title) between 2 and 80),
  constraint posts_content_len
    check (char_length(content) between 1 and 5000),
  constraint posts_images_len
    check (coalesce(array_length(images, 1), 0) <= 9),
  constraint posts_counts_non_negative
    check (like_count >= 0 and dislike_count >= 0
           and comment_count >= 0 and favorite_count >= 0)
);

-- 板块列表（最新）
create index if not exists posts_board_created_idx
  on public.posts (board_slug, created_at desc) where not is_deleted;

-- 全局列表（最新）
create index if not exists posts_created_idx
  on public.posts (created_at desc) where not is_deleted;

-- 最热
create index if not exists posts_hot_idx
  on public.posts (like_count desc, created_at desc) where not is_deleted;

-- 置顶优先
create index if not exists posts_pinned_idx
  on public.posts (is_pinned desc, created_at desc) where not is_deleted;

-- 我的帖子 / 作者主页
create index if not exists posts_author_created_idx
  on public.posts (author_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2.5 comments：评论（parent_id 为二期楼中楼预留）
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  parent_id   uuid references public.comments(id) on delete cascade,
  content     text not null,
  is_deleted  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  like_count  int not null default 0,
  constraint comments_content_len
    check (char_length(content) between 1 and 1000)
);

create index if not exists comments_post_created_idx
  on public.comments (post_id, created_at) where not is_deleted;

create index if not exists comments_author_created_idx
  on public.comments (author_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2.6 post_votes：赞 / 踩明细（前端禁止直写，只走 vote_post RPC）
-- ---------------------------------------------------------------------------
create table if not exists public.post_votes (
  post_id    uuid not null references public.posts(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  value      smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 2.7 favorites：收藏（前端禁止直写，只走 toggle_favorite RPC）
-- ---------------------------------------------------------------------------
create table if not exists public.favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  post_id    uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index if not exists favorites_post_idx on public.favorites (post_id);

-- ---------------------------------------------------------------------------
-- 2.8 follows：关注关系（前端禁止直写，只走 toggle_follow RPC）
-- ---------------------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  target_id   uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, target_id),
  constraint no_self_follow check (follower_id <> target_id)
);

create index if not exists follows_target_idx on public.follows (target_id);
create index if not exists follows_follower_idx on public.follows (follower_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2.9 notifications：通知（写入只能由触发器完成）
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  type       public.notification_type not null,
  post_id    uuid references public.posts(id) on delete cascade,
  comment_id uuid references public.comments(id) on delete cascade,
  actor_id   uuid references public.profiles(id) on delete set null,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, is_read, created_at desc);

-- ---------------------------------------------------------------------------
-- 2.10 reports：举报
--   reporter_id 默认取 auth.uid()，前端 INSERT 只需传 target_type/target_id/reason/detail
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id              uuid primary key default gen_random_uuid(),
  reporter_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  target_type     public.report_target not null,
  target_id       uuid not null,
  reason          text not null,
  detail          text not null default '',
  status          public.report_status not null default 'pending',
  handled_by      uuid references public.profiles(id),
  handled_at      timestamptz,
  resolution_note text,
  created_at      timestamptz not null default now(),
  constraint reports_detail_len check (char_length(detail) <= 500)
);

-- 同一人对同一对象只能举报一次（重复提交会得到 23505，前端提示「已经举报过了」）
create unique index if not exists reports_unique_idx
  on public.reports (reporter_id, target_type, target_id);

create index if not exists reports_status_idx
  on public.reports (status, created_at desc);

-- ---------------------------------------------------------------------------
-- 2.11 app_config：运行参数（jsonb）
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  key         text primary key,
  value       jsonb not null,
  description text not null default '',
  updated_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 2.12 comment_likes：评论点赞明细（前端禁止直写，只走 toggle_comment_like RPC）
-- ---------------------------------------------------------------------------
create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create index if not exists comment_likes_user_idx on public.comment_likes (user_id);


-- ---------------------------------------------------------------------------
-- 2.13 banned_words：违禁词库（前端完全不可直读，管理只走 admin_* RPC）
--   匹配规则见 5.15 find_banned_word：忽略大小写、忽略空白，包含即命中。
-- ---------------------------------------------------------------------------
create table if not exists public.banned_words (
  id         uuid primary key default gen_random_uuid(),
  word       text not null unique,
  note       text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint banned_words_word_len check (char_length(btrim(word)) between 1 and 32)
);

create index if not exists banned_words_word_idx on public.banned_words (word);


-- ---------------------------------------------------------------------------
-- 2.14 feedback：意见反馈（前端完全不可直读写，只能走 submit_feedback /
--   my_feedback / admin_feedback；联系方式等隐私字段不外泄）
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  category   text not null default '建议',
  content    text not null,
  contact    text,
  status     text not null default 'pending',
  handled_by uuid references public.profiles(id),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint feedback_content_len  check (char_length(content) between 5 and 1000),
  constraint feedback_category_len check (char_length(category) between 1 and 10),
  constraint feedback_contact_len  check (contact is null or char_length(contact) <= 100),
  constraint feedback_status_chk   check (status in ('pending', 'resolved'))
);

create index if not exists feedback_status_idx on public.feedback (status, created_at desc);
create index if not exists feedback_user_idx   on public.feedback (user_id, created_at desc);



-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 2.15 friendships：好友关系（单向存储；删好友只删自己那条 → 对端变 half）
-- ---------------------------------------------------------------------------
-- 1) 数据表
-- ---------------------------------------------------------------------------

-- 好友关系（单向存储，对齐微信语义：删好友只删自己那条）
create table if not exists public.friendships (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  friend_id uuid not null references public.profiles(id) on delete cascade,
  status    text not null default 'friend',
  since     timestamptz not null default now(),
  primary key (user_id, friend_id),
  constraint friendships_status_chk check (status in ('friend', 'blocked')),
  constraint no_self_friend check (user_id <> friend_id)
);

create index if not exists friendships_friend_idx on public.friendships (friend_id);

-- 好友申请
create table if not exists public.friend_requests (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  to_id      uuid not null references public.profiles(id) on delete cascade,
  message    text not null default '',
  status     text not null default 'pending',
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  constraint friend_requests_status_chk check (status in ('pending', 'accepted', 'rejected')),
  constraint no_self_request check (from_id <> to_id),
  constraint request_message_len check (char_length(message) <= 100)
);

-- 同一对用户同时只允许一条 pending（重复点「加好友」会覆盖留言而不是插一堆）
create unique index if not exists friend_requests_pending_idx
  on public.friend_requests (from_id, to_id) where status = 'pending';

create index if not exists friend_requests_to_idx
  on public.friend_requests (to_id, status, created_at desc);

-- 私信会话（user_a < user_b，永远只有一条，不会出现 (A,B) 与 (B,A) 两行）
create table if not exists public.conversations (
  id       uuid primary key default gen_random_uuid(),
  user_a   uuid not null references public.profiles(id) on delete cascade,
  user_b   uuid not null references public.profiles(id) on delete cascade,
  last_seq int not null default 0,
  last_at  timestamptz not null default now(),
  constraint ordered_pair check (user_a < user_b),
  constraint conversations_pair_uniq unique (user_a, user_b)
);

create index if not exists conversations_user_a_idx on public.conversations (user_a, last_at desc);
create index if not exists conversations_user_b_idx on public.conversations (user_b, last_at desc);

-- 私信消息（seq 在会话内自增，前端按 seq 增量拉取）
create table if not exists public.direct_messages (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  seq             int not null,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  content         text not null,
  is_read         boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, seq),
  constraint dm_content_len check (char_length(content) between 1 and 2000)
);

create index if not exists direct_messages_unread_idx
  on public.direct_messages (conversation_id, is_read, sender_id);


-- ============================================================================
-- 3. 基础判断函数 + 管理员视图
--   security definer 只换「执行身份」，不换 JWT：函数里的 auth.uid() 仍是调用者
--   （设计方案「教训 1」）。这里用 definer 的目的：避免 RLS 策略递归。
-- ============================================================================

-- 读整型配置（app_config.value 是 jsonb，用 #>> '{}' 取出文本再转 int）
create or replace function public.cfg_int(p_key text, p_default int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select (c.value #>> '{}')::int from public.app_config c where c.key = p_key),
    p_default
  );
$$;

-- 内容管理权限：admin + moderator（且账号可用）
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'moderator')
      and p.is_active = true
      and (p.banned_until is null or p.banned_until < now())
  );
$$;

-- 严格管理员：改角色、封禁（设计方案 5.10 / 12.13）
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.is_active = true
      and (p.banned_until is null or p.banned_until < now())
  );
$$;

-- 账号是否可发言：
--   - 正常账号：is_active = true 且没有生效中的封禁
--   - 临时封禁：is_active = false + banned_until 为未来时间 → 到期自动恢复
--   - 永久封禁：is_active = false + banned_until 为 NULL → 不自动恢复
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        (p.is_active = true and p.banned_until is null)
        or (p.banned_until is not null and p.banned_until < now())
      )
  );
$$;

-- 帖子是否对当前请求者可见（避免策略里跨表递归）
create or replace function public.can_read_post(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and (not p.is_deleted or p.author_id = auth.uid() or public.is_admin())
  );
$$;

-- 用户名可用性：注册前 anon 也能查（只返回布尔值，不泄露资料）
-- 注意不能写成 coalesce(released_at, now())，否则 is_current=false 且 released_at 为 NULL
-- 的脏行会把用户名永久占住（设计方案 10.6）。
create or replace function public.username_available(p_username text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with v as (
    select lower(btrim(coalesce(p_username, ''))) as name
  )
  select v.name ~ '^[a-z0-9_]{3,20}$'
     and not exists (
       select 1
       from public.user_handles h
       where h.username = v.name
         and (
           h.is_current
           or (
             not h.is_current
             and h.released_at is not null
             and h.released_at > now() - interval '90 days'
           )
         )
     )
  from v;
$$;

-- ---------------------------------------------------------------------------
-- 3.1 admin_profiles：管理员用户列表视图（仅 admin，不含 moderator）
--   列级 GRANT 让普通用户读不到 role / is_active / banned_*，管理员又需要看，
--   所以在视图里用「视图属主权限 + where is_super_admin()」实现按行授权：
--     - admin      → 看到全部用户（含 username / role / 封禁信息 / 计数）
--     - 其他任何人 → 空集（不报错，便于前端统一处理）
--   非管理员即便直接 GET /rest/v1/admin_profiles 也只是 []，不会泄露管理字段。
--   说明：这是「security definer 视图」（PG 15 起默认仍以属主身份执行）。
--   Studio 的安全告警可能会提示，这是有意为之——权限收敛完全靠
--   where public.is_super_admin() 这个行过滤，且只 grant select 给 authenticated。
-- ---------------------------------------------------------------------------
create or replace view public.admin_profiles as
select
  p.id,
  p.display_name,
  p.avatar,
  p.bio,
  p.role,
  p.is_active,
  p.banned_reason,
  p.banned_until,
  p.created_at,
  p.updated_at,
  h.username,
  (select count(*) from public.posts po
     where po.author_id = p.id and not po.is_deleted) as post_count,
  (select count(*) from public.comments c
     where c.author_id = p.id and not c.is_deleted) as comment_count,
  (select count(*) from public.follows f
     where f.target_id = p.id) as follower_count
from public.profiles p
left join public.user_handles h
  on h.user_id = p.id and h.is_current
where public.is_super_admin();


-- ============================================================================
-- 4. 触发器函数
-- ============================================================================

-- updated_at 自动维护
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 新用户自动建资料 + 用户名句柄
--   - display_name 取 metadata.display_name（前端 signUp 时 options.data 传）
--   - username：metadata.username 合法且未被占用则用；否则生成 u_ + 8 位十六进制
--   - display_name 清洗成 2–20 字符，避免 CHECK 让注册整体失败
--     （GoTrue 会把触发器异常统一包装成 "Database error saving new user"，很难排错）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_display  text;
  v_try      int := 0;
begin
  -- ① 取前端传入的 username（统一小写，避免 Alice / alice 撞唯一索引）
  v_username := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));

  -- ② 格式不合法或已被占用 → 生成 u_ + 8 位十六进制（满足 ^[a-z0-9_]{3,20}$）
  if v_username !~ '^[a-z0-9_]{3,20}$'
     or exists (
       select 1 from public.user_handles h
       where h.username = v_username and h.is_current
     )
  then
    v_username := 'u_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
    while exists (
      select 1 from public.user_handles h
      where h.username = v_username and h.is_current
    ) loop
      v_try := v_try + 1;
      v_username := 'u_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
      exit when v_try > 20;
    end loop;
  end if;

  -- ③ display_name：metadata → username → 默认「新同学」，并清洗到 2–20 字符
  v_display := coalesce(
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), ''),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')), ''),
    '新同学'
  );
  v_display := left(v_display, 20);
  if char_length(v_display) < 2 then
    v_display := '新同学';
  end if;

  -- ④ 写论坛资料与用户名句柄（同一事务，任一失败则注册整体回滚）
  insert into public.profiles (id, display_name)
  values (new.id, v_display)
  on conflict (id) do nothing;

  insert into public.user_handles (user_id, username, is_current)
  values (new.id, v_username, true)
  on conflict do nothing;

  return new;
end;
$$;

-- 发帖前处理：先填作者（防伪造），再查封禁 / 板块 / 限额。
-- 注意：必须合并成一个触发器。若拆成两个同事件 BEFORE 触发器，PostgreSQL 按
-- 触发器名首字母排序执行，限额检查会先于作者填充执行，author_id 还是 NULL，
-- 所有限额检查会「静默通过」（设计方案 12.3 的坑）。
create or replace function public.prepare_post_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created  timestamptz;
  v_post_cnt int;
  v_cool     int := public.cfg_int('post_cooldown_minutes', 10);
  v_daily    int := public.cfg_int('post_daily_limit', 5);
  v_max_img  int := public.cfg_int('max_images_per_post', 9);
  v_bad_img  text;
begin
  -- ① 作者一律取当前登录用户，客户端传什么都不算数
  new.author_id := auth.uid();
  if new.author_id is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception '账号已被封禁，无法发帖' using errcode = '42501';
  end if;

  -- ② 图片数量上限
  if coalesce(array_length(new.images, 1), 0) > v_max_img then
    raise exception '单帖最多 % 张图片', v_max_img using errcode = 'P0001';
  end if;

  -- ②' 图片地址必须是 http/https 直链
  --     防止 javascript: / data: / vbscript: 之类的伪协议被详情页渲染成可点击链接执行脚本
  if new.images is not null then
    select u into v_bad_img
    from unnest(new.images) as u
    where u !~* '^https?://' or u ~ '[[:space:]]'
    limit 1;

    if v_bad_img is not null then
      raise exception '图片地址不合法（只允许 http/https 链接）'
        using errcode = '22023';
    end if;
  end if;

  -- ③ 板块必须存在且未关闭发帖
  if not exists (select 1 from public.boards b where b.slug = new.board_slug) then
    raise exception '板块不存在' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.boards b where b.slug = new.board_slug and b.is_locked) then
    raise exception '该板块已关闭发帖' using errcode = '42501';
  end if;

  -- ④ 注册冷却（此时 author_id 一定已就绪）
  select p.created_at into v_created
  from public.profiles p where p.id = new.author_id;

  if v_created is not null
     and v_cool > 0
     and v_created > now() - make_interval(mins => v_cool) then
    raise exception '注册满 % 分钟后才能发帖', v_cool using errcode = 'P0001';
  end if;

  -- ⑤ 24 小时发帖上限
  select count(*) into v_post_cnt
  from public.posts
  where author_id = new.author_id
    and created_at > now() - interval '24 hours';

  if v_daily > 0 and v_post_cnt >= v_daily then
    raise exception '24 小时内最多发 % 条帖子', v_daily using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- 评论前处理：同样「先填作者，再校验」
create or replace function public.prepare_comment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created timestamptz;
  v_cnt     int;
  v_cool    int := public.cfg_int('comment_cooldown_minutes', 0);
  v_daily   int := public.cfg_int('comment_daily_limit', 20);
begin
  new.author_id := auth.uid();
  if new.author_id is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception '账号已被封禁，无法评论' using errcode = '42501';
  end if;

  -- 帖子必须存在、未删除、未锁定
  if not exists (
    select 1 from public.posts p
    where p.id = new.post_id
      and not p.is_deleted
      and not p.is_locked
  ) then
    raise exception '帖子不存在、已删除或已被锁定，无法评论' using errcode = '42501';
  end if;

  -- parent_id 属于二期楼中楼；若传了，必须属于同一帖子
  if new.parent_id is not null then
    if not exists (
      select 1 from public.comments c
      where c.id = new.parent_id
        and c.post_id = new.post_id
        and not c.is_deleted
    ) then
      raise exception '回复的评论不存在' using errcode = 'P0002';
    end if;
  end if;

  -- 注册冷却
  select p.created_at into v_created
  from public.profiles p where p.id = new.author_id;

  if v_created is not null
     and v_cool > 0
     and v_created > now() - make_interval(mins => v_cool) then
    raise exception '注册满 % 分钟后才能评论', v_cool using errcode = 'P0001';
  end if;

  -- 24 小时评论上限
  select count(*) into v_cnt
  from public.comments
  where author_id = new.author_id
    and created_at > now() - interval '24 hours';

  if v_daily > 0 and v_cnt >= v_daily then
    raise exception '24 小时内最多发 % 条评论', v_daily using errcode = 'P0001';
  end if;

  return new;
end;
$$;

-- 评论计数（帖子 comment_count 只由本触发器维护；列级权限不允许前端改计数）
create or replace function public.sync_comment_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and not new.is_deleted then
    update public.posts
       set comment_count = comment_count + 1
     where id = new.post_id;
  elsif tg_op = 'UPDATE' and new.is_deleted and not old.is_deleted then
    update public.posts
       set comment_count = greatest(comment_count - 1, 0)
     where id = new.post_id;
  end if;
  return null;
end;
$$;

-- 评论通知：
--   · 普通评论 → 通知帖子作者（自己评论自己不通知）
--   · 回复评论 → 通知被回复的人（type = 'reply'）；帖子作者若不是回复者/被回复者，也收到一条 comment 通知
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

    -- ② 帖子作者也要收到“有人评论了你的帖子”（如果与回复者/被回复者都不同）
    if v_post_author is not null
       and v_post_author <> new.author_id
       and v_post_author <> coalesce(v_parent_author, '00000000-0000-0000-0000-000000000000'::uuid) then
      insert into public.notifications (user_id, type, post_id, comment_id, actor_id)
      values (v_post_author, 'comment', new.post_id, new.id, new.author_id);
    end if;

    return null;
  end if;

  -- ③ 普通评论
  if v_post_author is null or v_post_author = new.author_id then
    return null;
  end if;

  insert into public.notifications (user_id, type, post_id, comment_id, actor_id)
  values (v_post_author, 'comment', new.post_id, new.id, new.author_id);

  return null;
end;
$$;

-- 关注者新帖通知：作者发帖 → 每个粉丝一条 follow_post 通知
create or replace function public.notify_followers_on_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, type, post_id, actor_id)
  select f.follower_id, 'follow_post', new.id, new.author_id
  from public.follows f
  where f.target_id = new.author_id;

  return null;
end;
$$;


-- ============================================================================
-- 5. RPC 函数（全部 security definer + set search_path，函数内再校验一次权限）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 5.1 vote_post：点赞 / 踩（原子操作，前端只能通过它改计数）
--   p_value = 1 赞，-1 踩，0 取消；
--   与当前投票相同的值再点一次也视为取消（满足「重复点赞只算一次」）。
--   返回 { like_count, dislike_count, my_vote }，my_vote 为取消后的 null。
-- ---------------------------------------------------------------------------
create or replace function public.vote_post(p_post_id uuid, p_value smallint)
returns table (like_count int, dislike_count int, my_vote smallint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old     smallint;
  v_like    int;
  v_dislike int;
  v_final   smallint;
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception '账号当前无法操作' using errcode = '42501';
  end if;
  if p_value is null or p_value not in (-1, 0, 1) then
    raise exception '非法投票' using errcode = '22023';
  end if;
  if p_post_id is null or not exists (
    select 1 from public.posts where id = p_post_id and not is_deleted
  ) then
    raise exception '帖子不存在或已删除' using errcode = 'P0002';
  end if;

  select v.value into v_old
  from public.post_votes v
  where v.post_id = p_post_id and v.user_id = auth.uid();

  if v_old is null then
    if p_value = 0 then
      v_final := null;
    else
      insert into public.post_votes (post_id, user_id, value)
      values (p_post_id, auth.uid(), p_value);

      -- OUT 参数名叫 like_count / dislike_count，与表字段同名，
      -- 必须用 p. 限定，否则 "column reference is ambiguous"（设计方案 12.4）
      update public.posts as p
         set like_count    = p.like_count    + (case when p_value =  1 then 1 else 0 end),
             dislike_count = p.dislike_count + (case when p_value = -1 then 1 else 0 end)
       where p.id = p_post_id
       returning p.like_count, p.dislike_count into v_like, v_dislike;

      v_final := p_value;
    end if;
  elsif p_value = 0 or v_old = p_value then
    delete from public.post_votes v
    where v.post_id = p_post_id and v.user_id = auth.uid();

    update public.posts as p
       set like_count    = greatest(p.like_count    - (case when v_old =  1 then 1 else 0 end), 0),
           dislike_count = greatest(p.dislike_count - (case when v_old = -1 then 1 else 0 end), 0)
     where p.id = p_post_id
     returning p.like_count, p.dislike_count into v_like, v_dislike;

    v_final := null;
  else
    update public.post_votes v
       set value = p_value
     where v.post_id = p_post_id and v.user_id = auth.uid();

    update public.posts as p
       set like_count    = greatest(p.like_count    + (case when p_value =  1 then 1 else -1 end), 0),
           dislike_count = greatest(p.dislike_count + (case when p_value = -1 then 1 else -1 end), 0)
     where p.id = p_post_id
     returning p.like_count, p.dislike_count into v_like, v_dislike;

    v_final := p_value;
  end if;

  -- p_value = 0 且原本没有投票时只回填计数
  if v_like is null then
    select p.like_count, p.dislike_count into v_like, v_dislike
    from public.posts p
    where p.id = p_post_id;
  end if;

  return query select v_like, v_dislike, v_final;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.2 toggle_favorite：收藏 / 取消收藏
-- ---------------------------------------------------------------------------
create or replace function public.toggle_favorite(p_post_id uuid)
returns table (favorited boolean, favorite_count int)
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
  if p_post_id is null or not exists (
    select 1 from public.posts where id = p_post_id and not is_deleted
  ) then
    raise exception '帖子不存在或已删除' using errcode = 'P0002';
  end if;

  select exists (
    select 1 from public.favorites f
    where f.user_id = auth.uid() and f.post_id = p_post_id
  ) into v_exists;

  if v_exists then
    delete from public.favorites f
    where f.user_id = auth.uid() and f.post_id = p_post_id;

    -- OUT 参数 favorite_count 与列同名，必须 p. 限定
    update public.posts as p
       set favorite_count = greatest(p.favorite_count - 1, 0)
     where p.id = p_post_id
     returning p.favorite_count into v_count;
  else
    insert into public.favorites (user_id, post_id)
    values (auth.uid(), p_post_id);

    update public.posts as p
       set favorite_count = p.favorite_count + 1
     where p.id = p_post_id
     returning p.favorite_count into v_count;
  end if;

  return query select not v_exists, v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.3 toggle_follow：关注 / 取消关注（按 user id，不经过 username）
-- ---------------------------------------------------------------------------
create or replace function public.toggle_follow(p_target_id uuid)
returns table (following boolean, follower_count int)
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
  if p_target_id is null then
    raise exception '用户不存在' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_target_id) then
    raise exception '用户不存在' using errcode = 'P0002';
  end if;
  if p_target_id = auth.uid() then
    raise exception '不能关注自己' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.follows f
    where f.follower_id = auth.uid() and f.target_id = p_target_id
  ) into v_exists;

  if v_exists then
    delete from public.follows f
    where f.follower_id = auth.uid() and f.target_id = p_target_id;
  else
    insert into public.follows (follower_id, target_id)
    values (auth.uid(), p_target_id);
  end if;

  select count(*) into v_count
  from public.follows f
  where f.target_id = p_target_id;

  return query select not v_exists, v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.4 soft_delete_post：软删除帖子（作者 / 管理员）
-- ---------------------------------------------------------------------------
create or replace function public.soft_delete_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if p_post_id is null or not exists (
    select 1 from public.posts p
    where p.id = p_post_id
      and (p.author_id = auth.uid() or public.is_admin())
  ) then
    raise exception '无权删除该帖子' using errcode = '42501';
  end if;

  -- 软删除：只置标记，物理行保留（计数、关联记录都不受影响）
  update public.posts
     set is_deleted = true
   where id = p_post_id and not is_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.5 soft_delete_comment：软删除评论（作者 / 管理员）
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5.6 通知：全部已读 / 单条已读
--   单条已读也可以前端直接 update notifications set is_read = true（列级权限
--   update(is_read) + RLS 本人行策略已就绪），这里再给一个 RPC 兜底。
-- ---------------------------------------------------------------------------
create or replace function public.mark_all_notifications_read()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;

  update public.notifications
     set is_read = true
   where user_id = auth.uid() and not is_read;
end;
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;

  update public.notifications
     set is_read = true
   where id = p_notification_id and user_id = auth.uid();

  if not found then
    raise exception '通知不存在或无权操作' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.7 search_posts：搜索（默认 security invoker，让 RLS 生效）
--   - p_query 为空 → 返回空集
--   - 用 ilike 且转义 % _ \（用户搜 "100%" 不会被当通配符）
--   - p_sort = 'hot' 按 like_count desc，否则按 created_at desc；置顶始终优先
--   - p_since / p_until 为可选时间范围（null = 不限）
--   - 返回作者昵称 / 头像，前端不用二次查询
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5.8 posts_by_author：作者主页帖子（security invoker，RLS 生效）
-- ---------------------------------------------------------------------------
create or replace function public.posts_by_author(
  p_user_id uuid,
  p_limit   int default 20,
  p_offset  int default 0
)
returns setof public.posts
language sql
stable
set search_path = public
as $$
  select *
  from public.posts
  where author_id = p_user_id
    and not is_deleted
  order by is_pinned desc, created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ---------------------------------------------------------------------------
-- 5.9 author_profile：作者公开资料（绝不返回 role / is_active / banned_*）
-- ---------------------------------------------------------------------------
create or replace function public.author_profile(p_user_id uuid)
returns table (
  user_id         uuid,
  display_name    text,
  avatar          text,
  bio             text,
  created_at      timestamptz,
  post_count      bigint,
  follower_count  bigint,
  following_count bigint,
  is_following    boolean,
  is_me           boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.display_name,
    p.avatar,
    p.bio,
    p.created_at,
    (select count(*) from public.posts po
       where po.author_id = p.id and not po.is_deleted),
    (select count(*) from public.follows f
       where f.target_id = p.id),
    (select count(*) from public.follows f
       where f.follower_id = p.id),
    exists (
      select 1 from public.follows f2
      where f2.follower_id = auth.uid() and f2.target_id = p.id
    ),
    coalesce(p.id = auth.uid(), false)
  from public.profiles p
  where p.id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- 5.10 my_following / my_followers：我的关注 / 我的粉丝
-- ---------------------------------------------------------------------------
create or replace function public.my_following(p_limit int default 20, p_offset int default 0)
returns table (
  user_id     uuid,
  display_name text,
  avatar      text,
  bio         text,
  followed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;

  return query
  select p.id, p.display_name, p.avatar, p.bio, f.created_at
  from public.follows f
  join public.profiles p on p.id = f.target_id
  where f.follower_id = auth.uid()
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

create or replace function public.my_followers(p_limit int default 20, p_offset int default 0)
returns table (
  user_id     uuid,
  display_name text,
  avatar      text,
  bio         text,
  followed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;

  return query
  select p.id, p.display_name, p.avatar, p.bio, f.created_at
  from public.follows f
  join public.profiles p on p.id = f.follower_id
  where f.target_id = auth.uid()
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.11 my_profile：当前用户的完整资料（含 role / 封禁信息 / 用户名句柄）
--   只有本人能拿到这些字段；别人的只能通过 author_profile 看公开字段。
-- ---------------------------------------------------------------------------
create or replace function public.my_profile()
returns table (
  id            uuid,
  display_name  text,
  avatar        text,
  bio           text,
  role          public.user_role,
  is_active     boolean,
  banned_reason text,
  banned_until  timestamptz,
  created_at    timestamptz,
  updated_at    timestamptz,
  username      text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.display_name,
    p.avatar,
    p.bio,
    p.role,
    p.is_active,
    p.banned_reason,
    p.banned_until,
    p.created_at,
    p.updated_at,
    (
      select h.username
      from public.user_handles h
      where h.user_id = p.id and h.is_current
      order by h.created_at desc
      limit 1
    )
  from public.profiles p
  where p.id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 5.12 管理员 RPC
--   权限分层：
--     - 内容管理（置顶 / 锁帖 / 删帖删评 / 处理举报）：admin + moderator
--     - 账号管理（封禁 / 改角色）：仅 admin（设计方案 5.10、12.13；M5 验收）
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_role(p_user_id uuid, p_role public.user_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception '不能修改自己的角色' using errcode = '22023';
  end if;
  if p_user_id is null or not exists (
    select 1 from public.profiles p where p.id = p_user_id
  ) then
    raise exception '用户不存在' using errcode = 'P0002';
  end if;

  update public.profiles set role = p_role where id = p_user_id;
end;
$$;

create or replace function public.admin_set_active(
  p_user_id uuid,
  p_active  boolean,
  p_reason  text default null,
  p_until   timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception '不能操作自己的账号状态' using errcode = '22023';
  end if;
  if p_user_id is null or not exists (
    select 1 from public.profiles p where p.id = p_user_id
  ) then
    raise exception '用户不存在' using errcode = 'P0002';
  end if;

  if p_active then
    -- 解封：清空封禁标记
    update public.profiles
       set is_active     = true,
           banned_reason = null,
           banned_until  = null
     where id = p_user_id;
  else
    -- 封禁：必须填原因
    if btrim(coalesce(p_reason, '')) = '' then
      raise exception '封禁必须填写原因' using errcode = '22023';
    end if;
    if p_until is not null and p_until <= now() then
      raise exception '封禁到期时间必须晚于当前时间' using errcode = '22023';
    end if;

    -- p_until 为 NULL → 永久封禁；否则为临时封禁，到期后 is_active_user() 自动放行
    update public.profiles
       set is_active     = false,
           banned_reason = btrim(p_reason),
           banned_until  = p_until
     where id = p_user_id;
  end if;
end;
$$;

create or replace function public.admin_set_pinned(p_post_id uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if p_post_id is null or not exists (
    select 1 from public.posts p where p.id = p_post_id
  ) then
    raise exception '帖子不存在' using errcode = 'P0002';
  end if;

  update public.posts set is_pinned = p_pinned where id = p_post_id;
end;
$$;

create or replace function public.admin_lock_post(p_post_id uuid, p_locked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if p_post_id is null or not exists (
    select 1 from public.posts p where p.id = p_post_id
  ) then
    raise exception '帖子不存在' using errcode = 'P0002';
  end if;

  update public.posts set is_locked = p_locked where id = p_post_id;
end;
$$;

create or replace function public.admin_soft_delete_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if p_post_id is null or not exists (
    select 1 from public.posts p where p.id = p_post_id
  ) then
    raise exception '帖子不存在' using errcode = 'P0002';
  end if;

  update public.posts
     set is_deleted = true
   where id = p_post_id and not is_deleted;
end;
$$;

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

  -- 管理员删评论时同样连带删除其下的一层回复
  update public.comments
     set is_deleted = true
   where parent_id = p_comment_id and not is_deleted;

  update public.comments
     set is_deleted = true
   where id = p_comment_id and not is_deleted;
end;
$$;

create or replace function public.admin_resolve_report(
  p_report_id uuid,
  p_status    public.report_status,
  p_note      text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('resolved', 'rejected') then
    raise exception '举报处理状态只能是 resolved 或 rejected' using errcode = '22023';
  end if;
  if p_report_id is null or not exists (
    select 1 from public.reports r where r.id = p_report_id
  ) then
    raise exception '举报不存在' using errcode = 'P0002';
  end if;

  update public.reports
     set status          = p_status,
         handled_by      = auth.uid(),
         handled_at      = now(),
         resolution_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_report_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.13 recount_posts：一键对齐计数（维护用，仅 admin；正常情况用不到）
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

-- ---------------------------------------------------------------------------
-- 5.24b 明细行被删（含级联删除）时反向扣减计数
--   账号注销 / 管理员删号会级联删掉 post_votes / comment_likes / favorites，
--   没有这些触发器的话计数会永久偏高。
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


-- ---------------------------------------------------------------------------
-- 5.14 toggle_comment_like：给评论点赞 / 取消点赞（原子操作）
--   点一次赞，再点一次取消；重复点赞只算一次。
--   返回 { like_count, liked }，liked 表示当前是否已赞。
-- ---------------------------------------------------------------------------
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


-- ---------------------------------------------------------------------------
-- 5.14b invisible_chars：不可见字符表（零宽空格 / 零宽连接符 / 词连接符 / 软连字符 / BOM / 全角空格）
--   匹配违禁词前先剔除，否则「代开<ZWSP>发票」这类写法能绕过词库。
create or replace function public.invisible_chars()
returns text
language sql
immutable
as $$
  select chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207)
      || chr(8288) || chr(173) || chr(65279) || chr(12288);
$$;

-- ----------------------------------------------------------------------------- 5.15 find_banned_word / assert_no_banned_word：违禁词匹配（内部函数）
--   规则：先剔除不可见字符，再统一小写、去掉所有空白（含全角空格），包含即命中；长词优先返回。
-- ---------------------------------------------------------------------------

create or replace function public.find_banned_word(p_text text)
returns text
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_norm text;
  v_hit  text;
begin
  if p_text is null or char_length(p_text) = 0 then
    return null;
  end if;
  -- 先剔除零宽 / 软连字符等不可见字符（否则「代开<ZWSP>发票」能绕过），再统一小写、去掉空白
  v_norm := regexp_replace(
              translate(lower(p_text), public.invisible_chars(), ''),
              '[\s　]+', '', 'g');

  select w.word into v_hit
  from public.banned_words w
  where strpos(
          v_norm,
          regexp_replace(translate(lower(w.word), public.invisible_chars(), ''), '[\s　]+', '', 'g')
        ) > 0
  order by char_length(w.word) desc, w.word
  limit 1;

  return v_hit;
end;
$$;

create or replace function public.assert_no_banned_word(p_text text, p_label text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hit text;
begin
  v_hit := public.find_banned_word(p_text);
  if v_hit is not null then
    raise exception '%包含违禁词「%」，请修改后再提交', coalesce(p_label, '内容'), v_hit
      using errcode = '22000';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.16 check_banned_word：公开预校验（匿名可调，注册昵称前置检查用）
--   只返回命中的词，不暴露整个词库。
-- ---------------------------------------------------------------------------
create or replace function public.check_banned_word(p_text text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select public.find_banned_word(p_text);
$$;

-- ---------------------------------------------------------------------------
-- 5.17 违禁词触发器函数：发帖 / 评论 / 昵称 / 用户名
-- ---------------------------------------------------------------------------
create or replace function public.check_post_words()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform public.assert_no_banned_word(new.title, '标题');
    perform public.assert_no_banned_word(new.content, '正文');
  else
    if new.title is distinct from old.title then
      perform public.assert_no_banned_word(new.title, '标题');
    end if;
    if new.content is distinct from old.content then
      perform public.assert_no_banned_word(new.content, '正文');
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.check_comment_words()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.content is distinct from old.content then
    perform public.assert_no_banned_word(new.content, '评论内容');
  end if;
  return new;
end;
$$;

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
  -- 简介同样对外可见，也要过词库（原来漏了，可以拿 bio 发广告）
  if tg_op = 'INSERT' or new.bio is distinct from old.bio then
    perform public.assert_no_banned_word(new.bio, '简介');
  end if;
  return new;
end;
$$;

create or replace function public.check_handle_words()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.username is distinct from old.username then
    perform public.assert_no_banned_word(new.username, '用户名');
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.18 违禁词管理 RPC（仅超级管理员 role = admin）
-- ---------------------------------------------------------------------------
create or replace function public.admin_banned_words()
returns table (id uuid, word text, note text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;

  return query
    select w.id, w.word, w.note, w.created_at
    from public.banned_words w
    order by w.created_at desc, w.word;
end;
$$;

create or replace function public.admin_add_banned_word(p_word text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_word text := lower(btrim(coalesce(p_word, '')));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_super_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if char_length(regexp_replace(v_word, '[\s　]+', '', 'g')) < 1 then
    raise exception '违禁词不能为空' using errcode = 'P0001';
  end if;
  if char_length(v_word) > 32 then
    raise exception '违禁词不能超过 32 个字符' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.banned_words w where w.word = v_word) then
    raise exception '「%」已经在违禁词库里了', v_word using errcode = 'P0001';
  end if;

  insert into public.banned_words (word, note, created_by)
  values (v_word, v_note, auth.uid());
end;
$$;

create or replace function public.admin_delete_banned_word(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if not exists (select 1 from public.banned_words w where w.id = p_id) then
    raise exception '违禁词不存在' using errcode = 'P0002';
  end if;

  delete from public.banned_words w where w.id = p_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5.19 check_feedback_words：反馈内容的违禁词触发函数
-- ---------------------------------------------------------------------------
create or replace function public.check_feedback_words()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.content is distinct from old.content then
    perform public.assert_no_banned_word(new.content, '反馈内容');
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.20 submit_feedback：提交反馈（登录用户；被限制的账号不能提交）
-- ---------------------------------------------------------------------------
create or replace function public.submit_feedback(
  p_content  text,
  p_category text default '建议',
  p_contact  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_content  text := btrim(coalesce(p_content, ''));
  v_category text := btrim(coalesce(nullif(btrim(coalesce(p_category, '')), ''), '建议'));
  v_contact  text := nullif(btrim(coalesce(p_contact, '')), '');
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception '账号当前无法操作' using errcode = '42501';
  end if;
  if char_length(v_content) < 5 then
    raise exception '反馈内容太短了，至少写 5 个字' using errcode = 'P0001';
  end if;
  if char_length(v_content) > 1000 then
    raise exception '反馈内容不能超过 1000 字' using errcode = 'P0001';
  end if;
  if char_length(v_category) > 10 then
    raise exception '反馈类型太长' using errcode = 'P0001';
  end if;
  if v_contact is not null and char_length(v_contact) > 100 then
    raise exception '联系方式不能超过 100 个字符' using errcode = 'P0001';
  end if;

  insert into public.feedback (user_id, category, content, contact)
  values (auth.uid(), v_category, v_content, v_contact);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.21 my_feedback：我的反馈（只能看到自己的）
-- ---------------------------------------------------------------------------
create or replace function public.my_feedback()
returns table (
  id         uuid,
  category   text,
  content    text,
  contact    text,
  status     text,
  created_at timestamptz,
  handled_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;

  return query
    select f.id, f.category, f.content, f.contact, f.status, f.created_at, f.handled_at
    from public.feedback f
    where f.user_id = auth.uid()
    order by f.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.22 admin_feedback：管理端查看全部反馈（可按状态筛），仅 admin
-- ---------------------------------------------------------------------------
create or replace function public.admin_feedback(p_status text default null)
returns table (
  id           uuid,
  user_id      uuid,
  display_name text,
  category     text,
  content      text,
  contact      text,
  status       text,
  created_at   timestamptz,
  handled_at   timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := nullif(btrim(coalesce(p_status, '')), '');
begin
  if not public.is_super_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if v_status is not null and v_status not in ('pending', 'resolved') then
    raise exception '状态只能是 pending 或 resolved' using errcode = 'P0001';
  end if;

  return query
    select f.id,
           f.user_id,
           coalesce(p.display_name, '已注销用户'),
           f.category,
           f.content,
           f.contact,
           f.status,
           f.created_at,
           f.handled_at
    from public.feedback f
    left join public.profiles p on p.id = f.user_id
    where v_status is null or f.status = v_status
    order by (f.status = 'pending') desc, f.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5.23 admin_resolve_feedback：标记已处理 / 重新打开，仅 admin
-- ---------------------------------------------------------------------------
create or replace function public.admin_resolve_feedback(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := btrim(coalesce(p_status, ''));
begin
  if not public.is_super_admin() then
    raise exception '需要管理员权限' using errcode = '42501';
  end if;
  if v_status not in ('pending', 'resolved') then
    raise exception '状态只能是 pending 或 resolved' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.feedback f where f.id = p_id) then
    raise exception '反馈不存在' using errcode = 'P0002';
  end if;

  update public.feedback f
     set status     = v_status,
         handled_by = case when v_status = 'resolved' then auth.uid() else null end,
         handled_at = case when v_status = 'resolved' then now() else null end
   where f.id = p_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- 5.24 validate_report_target：举报前校验目标存在且不是自己（reports 触发器调用）
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


-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 5.25 好友 / 私信（二期）
--   关系判定 + 搜人 + 申请 + 拉黑 + 私信；表本身前端无权限，全部走这些 RPC
-- ---------------------------------------------------------------------------
-- 2) pair_state：当前用户与目标用户的关系
--    friend 双向好友 / half 对方删了我 / blocked 我拉黑了他 / blockedBy 他拉黑了我 / none
--    注意：对外文案不要区分 blocked / blockedBy / half，避免泄露社交关系。
-- ---------------------------------------------------------------------------
create or replace function public.pair_state(p_a uuid, p_b uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with ab as (
    select f.status from public.friendships f
    where f.user_id = p_a and f.friend_id = p_b
  ),
  ba as (
    select f.status from public.friendships f
    where f.user_id = p_b and f.friend_id = p_a
  )
  select case
    when (select status from ab) = 'blocked'  then 'blocked'
    when (select status from ba) = 'blocked'  then 'blockedBy'
    when (select status from ab) = 'friend'
     and (select status from ba) = 'friend'   then 'friend'
    when (select status from ab) = 'friend'
      or (select status from ba) = 'friend'   then 'half'
    else 'none'
  end;
$$;

-- 3) 违禁词触发器（好友申请留言 / 私信正文）
-- ---------------------------------------------------------------------------
create or replace function public.check_friend_request_words()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_no_banned_word(new.message, '好友申请留言');
  return new;
end;
$$;

create or replace function public.check_dm_words()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_no_banned_word(new.content, '私信内容');
  return new;
end;
$$;

-- 4) 搜人：至少 2 个字才能搜（防逐字遍历全站用户）；不返回 username（登录凭据）
-- ---------------------------------------------------------------------------
create or replace function public.search_users(p_keyword text, p_limit int default 20)
returns table (
  user_id      uuid,
  display_name text,
  avatar       text,
  relation     text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id,
         p.display_name,
         p.avatar,
         case
           when p.id = auth.uid() then 'self'
           else public.pair_state(auth.uid(), p.id)
         end
  from public.profiles p
  where auth.uid() is not null
    and char_length(btrim(coalesce(p_keyword, ''))) >= 2
    and strpos(lower(p.display_name), lower(btrim(p_keyword))) > 0
  order by p.display_name
  limit least(greatest(coalesce(p_limit, 20), 1), 20);
$$;

-- ---------------------------------------------------------------------------
-- 5) 发好友申请
--    - 对方已经是好友 → 直接报错
--    - 对方也给我发过 pending 申请 → 视为互相同意，直接成为好友
--    - 被拉黑 / 我拉黑对方 → 统一报「当前无法添加对方为好友」（不泄露细节）
-- ---------------------------------------------------------------------------
create or replace function public.send_friend_request(p_to uuid, p_message text default '')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_message text := btrim(coalesce(p_message, ''));
  v_reverse uuid;
  v_state   text;
begin
  if v_me is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception '账号当前无法操作' using errcode = '42501';
  end if;
  if p_to is null or p_to = v_me then
    raise exception '不能加自己为好友' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_to) then
    raise exception '用户不存在' using errcode = 'P0002';
  end if;
  if char_length(v_message) > 100 then
    raise exception '留言不能超过 100 字' using errcode = 'P0001';
  end if;

  v_state := public.pair_state(v_me, p_to);
  if v_state = 'friend' then
    raise exception '你们已经是好友了' using errcode = 'P0001';
  end if;
  if v_state in ('blocked', 'blockedBy') then
    raise exception '当前无法添加对方为好友' using errcode = '42501';
  end if;

  -- 对方也在等我的回复 → 直接互相成为好友
  select r.id into v_reverse
  from public.friend_requests r
  where r.from_id = p_to and r.to_id = v_me and r.status = 'pending'
  limit 1;

  if v_reverse is not null then
    update public.friend_requests r
       set status = 'accepted', handled_at = now()
     where r.id = v_reverse;

    insert into public.friendships (user_id, friend_id) values (v_me, p_to)
      on conflict (user_id, friend_id) do update set status = 'friend';
    insert into public.friendships (user_id, friend_id) values (p_to, v_me)
      on conflict (user_id, friend_id) do update set status = 'friend';
    return;
  end if;

  insert into public.friend_requests (from_id, to_id, message)
  values (v_me, p_to, v_message)
  on conflict (from_id, to_id) where status = 'pending'
  do update set message = excluded.message, created_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) 处理好友申请（同意 / 拒绝）
-- ---------------------------------------------------------------------------
create or replace function public.respond_friend_request(p_request_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_req public.friend_requests%rowtype;
begin
  if v_me is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception '账号当前无法操作' using errcode = '42501';
  end if;

  select * into v_req from public.friend_requests r where r.id = p_request_id;
  if v_req.id is null then
    raise exception '申请不存在' using errcode = 'P0002';
  end if;
  if v_req.to_id <> v_me then
    raise exception '只能处理发给自己的申请' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception '这条申请已经处理过了' using errcode = 'P0001';
  end if;

  update public.friend_requests r
     set status = case when p_accept then 'accepted' else 'rejected' end,
         handled_at = now()
   where r.id = p_request_id;

  if p_accept then
    insert into public.friendships (user_id, friend_id) values (v_me, v_req.from_id)
      on conflict (user_id, friend_id) do update set status = 'friend';
    insert into public.friendships (user_id, friend_id) values (v_req.from_id, v_me)
      on conflict (user_id, friend_id) do update set status = 'friend';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) 我的好友申请（收到的 pending + 我发出的 pending）
-- ---------------------------------------------------------------------------
create or replace function public.my_friend_requests()
returns table (
  request_id   uuid,
  direction    text,
  peer_id      uuid,
  peer_name    text,
  peer_avatar  text,
  message      text,
  status       text,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id,
         case when r.to_id = auth.uid() then 'incoming' else 'outgoing' end,
         case when r.to_id = auth.uid() then r.from_id else r.to_id end,
         p.display_name,
         p.avatar,
         r.message,
         r.status,
         r.created_at
  from public.friend_requests r
  join public.profiles p
    on p.id = case when r.to_id = auth.uid() then r.from_id else r.to_id end
  where auth.uid() is not null
    and r.status = 'pending'
    and (r.to_id = auth.uid() or r.from_id = auth.uid())
  order by r.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 8) 我的好友列表（含「对方已把我删掉」的 half 状态）
-- ---------------------------------------------------------------------------
create or replace function public.my_friends()
returns table (
  friend_id    uuid,
  display_name text,
  avatar       text,
  bio          text,
  since        timestamptz,
  relation     text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.display_name, p.avatar, p.bio, f.since,
         public.pair_state(auth.uid(), p.id)
  from public.friendships f
  join public.profiles p on p.id = f.friend_id
  where auth.uid() is not null
    and f.user_id = auth.uid()
  order by f.since desc;
$$;

-- ---------------------------------------------------------------------------
-- 9) 删好友（只删自己那条 → 对方列表里还会留着，体现为 half）
-- ---------------------------------------------------------------------------
create or replace function public.remove_friend(p_friend_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  delete from public.friendships f
   where f.user_id = auth.uid() and f.friend_id = p_friend_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10) 拉黑 / 取消拉黑
-- ---------------------------------------------------------------------------
create or replace function public.set_friend_block(p_friend_id uuid, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if p_friend_id is null or p_friend_id = v_me then
    raise exception '不能对自己操作' using errcode = '22023';
  end if;

  if p_blocked then
    insert into public.friendships (user_id, friend_id, status)
    values (v_me, p_friend_id, 'blocked')
    on conflict (user_id, friend_id) do update set status = 'blocked';
  else
    -- 取消拉黑：拉黑行里没有保留「原本是好友」的信息，直接删掉，
    -- 需要重新加好友（避免把陌生人意外变成好友）
    delete from public.friendships f
     where f.user_id = v_me and f.friend_id = p_friend_id and f.status = 'blocked';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11) 发私信（只有双向好友能发）
-- ---------------------------------------------------------------------------
create or replace function public.send_dm(p_to uuid, p_content text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_content text := btrim(coalesce(p_content, ''));
  v_a       uuid;
  v_b       uuid;
  v_conv    uuid;
  v_seq     int;
begin
  if v_me is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not public.is_active_user() then
    raise exception '账号当前无法操作' using errcode = '42501';
  end if;
  if p_to is null or p_to = v_me then
    raise exception '不能给自己发私信' using errcode = '22023';
  end if;
  if char_length(v_content) < 1 or char_length(v_content) > 2000 then
    raise exception '消息长度需在 1–2000 字之间' using errcode = 'P0001';
  end if;
  -- 统一文案：不区分「不是好友 / 被拉黑 / 对方删了我」，避免社交关系泄露
  if public.pair_state(v_me, p_to) <> 'friend' then
    raise exception '你们还不是好友，无法发送消息' using errcode = '42501';
  end if;

  perform public.assert_no_banned_word(v_content, '私信内容');

  v_a := least(v_me, p_to);
  v_b := greatest(v_me, p_to);

  insert into public.conversations (user_a, user_b)
  values (v_a, v_b)
  on conflict (user_a, user_b) do nothing;

  select c.id into v_conv from public.conversations c
  where c.user_a = v_a and c.user_b = v_b;

  update public.conversations c
     set last_seq = c.last_seq + 1, last_at = now()
   where c.id = v_conv
   returning c.last_seq into v_seq;

  insert into public.direct_messages (conversation_id, seq, sender_id, content)
  values (v_conv, v_seq, v_me, v_content);
end;
$$;

-- ---------------------------------------------------------------------------
-- 12) 我的会话列表（带对方信息、最后一条消息、未读数）
-- ---------------------------------------------------------------------------
create or replace function public.my_conversations()
returns table (
  conversation_id uuid,
  peer_id         uuid,
  peer_name       text,
  peer_avatar     text,
  last_content    text,
  last_at         timestamptz,
  unread_count    int
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id,
         peer.id,
         peer.display_name,
         peer.avatar,
         (select m.content from public.direct_messages m
           where m.conversation_id = c.id order by m.seq desc limit 1),
         c.last_at,
         (select count(*)::int from public.direct_messages m
           where m.conversation_id = c.id and m.sender_id <> auth.uid() and not m.is_read)
  from public.conversations c
  join public.profiles peer
    on peer.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
  where auth.uid() is not null
    and (c.user_a = auth.uid() or c.user_b = auth.uid())
  order by c.last_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 13) 拉取会话消息（只能拉自己是参与者的会话；p_after_seq 用于增量轮询）
-- ---------------------------------------------------------------------------
create or replace function public.dm_messages(p_conversation_id uuid, p_after_seq int default 0)
returns table (
  seq        int,
  sender_id  uuid,
  content    text,
  is_read    boolean,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id
      and (c.user_a = auth.uid() or c.user_b = auth.uid())
  ) then
    raise exception '会话不存在' using errcode = 'P0002';
  end if;

  return query
  select m.seq, m.sender_id, m.content, m.is_read, m.created_at
  from public.direct_messages m
  where m.conversation_id = p_conversation_id
    and m.seq > coalesce(p_after_seq, 0)
  order by m.seq;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14) 标记会话已读（只标记对方发来的）
-- ---------------------------------------------------------------------------
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.conversations c
    where c.id = p_conversation_id
      and (c.user_a = auth.uid() or c.user_b = auth.uid())
  ) then
    raise exception '会话不存在' using errcode = 'P0002';
  end if;

  update public.direct_messages m
     set is_read = true
   where m.conversation_id = p_conversation_id
     and m.sender_id <> auth.uid()
     and not m.is_read;
end;
$$;

-- ---------------------------------------------------------------------------
-- 15) 社交角标：待处理好友申请数 + 未读私信数（侧边栏红点用）
-- ---------------------------------------------------------------------------
create or replace function public.social_badges()
returns table (pending_requests int, unread_dms int)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*)::int from public.friend_requests r
      where r.to_id = auth.uid() and r.status = 'pending'),
    (select count(*)::int
       from public.direct_messages m
       join public.conversations c on c.id = m.conversation_id
      where auth.uid() is not null
        and m.sender_id <> auth.uid()
        and not m.is_read
        and (c.user_a = auth.uid() or c.user_b = auth.uid()));
$$;


-- ---------------------------------------------------------------------------
-- 17) user_relation：作者主页用，返回我与目标用户的关系（self/none/friend/half/blocked/blockedBy）
-- ---------------------------------------------------------------------------
create or replace function public.user_relation(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.uid() is null then 'none'
    when p_user_id = auth.uid() then 'self'
    else public.pair_state(auth.uid(), p_user_id)
  end;
$$;

revoke all on function public.user_relation(uuid) from public, anon, authenticated;
grant execute on function public.user_relation(uuid) to authenticated;

-- ============================================================================
-- 6. 触发器
--   统一写法：drop trigger if exists ... on ...; create trigger ...
-- ============================================================================

-- 6.1 updated_at
drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_posts_updated_at on public.posts;
create trigger trg_posts_updated_at
  before update on public.posts
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_comments_updated_at on public.comments;
create trigger trg_comments_updated_at
  before update on public.comments
  for each row execute function public.touch_updated_at();

-- 6.2 新用户自动建资料（auth.users 上的 AFTER INSERT）
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 6.3 发帖 / 评论：填作者 + 限额（合并成一个触发器，顺序由代码保证）
drop trigger if exists trg_posts_prepare_insert on public.posts;
create trigger trg_posts_prepare_insert
  before insert on public.posts
  for each row execute function public.prepare_post_insert();

drop trigger if exists trg_comments_prepare_insert on public.comments;
create trigger trg_comments_prepare_insert
  before insert on public.comments
  for each row execute function public.prepare_comment_insert();

-- 6.4 评论计数
drop trigger if exists trg_comments_sync_count on public.comments;
create trigger trg_comments_sync_count
  after insert or update of is_deleted on public.comments
  for each row execute function public.sync_comment_count();

-- 6.5 评论通知
drop trigger if exists trg_comments_notify on public.comments;
create trigger trg_comments_notify
  after insert on public.comments
  for each row execute function public.notify_on_comment();

-- 6.6 关注者新帖通知
drop trigger if exists trg_posts_notify_followers on public.posts;
create trigger trg_posts_notify_followers
  after insert on public.posts
  for each row execute function public.notify_followers_on_post();

-- 6.7 违禁词检测（名称按字母序执行，check_* 排在 prepare_* 之前，互不影响）
drop trigger if exists trg_posts_check_words on public.posts;
create trigger trg_posts_check_words
  before insert or update of title, content on public.posts
  for each row execute function public.check_post_words();

drop trigger if exists trg_comments_check_words on public.comments;
create trigger trg_comments_check_words
  before insert or update of content on public.comments
  for each row execute function public.check_comment_words();

drop trigger if exists trg_profiles_check_words on public.profiles;
create trigger trg_profiles_check_words
  before insert or update of display_name, bio on public.profiles
  for each row execute function public.check_profile_words();

drop trigger if exists trg_user_handles_check_words on public.user_handles;
create trigger trg_user_handles_check_words
  before insert or update of username on public.user_handles
  for each row execute function public.check_handle_words();

-- 6.8 反馈内容违禁词检测
drop trigger if exists trg_feedback_check_words on public.feedback;
create trigger trg_feedback_check_words
  before insert or update of content on public.feedback
  for each row execute function public.check_feedback_words();

-- 6.9 举报目标校验：目标必须存在（reports.target_id 没有外键，要指向 3 张不同的表），
--     且不能举报自己。放在触发器里做，前端不需要额外查询。
drop trigger if exists trg_reports_validate_target on public.reports;
create trigger trg_reports_validate_target
  before insert on public.reports
  for each row execute function public.validate_report_target();
-- 6.10 明细行删除（含级联）时反向扣减计数，避免账号注销后计数永久偏高
drop trigger if exists trg_post_votes_sync_on_delete on public.post_votes;
create trigger trg_post_votes_sync_on_delete
  after delete on public.post_votes
  for each row execute function public.sync_vote_count_on_delete();

drop trigger if exists trg_comment_likes_sync_on_delete on public.comment_likes;
create trigger trg_comment_likes_sync_on_delete
  after delete on public.comment_likes
  for each row execute function public.sync_comment_like_count_on_delete();

drop trigger if exists trg_favorites_sync_on_delete on public.favorites;
create trigger trg_favorites_sync_on_delete
  after delete on public.favorites
  for each row execute function public.sync_favorite_count_on_delete();





-- 6.11 好友申请留言 / 私信正文的违禁词检测
drop trigger if exists trg_friend_requests_check_words on public.friend_requests;
create trigger trg_friend_requests_check_words
  before insert or update of message on public.friend_requests
  for each row execute function public.check_friend_request_words();

drop trigger if exists trg_direct_messages_check_words on public.direct_messages;
create trigger trg_direct_messages_check_words
  before insert or update of content on public.direct_messages
  for each row execute function public.check_dm_words();


-- ============================================================================
-- 7. 权限：① 先全部收回，② 再按列放行，③ 函数按需授权
--   Supabase 默认会给 anon / authenticated 授予 public 下所有表的全部权限，
--   不收回的话列级 GRANT 形同虚设（设计方案 11.2）。
-- ============================================================================

-- ① 收回所有表 / 视图 / 函数权限
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- ② 只读放行
grant select on public.boards          to anon, authenticated;
grant select on public.posts           to anon, authenticated;
grant select on public.comments        to anon, authenticated;
grant select on public.app_config      to anon, authenticated;

-- profiles 公开可读，但【只给公开列】——role / is_active / banned_* 不授权
grant select (id, display_name, avatar, bio, created_at)
  on public.profiles to anon, authenticated;

-- 管理字段走 admin_profiles 视图（视图内部 where is_admin()）
grant select on public.admin_profiles to authenticated;

grant select on public.user_handles   to authenticated;  -- RLS：本人 / 管理员
grant select on public.post_votes     to authenticated;  -- RLS：本人
grant select on public.comment_likes  to authenticated;  -- RLS：本人
grant select on public.favorites      to authenticated;  -- RLS：本人
grant select on public.follows        to authenticated;  -- RLS：本人关注 / 本人粉丝
grant select on public.notifications  to authenticated;  -- RLS：本人
grant select on public.reports        to authenticated;  -- RLS：本人举报 / 管理员

-- ③ 按列放行写入（关键！计数列、author_id、is_pinned、is_locked、is_deleted 一律不给）
grant insert (board_slug, title, content, images)
  on public.posts to authenticated;
grant update (title, content, images)
  on public.posts to authenticated;

grant insert (post_id, parent_id, content)
  on public.comments to authenticated;
grant update (content)
  on public.comments to authenticated;

grant update (display_name, avatar, bio)
  on public.profiles to authenticated;

grant update (is_read)
  on public.notifications to authenticated;

-- 举报只授 INSERT（reporter_id 用列默认 auth.uid()，status 只能默认 pending）
grant insert (target_type, target_id, reason, detail)
  on public.reports to authenticated;

-- user_handles / follows / post_votes / favorites / comment_likes：连 INSERT 都不给，只能走 RPC / 触发器。

-- ④ 函数权限
--   基础判断函数被 RLS 策略直接调用，anon / authenticated 必须能执行它们
grant execute on function public.is_admin()               to anon, authenticated;
grant execute on function public.is_super_admin()         to anon, authenticated;
grant execute on function public.is_active_user()         to anon, authenticated;
grant execute on function public.can_read_post(uuid)      to anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- 公开查询类 RPC（作者主页、搜索等游客也要能看）
grant execute on function public.search_posts(text, text, text, int, int, timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.posts_by_author(uuid, int, int)         to anon, authenticated;
grant execute on function public.author_profile(uuid)                    to anon, authenticated;

-- 登录用户 RPC
grant execute on function public.vote_post(uuid, smallint)      to authenticated;
grant execute on function public.toggle_comment_like(uuid)      to authenticated;

-- 违禁词：公开预校验（匿名也要，注册昵称前先查）；管理 RPC 仅登录用户（内部再判 admin）
grant execute on function public.check_banned_word(text)        to anon, authenticated;
grant execute on function public.admin_banned_words()           to authenticated;
grant execute on function public.admin_add_banned_word(text, text) to authenticated;
grant execute on function public.admin_delete_banned_word(uuid) to authenticated;
grant execute on function public.toggle_favorite(uuid)          to authenticated;
grant execute on function public.toggle_follow(uuid)            to authenticated;
grant execute on function public.soft_delete_post(uuid)         to authenticated;
grant execute on function public.soft_delete_comment(uuid)      to authenticated;
grant execute on function public.mark_all_notifications_read()  to authenticated;
grant execute on function public.mark_notification_read(uuid)   to authenticated;
grant execute on function public.my_following(int, int)         to authenticated;
grant execute on function public.my_followers(int, int)         to authenticated;
grant execute on function public.my_profile()                   to authenticated;

-- 管理员 RPC
grant execute on function public.admin_set_role(uuid, public.user_role)                  to authenticated;
grant execute on function public.admin_set_active(uuid, boolean, text, timestamptz)      to authenticated;
grant execute on function public.admin_set_pinned(uuid, boolean)                         to authenticated;
grant execute on function public.admin_lock_post(uuid, boolean)                          to authenticated;
grant execute on function public.admin_soft_delete_post(uuid)                            to authenticated;
grant execute on function public.admin_soft_delete_comment(uuid)                         to authenticated;
grant execute on function public.admin_resolve_report(uuid, public.report_status, text)  to authenticated;
grant execute on function public.recount_posts()                                         to authenticated;

-- 意见反馈（写入 / 查看自己的 / 管理端查看与标记，函数内部再判权限）
grant execute on function public.submit_feedback(text, text, text) to authenticated;
grant execute on function public.my_feedback()                     to authenticated;
grant execute on function public.admin_feedback(text)              to authenticated;
grant execute on function public.admin_resolve_feedback(uuid, text) to authenticated;

-- Supabase 在 public schema 上配了 ALTER DEFAULT PRIVILEGES，新建函数会自动 grant 给 anon；
-- 上面这些只有登录用户 / 管理员能调，必须显式从 anon 收回（否则 anon 也能"调用"到）。
revoke all on function public.submit_feedback(text, text, text) from anon;
revoke all on function public.my_feedback()                     from anon;
revoke all on function public.admin_feedback(text)              from anon;
revoke all on function public.admin_resolve_feedback(uuid, text) from anon;
revoke all on function public.validate_report_target()           from public, anon, authenticated;
revoke all on function public.invisible_chars()                  from public, anon, authenticated;
revoke all on function public.sync_vote_count_on_delete()          from public, anon, authenticated;
revoke all on function public.sync_comment_like_count_on_delete()  from public, anon, authenticated;
revoke all on function public.sync_favorite_count_on_delete()      from public, anon, authenticated;

-- 16) 权限：4 张表前端完全不可直读写；函数先收回 PUBLIC 再按需授权
-- ---------------------------------------------------------------------------
revoke all on public.friendships      from anon, authenticated;
revoke all on public.friend_requests  from anon, authenticated;
revoke all on public.conversations    from anon, authenticated;
revoke all on public.direct_messages  from anon, authenticated;

-- 二期 Realtime：conversations / direct_messages 需要 SELECT 才能被订阅到
-- （RLS 策略限制为「只有会话参与者」，写权限一律不给）
grant select on public.conversations   to authenticated;
grant select on public.direct_messages to authenticated;
revoke all on public.conversations   from anon;
revoke all on public.direct_messages from anon;

alter table public.friendships     enable row level security;
alter table public.friend_requests enable row level security;
alter table public.conversations   enable row level security;
alter table public.direct_messages enable row level security;

revoke all on function public.pair_state(uuid, uuid) from public, anon, authenticated;
revoke all on function public.check_friend_request_words() from public, anon, authenticated;
revoke all on function public.check_dm_words() from public, anon, authenticated;

revoke all on function public.search_users(text, int) from public, anon, authenticated;
revoke all on function public.send_friend_request(uuid, text) from public, anon, authenticated;
revoke all on function public.respond_friend_request(uuid, boolean) from public, anon, authenticated;
revoke all on function public.my_friend_requests() from public, anon, authenticated;
revoke all on function public.my_friends() from public, anon, authenticated;
revoke all on function public.remove_friend(uuid) from public, anon, authenticated;
revoke all on function public.set_friend_block(uuid, boolean) from public, anon, authenticated;
revoke all on function public.send_dm(uuid, text) from public, anon, authenticated;
revoke all on function public.my_conversations() from public, anon, authenticated;
revoke all on function public.dm_messages(uuid, int) from public, anon, authenticated;
revoke all on function public.mark_conversation_read(uuid) from public, anon, authenticated;
revoke all on function public.social_badges() from public, anon, authenticated;

grant execute on function public.search_users(text, int)          to authenticated;
grant execute on function public.send_friend_request(uuid, text)  to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;
grant execute on function public.my_friend_requests()             to authenticated;
grant execute on function public.my_friends()                     to authenticated;
grant execute on function public.remove_friend(uuid)              to authenticated;
grant execute on function public.set_friend_block(uuid, boolean)  to authenticated;
grant execute on function public.send_dm(uuid, text)              to authenticated;
grant execute on function public.my_conversations()               to authenticated;
grant execute on function public.dm_messages(uuid, int)           to authenticated;
grant execute on function public.mark_conversation_read(uuid)     to authenticated;
grant execute on function public.social_badges()                  to authenticated;

grant execute on all functions in schema public to service_role;

notify pgrst, 'reload schema';

-- ⑤ service_role（后端密钥，绝不出现在前端）保留全量权限，方便运维 / 修复数据
grant usage on schema public to service_role;
grant all on all tables in schema public    to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;


-- ============================================================================
-- 8. RLS：开启行级安全 + 策略
--   策略里引用的函数已在第 3、5 节创建完毕（教训 4：函数必须先存在）。
-- ============================================================================

alter table public.profiles      enable row level security;
alter table public.user_handles  enable row level security;
alter table public.boards        enable row level security;
alter table public.posts         enable row level security;
alter table public.comments      enable row level security;
alter table public.post_votes    enable row level security;
alter table public.comment_likes enable row level security;
alter table public.banned_words  enable row level security;
alter table public.favorites     enable row level security;
alter table public.follows       enable row level security;
alter table public.notifications enable row level security;
alter table public.reports       enable row level security;
alter table public.feedback      enable row level security;
alter table public.app_config    enable row level security;

-- 二期：好友 + 私信（前端无任何表权限，RLS 开启且无策略 → 直连 REST 一律被拒）
alter table public.friendships      enable row level security;
alter table public.friend_requests  enable row level security;
alter table public.conversations    enable row level security;
alter table public.direct_messages  enable row level security;

-- 8.1 profiles：所有人可读（列级权限只给公开列）；本人可改 3 列
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to anon, authenticated
  using (true);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- 8.2 user_handles：仅本人 / 管理员可读；无任何写策略（写入只能触发器 / RPC）
drop policy if exists user_handles_select on public.user_handles;
create policy user_handles_select on public.user_handles
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- 8.3 boards：公开只读（写入只在 SQL Editor / admin RPC）
drop policy if exists boards_select on public.boards;
create policy boards_select on public.boards
  for select to anon, authenticated
  using (true);

-- 8.4 posts：未删 / 本人 / 管理员可读
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select to anon, authenticated
  using (not is_deleted or author_id = auth.uid() or public.is_admin());

-- 发帖：本人 + 账号可用 + 板块未锁（author_id 由触发器填，客户端传不进来）
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and not is_deleted
    and public.is_active_user()
    and exists (
      select 1 from public.boards b
      where b.slug = board_slug and not b.is_locked
    )
  );

-- 改帖：本人 / 管理员（列级权限只允许改 title / content / images）
drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts
  for update to authenticated
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());

-- 8.5 comments：未删（或本人 / 管理员）且帖子可见
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select to anon, authenticated
  using (
    (not is_deleted or author_id = auth.uid() or public.is_admin())
    and public.can_read_post(post_id)
  );

-- 发评论：本人 + 账号可用 + 帖子未删且未锁（触发器还会给中文提示）
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and not is_deleted
    and public.is_active_user()
    and exists (
      select 1 from public.posts p
      where p.id = post_id and not p.is_deleted and not p.is_locked
    )
  );

drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments
  for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- 8.6 明细表：只能读自己的
drop policy if exists post_votes_select on public.post_votes;
create policy post_votes_select on public.post_votes
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists comment_likes_select on public.comment_likes;
create policy comment_likes_select on public.comment_likes
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists favorites_select on public.favorites;
create policy favorites_select on public.favorites
  for select to authenticated
  using (user_id = auth.uid());

-- 8.7 follows：能看自己关注的 + 关注自己的（看不到第三方社交图谱）
drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows
  for select to authenticated
  using (follower_id = auth.uid() or target_id = auth.uid());

-- 8.8 notifications：本人可读 / 可改 is_read / 可删
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated
  using (user_id = auth.uid());

-- 8.9 reports：本人看自己的，管理员看全部；INSERT 强制 pending
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select to authenticated
  using (reporter_id = auth.uid() or public.is_admin());

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports
  for insert to authenticated
  with check (
    reporter_id = auth.uid()
    and status = 'pending'
    and public.is_active_user()
  );

-- 8.11 conversations / direct_messages：只有会话参与者可读（Realtime 也按这个过滤）
drop policy if exists conversations_select_participant on public.conversations;
create policy conversations_select_participant on public.conversations
  for select to authenticated
  using (user_a = auth.uid() or user_b = auth.uid());

drop policy if exists direct_messages_select_participant on public.direct_messages;
create policy direct_messages_select_participant on public.direct_messages
  for select to authenticated
  using (
    exists (
      select 1 from public.conversations c
      where c.id = direct_messages.conversation_id
        and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );


-- 8.10 app_config：公开只读（改参数只能在 SQL Editor）
drop policy if exists app_config_select on public.app_config;
create policy app_config_select on public.app_config
  for select to anon, authenticated
  using (true);


-- ============================================================================
-- 9. 种子数据
-- ============================================================================

-- 9.1 五个板块
insert into public.boards (slug, name, description, icon, accent, sort_order, is_anonymous, is_locked)
values
  ('chat',   '校园闲聊', '课表、食堂、宿舍、日常吐槽，随便聊', 'message-circle',  'primary', 1, false, false),
  ('study',  '学习求助', '作业、考试、选课、实验，互帮互助',   'graduation-cap',  'blue',    2, false, false),
  ('love',   '表白墙',   '喜欢就说出来，别留遗憾',             'heart',           'pink',    3, true,  false),
  ('lost',   '失物招领', '丢了东西或捡到东西都发这里',         'map-pin',         'amber',   4, false, false),
  ('friend', '交友脱单', '找搭子、找朋友、找对象',             'users',           'violet',  5, false, false)
on conflict (slug) do update
  set name         = excluded.name,
      description  = excluded.description,
      icon         = excluded.icon,
      accent       = excluded.accent,
      sort_order   = excluded.sort_order,
      is_anonymous = excluded.is_anonymous;
-- 注意：不覆盖 is_locked，避免重跑脚本把管理员关闭的板块重新打开

-- 9.2 运行参数（简化口径：冷却 0、日限额放宽、禁止图片）
insert into public.app_config (key, value, description)
values
  ('post_cooldown_minutes',    '0'::jsonb,  '注册满多少分钟才能发帖（0 = 不限制）'),
  ('post_daily_limit',         '50'::jsonb, '24 小时内最多发帖数'),
  ('comment_cooldown_minutes', '0'::jsonb,  '两次评论之间的冷却分钟数（0 = 不限制）'),
  ('comment_daily_limit',      '200'::jsonb,'24 小时内最多评论数'),
  ('max_images_per_post',      '0'::jsonb,  '单帖最多图片数（0 = 暂不支持图片）')
on conflict (key) do update
  set value       = excluded.value,
      description = excluded.description,
      updated_at  = now();

-- 9.3 违禁词种子（后台「违禁词」标签可增删；匹配忽略大小写与空白）
insert into public.banned_words (word, note)
values
  ('傻逼', '通用辱骂'),
  ('煞笔', '通用辱骂'),
  ('操你妈', '通用辱骂'),
  ('fuck', '通用辱骂（英文）'),
  ('代开发票', '违法广告'),
  ('赌博网站', '违法广告'),
  ('黄色网站', '违法广告'),
  ('办假证', '违法广告'),
  ('冰毒', '违法内容')
on conflict (word) do nothing;


-- ============================================================================
-- 9.5 Realtime 发布：通知 + 私信（Supabase Realtime 的 postgres_changes 只推发布内的表）
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
    ) then
      execute 'alter publication supabase_realtime add table public.notifications';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
    ) then
      execute 'alter publication supabase_realtime add table public.conversations';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'direct_messages'
    ) then
      execute 'alter publication supabase_realtime add table public.direct_messages';
    end if;
  end if;
end
$$;

-- ============================================================================
-- 10. 收尾
-- ============================================================================

-- 让 PostgREST 立即刷新 schema cache（新建的表 / 视图 / 函数才能马上被 REST 访问）
notify pgrst, 'reload schema';


-- ============================================================================
-- 11. 验收自检 SQL（复制到 SQL Editor 新查询里执行；以注释形式附在此处）
-- ----------------------------------------------------------------------------
-- 【11.1 表与 RLS】期望 14 行，rowsecurity 全为 true
--   select tablename, rowsecurity
--   from pg_tables
--   where schemaname = 'public'
--   order by tablename;
--
-- 【11.2 管理员视图】期望 1 行，table_type = 'VIEW'
--   select table_name, table_type
--   from information_schema.tables
--   where table_schema = 'public' and table_name = 'admin_profiles';
--
-- 【11.3 枚举值】notification_type 必须含 follow_post
--   select enumlabel
--   from pg_enum
--   where enumtypid = 'public.notification_type'::regtype
--   order by enumsortorder;
--
-- 【11.4 profiles 不能有这些列】期望 0 行
--   select column_name
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'profiles'
--     and column_name in ('password', 'username', 'email', 'anonymous_name');
--
-- 【11.5 列级权限】期望 profiles 只放行公开列，且没有 role / is_active 等
--   select grantee, privilege_type, column_name
--   from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'profiles'
--   order by grantee, privilege_type, column_name;
--
-- 【11.6 函数清单】确认 RPC 都存在，security definer 的函数 prosecdef = true
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--   order by p.proname;
--
-- 【11.7 RLS 策略清单】期望覆盖 profiles / posts / comments / reports 等
--   select tablename, policyname, cmd, roles
--   from pg_policies
--   where schemaname = 'public'
--   order by tablename, policyname;
--
-- 【11.8 外键名（前端嵌入查询依赖）】
--   select conname
--   from pg_constraint
--   where conrelid = 'public.posts'::regclass and contype = 'f';
--   -- 期望含 posts_author_id_fkey、posts_board_slug_fkey
--   select conname
--   from pg_constraint
--   where conrelid = 'public.comments'::regclass and contype = 'f';
--   -- 期望含 comments_author_id_fkey、comments_post_id_fkey、comments_parent_id_fkey
--
-- 【11.9 种子数据】期望 5 个板块、5 条配置
--   select slug, name, sort_order, is_locked from public.boards order by sort_order;
--   select key, value from public.app_config order by key;
--
-- 【11.10 管理员角色】设置管理员后执行，期望 1 行 role = admin
--   select id, display_name, role, is_active
--   from public.profiles
--   where role <> 'user';
-- ============================================================================


-- ============================================================================
-- 12. 管理员设置（脚本跑完后，手动执行，三选一）
-- ----------------------------------------------------------------------------
-- 方式 A：按注册邮箱（推荐；邮箱从 Authentication → Users 里能看到）
--   update public.profiles p
--      set role = 'admin'
--     from auth.users u
--    where u.id = p.id
--      and lower(u.email) = lower('you@example.com');
--
-- 方式 B：按用户 id（Dashboard → Authentication → Users → 点开用户复制 id）
--   update public.profiles set role = 'admin' where id = '粘贴-user-uuid';
--
-- 方式 C：按用户名句柄（注册时前端如果传了 username，且没被自动生成覆盖）
--   update public.profiles p
--      set role = 'admin'
--     from public.user_handles h
--    where h.user_id = p.id
--      and h.is_current
--      and h.username = '你的用户名';
--
-- 设置成功后执行下面这句确认（应返回 1 行，role = admin）：
--   select id, display_name, role from public.profiles where role <> 'user';
--
-- 想撤销管理员：update public.profiles set role = 'user' where id = '...';
-- ============================================================================
