-- ============================================================================
-- 违禁词检测（增量升级）
-- 说明：v1 已建库的项目执行本文件即可；新项目直接跑 init.sql（已包含同样逻辑）。
--
-- 1) banned_words 词库表（前端不可直读，管理走 RPC）
-- 2) find_banned_word / assert_no_banned_word 内部匹配函数（忽略大小写与空白）
-- 3) check_banned_word 公开预校验 RPC（注册昵称前置检查用，不需要登录）
-- 4) 触发器：发帖标题/正文、评论正文、昵称、用户名——命中即拒绝写入
-- 5) 管理 RPC：admin_banned_words / admin_add_banned_word / admin_delete_banned_word
-- 6) 种子词（on conflict do nothing，后台可增删）
-- ============================================================================

-- 1) 词库
create table if not exists public.banned_words (
  id         uuid primary key default gen_random_uuid(),
  word       text not null unique,
  note       text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint banned_words_word_len check (char_length(btrim(word)) between 1 and 32)
);

create index if not exists banned_words_word_idx on public.banned_words (word);

-- 不可见字符表：零宽空格/零宽连接符/词连接符/软连字符/BOM 等，匹配前统一剔除
create or replace function public.invisible_chars()
returns text
language sql
immutable
as $$
  select chr(8203) || chr(8204) || chr(8205) || chr(8206) || chr(8207)
      || chr(8288) || chr(173) || chr(65279) || chr(12288);
$$;
-- 2) 匹配：统一小写、去掉所有空白（含全角空格），包含即命中；长词优先返回
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

-- 命中就报中文错误（触发器统一调用）
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

-- 3) 公开预校验（匿名也可调，只返回命中的词，不暴露整个词库）
create or replace function public.check_banned_word(p_text text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select public.find_banned_word(p_text);
$$;

-- 4) 触发器函数
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

-- 5) 管理 RPC（仅超级管理员，即 role = admin）
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

-- 触发器：名称按字母序执行，check_* 在 prepare_* 之前，互不影响
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
  before insert or update of display_name on public.profiles
  for each row execute function public.check_profile_words();

drop trigger if exists trg_user_handles_check_words on public.user_handles;
create trigger trg_user_handles_check_words
  before insert or update of username on public.user_handles
  for each row execute function public.check_handle_words();

-- 权限：词库表前端完全不可见（只给 SELECT 也不给，读走 RPC）
revoke all on public.banned_words from anon, authenticated;

alter table public.banned_words enable row level security;

revoke all on function public.find_banned_word(text) from public, anon, authenticated;
revoke all on function public.assert_no_banned_word(text, text) from public, anon, authenticated;
revoke all on function public.check_post_words() from public, anon, authenticated;
revoke all on function public.check_comment_words() from public, anon, authenticated;
revoke all on function public.check_profile_words() from public, anon, authenticated;
revoke all on function public.check_handle_words() from public, anon, authenticated;

revoke all on function public.check_banned_word(text) from public, anon, authenticated;
grant execute on function public.check_banned_word(text) to anon, authenticated;

revoke all on function public.admin_banned_words() from public, anon, authenticated;
revoke all on function public.admin_add_banned_word(text, text) from public, anon, authenticated;
revoke all on function public.admin_delete_banned_word(uuid) from public, anon, authenticated;
grant execute on function public.admin_banned_words() to authenticated;
grant execute on function public.admin_add_banned_word(text, text) to authenticated;
grant execute on function public.admin_delete_banned_word(uuid) to authenticated;

-- 6) 种子词（管理员可在后台增删）
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

notify pgrst, 'reload schema';
