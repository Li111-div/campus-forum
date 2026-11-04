-- ============================================================================
-- 二期：好友 + 私信（增量升级）
-- 说明：v1 已建库的项目执行本文件即可；新项目直接跑 init.sql（已包含同样逻辑）。
--
-- 设计依据：docs/设计方案.md §7.3
-- 1) 4 张表：friendships / friend_requests / conversations / direct_messages
--    全部「前端无任何表权限」，读写只走 RPC（对齐项目既有安全约定）
-- 2) pair_state()：一个函数说清「好友 / 半好友 / 被拉黑 / 我拉黑」四种关系
-- 3) 好友：搜人、发申请、同意/拒绝、列表、删好友、拉黑
-- 4) 私信：发消息（仅好友）、会话列表、拉取消息、标记已读、未读角标
-- 5) 违禁词：好友申请留言、私信正文都要过词库
-- ============================================================================

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

-- ---------------------------------------------------------------------------
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

drop trigger if exists trg_friend_requests_check_words on public.friend_requests;
create trigger trg_friend_requests_check_words
  before insert or update of message on public.friend_requests
  for each row execute function public.check_friend_request_words();

drop trigger if exists trg_direct_messages_check_words on public.direct_messages;
create trigger trg_direct_messages_check_words
  before insert or update of content on public.direct_messages
  for each row execute function public.check_dm_words();

-- ---------------------------------------------------------------------------
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
-- 16) 权限：4 张表前端完全不可直读写；函数先收回 PUBLIC 再按需授权
-- ---------------------------------------------------------------------------
revoke all on public.friendships      from anon, authenticated;
revoke all on public.friend_requests  from anon, authenticated;
revoke all on public.conversations    from anon, authenticated;
revoke all on public.direct_messages  from anon, authenticated;

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

notify pgrst, 'reload schema';
