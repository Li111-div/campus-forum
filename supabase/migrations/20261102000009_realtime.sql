-- ============================================================================
-- 二期：Realtime 实时推送（增量升级）
-- 说明：v1 已建库的项目执行本文件即可；新项目直接跑 init.sql（已包含同样逻辑）。
--
-- 目标：通知、私信、会话列表不再靠轮询，改成 WebSocket 即时推送。
--
-- 关键点：Supabase Realtime 的 postgres_changes 会**按 RLS 策略**过滤行。
--   1) notifications 本来就有「本人可读」策略 + 表级 SELECT 授权 → 直接可用。
--   2) conversations / direct_messages 之前是「零表权限 + 无策略」，
--      Realtime 拿不到任何行，所以必须补「参与者可读」的 SELECT 策略。
--      注意：只加 SELECT 策略，**不授予 INSERT/UPDATE/DELETE**，
--      写操作仍然只能走 send_dm / mark_conversation_read 等 RPC。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 把三张表加入 Realtime 发布（幂等）
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2) SELECT 策略：只有会话参与者能读
--    （这两张表原来没有任何策略，Realtime 会被 RLS 全部过滤掉）
-- ---------------------------------------------------------------------------
drop policy if exists conversations_select_participant on public.conversations;
create policy conversations_select_participant on public.conversations
  for select to authenticated
  using (user_a = auth.uid() or user_b = auth.uid());

drop policy if exists direct_messages_select_participant on public.direct_messages;
create policy direct_messages_select_participant on public.direct_messages
  for select to authenticated
  using (
    exists (
      select 1
      from public.conversations c
      where c.id = direct_messages.conversation_id
        and (c.user_a = auth.uid() or c.user_b = auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- 3) 表级权限：Realtime 的订阅查询需要 SELECT，但写权限一律不给
--    （原来 revoke all，这里只补回 SELECT；INSERT/UPDATE/DELETE 仍然没有）
-- ---------------------------------------------------------------------------
grant select on public.conversations   to authenticated;
grant select on public.direct_messages to authenticated;

-- anon 一律不给（私信内容不对未登录用户开放）
revoke all on public.conversations   from anon;
revoke all on public.direct_messages from anon;

notify pgrst, 'reload schema';
