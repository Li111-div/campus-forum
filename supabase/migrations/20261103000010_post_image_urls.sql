-- ============================================================================
-- 图片字段加固（ImgBB 图床接入后的安全修复）
--
-- 背景：posts.images 是 text[]，前端详情页会把它渲染成
--       <a href={src}><img src={src} /></a>。
--       原实现只校验了「数量」，没校验「协议」，
--       于是 authenticated 用户可以直接 POST 一条
--         images: ["javascript:alert(document.cookie)"]
--       帖子详情页点一下这个「图片」就会在论坛域下执行任意脚本，
--       可以读取 localStorage 里的 Supabase 会话 → 等于账号被盗。
--
-- 本迁移做三件事：
--   1. 清掉历史数据里不合法的图片地址（只保留 http/https）
--   2. 在 prepare_post_insert 触发器里增加协议白名单校验
--   3. 数量上限继续保持由 app_config.max_images_per_post 控制（当前 4）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) 清理历史非法地址
-- ---------------------------------------------------------------------------
update public.posts
set images = array(select u from unnest(images) as u where u ~* '^https?://')
where images is not null
  and exists (select 1 from unnest(images) as u where u !~* '^https?://');

-- ---------------------------------------------------------------------------
-- 2) 触发器加入协议白名单
--    其余校验逻辑与原函数完全一致，只新增 ②' 这一段
-- ---------------------------------------------------------------------------
create or replace function public.prepare_post_insert()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  --     防止 javascript: / data: / vbscript: 之类的伪协议被渲染成可点击链接执行脚本
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
$function$;
