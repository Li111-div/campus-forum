-- ============================================================================
-- 20261102000005_feedback.sql
-- 意见反馈：用户提交建议 / 问题 / 其他，管理员在后台查看并标记处理
-- ----------------------------------------------------------------------------
-- 设计要点（与 init.sql 同口径）：
--   1) feedback 表前端【没有任何直接读写权限】：写入只能走 submit_feedback，
--      读取只能走 my_feedback / admin_feedback（都是 security definer）。
--   2) 开启 RLS 但【不建策略】= 直连 REST 一律拒绝，避免联系方式等隐私字段泄露。
--   3) 反馈内容同样过违禁词触发器（check_feedback_words）。
--   4) status 只有 pending / resolved 两种；管理员标记处理时记录 handled_by / handled_at。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 表
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
-- 2. 违禁词触发器函数
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
-- 3. 提交反馈（登录用户；被限制的账号不能提交）
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
-- 4. 我的反馈（只能看到自己的）
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
-- 5. 管理端：全部反馈（可按状态筛），仅 admin
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
-- 6. 管理端：标记已处理 / 重新打开，仅 admin
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
-- 7. 触发器 / 权限 / RLS
-- ---------------------------------------------------------------------------
drop trigger if exists trg_feedback_check_words on public.feedback;
create trigger trg_feedback_check_words
  before insert or update of content on public.feedback
  for each row execute function public.check_feedback_words();

-- 前端没有任何表权限：读写只走上面的 RPC
revoke all on public.feedback from anon, authenticated;

alter table public.feedback enable row level security;

-- 函数授权（内部再判登录 / 管理员）
grant execute on function public.submit_feedback(text, text, text) to authenticated;
grant execute on function public.my_feedback()                   to authenticated;
grant execute on function public.admin_feedback(text)            to authenticated;
grant execute on function public.admin_resolve_feedback(uuid, text) to authenticated;

notify pgrst, 'reload schema';
