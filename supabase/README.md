# Supabase 数据库初始化说明

> 本项目是 `campus-forum-app` 的数据库交付物。
> 目标：把一个**空的 Supabase 项目**一次性建成可用的校园论坛数据库（表 / 索引 / 枚举 / 权限 / RLS / 函数 / 触发器 / 种子）。
>
> 相关文档：
> - 设计方案：[`docs/设计方案.md`](../docs/设计方案.md)（v2.5，第 10–12 节）
> - 验收清单：[`docs/验收清单.md`](../docs/验收清单.md)（M0 段）
> - 前端接口契约：[`docs/数据库-接口契约.md`](../docs/数据库-接口契约.md) ← **前端只看这一份就够了**

---

## 1. 文件清单

| 文件 | 作用 |
|---|---|
| `supabase/init.sql` | **唯一需要执行的 SQL**。整段粘贴到 Supabase SQL Editor 运行 |
| `supabase/migrations/*.sql` | 增量升级脚本（已建库的项目执行这些，不必重跑 init.sql） |
| `supabase/README.md` | 本文件：执行步骤 / 设管理员 / 自检 / 常见错误 |
| `supabase/tools/check-init.mjs` | 文本级自检脚本（`node supabase/tools/check-init.mjs`，不连数据库） |
| `docs/数据库-接口契约.md` | 前端接口契约（表可读列、外键名、RPC 参数与返回列） |

> 与设计方案 M0 的差异：按简化口径**合并成单个 init.sql**（不再拆 4 个 migration），
> 不建 Storage 桶、不做 Edge Function。执行顺序已在文件内固定为
> **schema（枚举+表）→ functions → triggers → 权限 → policies → seed**。

### 增量升级（已上线的库）

| 文件 | 内容 |
|---|---|
| `migrations/20261102000001_comment_replies.sql` | 楼中楼：回复评论时给被回复者发 `reply` 通知；删除评论连带软删一层回复 |
| `migrations/20261102000002_post_time_filter.sql` | 帖子时间筛选：`search_posts` 增加可选 `p_since` / `p_until`（不传时行为不变） |
| `migrations/20261102000003_comment_likes.sql` | 评论点赞：`comments.like_count` + `comment_likes` 明细表 + `toggle_comment_like` RPC |
| `migrations/20261102000004_banned_words.sql` | 违禁词：`banned_words` 词库 + 发帖/评论/昵称/用户名触发器拦截 + `admin_banned_words` 等管理 RPC |
| `migrations/20261102000005_feedback.sql` | 意见反馈：`feedback` 表（前端无表权限）+ `submit_feedback` / `my_feedback` / `admin_feedback` / `admin_resolve_feedback` RPC |
| `migrations/20261102000006_hardening.sql` | 安全加固：收回 PUBLIC/anon 的函数执行权、违禁词剔除零宽字符、简介也过词库、举报目标校验触发器 |
| `migrations/20261102000007_count_sync.sql` | 计数一致性：`post_votes` / `comment_likes` / `favorites` 删除（含账号级联删除）时反向扣减计数，`recount_posts` 顺带修复评论点赞数 |
| `migrations/20261102000008_friends_dm.sql` | 二期好友/私信：`friendships` / `friend_requests` / `conversations` / `direct_messages` 四张表（前端无表权限）+ `pair_state` / `search_users` / 加好友 / 拉黑 / `send_dm` / 会话与消息 RPC |
| `migrations/20261102000009_realtime.sql` | Realtime：把 notifications / conversations / direct_messages 加入 `supabase_realtime` 发布 + 参与者可读的 SELECT 策略与授权（写仍只能走 RPC） |
| `migrations/20261103000010_post_image_urls.sql` | 图片字段加固：`prepare_post_insert` 增加 http/https 协议白名单（拦 `javascript:` / `data:` 伪协议），并清理历史非法地址 |

执行方式（二选一）：

```bash
# 方式 A：有数据库密码，一条命令跑完所有 migrations
DB_PASSWORD=... SUPABASE_REF=... DB_HOST=... npm run db:migrate

# 方式 B：Supabase SQL Editor 里粘贴 migrations/*.sql 内容执行
```

---

## 2. 前置准备

1. 新建 Supabase 项目（区域建议 Singapore / Tokyo）。
2. **关闭邮箱确认**（否则注册后没有 session）：
   `Authentication → Providers → Email → Confirm email = OFF`，然后 Save。
3. 记下两个值（Project Settings → API）：
   - `Project URL`（形如 `https://xxxx.supabase.co`）
   - `anon public` key
4. ⚠️ **`service_role` key 绝不能出现在前端代码 / `.env.local` 里**。前端只用 anon key。

---

## 3. 执行步骤（SQL Editor）

1. 打开 Supabase Dashboard → **SQL Editor** → **New query**。
2. 打开 `supabase/init.sql`，**全选复制**，粘贴进编辑器。
3. 点击 **Run**（或 Ctrl/Cmd + Enter）。
4. 看到 `Success. No rows returned` 即成功。
   - 文件末尾有一句 `notify pgrst, 'reload schema';`，用于让 PostgREST 立刻识别新表 / 视图 / 函数，**不要删**。
5. 如果 Dashboard 的 Table Editor 里暂时看不到表，刷新页面；或再单独执行一次：
   ```sql
   notify pgrst, 'reload schema';
   ```
6. 脚本是**幂等**的（`create table if not exists` / `create or replace function` / `drop trigger|policy if exists` / `on conflict`），
   中途报错可以修好后**整段重跑**；重复执行不会产生重复数据。

> 只需要执行一次。之后调参数改 `app_config` 表（见第 9 节），**不需要重新执行 init.sql**。

---

## 4. 注册第一个用户

1. 前端跑起来后打开 `/register`；
2. 填 **邮箱 + 昵称 + 密码**（不需要用户名；用户名句柄由数据库触发器自动生成）；
3. 触发器会自动写 `profiles` 和 `user_handles`，注册成功后自动登录。

> 建议先注册你自己的账号，再执行第 5 节把它设为管理员。

---

## 5. 设置管理员（SQL Editor 执行）

`profiles` 里没有 email / username，所以用 **auth.users 的邮箱** 或 **用户 id** 来定位。三选一：

### 方式 A：按注册邮箱（推荐）

```sql
update public.profiles p
   set role = 'admin'
  from auth.users u
 where u.id = p.id
   and lower(u.email) = lower('you@example.com');   -- 改成你的注册邮箱
```

### 方式 B：按用户 id

```sql
-- Dashboard → Authentication → Users → 点用户 → 复制 User UID
update public.profiles
   set role = 'admin'
 where id = '粘贴-user-uuid';
```

### 方式 C：按用户名句柄（仅当注册时显式传了 username）

```sql
update public.profiles p
   set role = 'admin'
  from public.user_handles h
 where h.user_id = p.id
   and h.is_current
   and h.username = '你的用户名';
```

验证：

```sql
select id, display_name, role, is_active
from public.profiles
where role <> 'user';
-- 期望 1 行，role = admin
```

说明：

- `role` 存在数据库里、**不在 JWT 里**，所以设置后刷新页面 / 重新登录就能看到管理入口，不用重新签发 token。
- 想设版主：`role = 'moderator'`（能删帖/置顶/锁帖/处理举报，**不能**封禁、改角色、看用户管理）。
- 撤销管理员：`update public.profiles set role = 'user' where id = '...';`
- 管理员也不能随便改计数 / 置顶：必须走 RPC（`admin_set_pinned` 等）。

---

## 6. 前端环境变量

`campus-forum-app/.env.local`：

```bash
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...（anon public key）
```

只放 anon key。`service_role` 一旦进前端就等于把数据库完全交出去。

---

## 7. 验收自检 SQL

> 对应 `docs/验收清单.md` M0 段。**建议逐段在 SQL Editor 单独执行**（预期报错的语句别和正常语句放一起）。
> `init.sql` 末尾第 11 节也以注释形式附了一份精简版。

### 7.1 结构自检

```sql
-- ① 11 张表 + RLS 全开（期望 11 行，rowsecurity 全 true）
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

-- ② 管理员视图存在（期望 1 行 VIEW）
select table_name, table_type
from information_schema.tables
where table_schema = 'public' and table_name = 'admin_profiles';

-- ③ 枚举（notification_type 必须含 follow_post）
select enumlabel
from pg_enum
where enumtypid = 'public.notification_type'::regtype
order by enumsortorder;

-- ④ profiles 不能有 password / username / email / anonymous_name（期望 0 行）
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
  and column_name in ('password', 'username', 'email', 'anonymous_name');

-- ⑤ 函数清单（34 个；security definer 的 prosecdef = true）
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname;

-- ⑥ RLS 策略清单（19 个）
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- ⑦ 外键默认名（前端嵌入查询依赖）
select conname from pg_constraint
where conrelid = 'public.posts'::regclass and contype = 'f';
-- 期望 posts_author_id_fkey / posts_board_slug_fkey
select conname from pg_constraint
where conrelid = 'public.comments'::regclass and contype = 'f';
-- 期望 comments_author_id_fkey / comments_post_id_fkey / comments_parent_id_fkey

-- ⑧ 种子：5 个板块、5 条配置
select slug, name, sort_order, is_locked from public.boards order by sort_order;
select key, value from public.app_config order by key;
```

### 7.2 权限自检（模拟匿名 / 登录用户）

SQL Editor 默认以 `postgres` 身份运行（绕过 RLS），所以要在事务里切换身份：

```sql
-- 模拟匿名用户
begin;
set local role anon;
select count(*) as boards from public.boards;        -- 期望 5
select count(*) as posts  from public.posts;         -- 期望 0（空库；不是报错）
select count(*) as comments from public.comments;    -- 期望 0
commit;   -- 或 rollback;
```

**预期报错**（单独执行，看到 `42501 permission denied` 即正确）：

```sql
-- ① 匿名读 profiles 的 role → 列级 GRANT 未授权 → 42501
set role anon;
select role from public.profiles limit 1;
reset role;
```

```sql
-- ② 普通登录用户改自己的 role → 列级权限拒绝 → 42501
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<你的用户-uuid>","role":"authenticated"}';
update public.profiles set role = 'admin' where id = auth.uid();  -- 期望 42501
rollback;
```

```sql
-- ③ 普通登录用户直接写明细表 → 无 INSERT 权限 → 42501
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<你的用户-uuid>","role":"authenticated"}';
insert into public.post_votes (post_id, user_id, value) values (gen_random_uuid(), auth.uid(), 1);  -- 期望 42501
rollback;
```

```sql
-- ④ 普通登录用户 select('*') profiles → 42501（所以前端必须显式列！）
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<你的用户-uuid>","role":"authenticated"}';
select * from public.profiles limit 1;   -- 期望 42501
rollback;
```

### 7.3 业务函数自检（模拟登录用户，最后 rollback 不脏数据）

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<你的用户-uuid>","role":"authenticated"}';

-- ① 发帖（期望成功，记下返回的 id）
insert into public.posts (board_slug, title, content)
values ('chat', '自检帖', '这是一条自检内容')
returning id;

-- ② 点赞（把 <post-id> 换成上面返回的 id；期望 like_count=1, my_vote=1）
select * from public.vote_post('<post-id>', 1);

-- ③ 再点一次（同值 = 取消；期望 like_count=0, my_vote=null）
select * from public.vote_post('<post-id>', 1);

-- ④ 收藏（期望 favorited=true, favorite_count=1）
select * from public.toggle_favorite('<post-id>');

-- ⑤ 评论（期望成功；comment_count +1。自己的帖子不会给自己发通知）
insert into public.comments (post_id, content) values ('<post-id>', '自检评论');

-- ⑥ 我的资料 / 作者资料
select * from public.my_profile();
select * from public.author_profile('<你的用户-uuid>');

-- ⑦ 搜索（期望能搜到「自检帖」；搜 "100%" 不报错）
select id, title, author_display_name from public.search_posts('自检', null, 'new', 10, 0);
select count(*) from public.search_posts('100%', null, 'new', 10, 0);

rollback;   -- 回滚，不污染数据库
```

越权测试（用两个账号，或直接用 REST + 两个 JWT）：

- 用户 B 调 `soft_delete_post(A 的帖子)` → 「无权删除该帖子」；
- 用户 B `PATCH /rest/v1/posts?id=eq.<A的帖子>` body `{"title":"x"}` → 影响 0 行；
- 用户 A `PATCH /rest/v1/profile?id=eq.<自己>` body `{"role":"admin"}` → 42501；
- 用户 A `POST /rest/v1/follows` → 42501。

### 7.4 REST 自检（用 anon key，不经过前端）

PowerShell：

```powershell
$url = "https://xxxx.supabase.co"
$key = "<anon-key>"
$h = @{ apikey = $key; Authorization = "Bearer $key" }

# 板块：期望 5 条
Invoke-RestMethod "$url/rest/v1/boards?select=slug,name,accent&order=sort_order" -Headers $h

# 帖子：期望 []（空库；不是报错）
Invoke-RestMethod "$url/rest/v1/posts?select=id,title&is_deleted=eq.false" -Headers $h

# 下面这句期望 42501（profiles 只开放公开列，匿名不能 select *）——PowerShell 会抛异常
Invoke-RestMethod "$url/rest/v1/profiles?select=*" -Headers $h
```

```powershell
# 匿名写帖子：期望 401/403
Invoke-RestMethod "$url/rest/v1/posts" -Method Post -Headers $h `
  -ContentType 'application/json' -Body '{"board_slug":"chat","title":"x","content":"y"}'
```

---

## 8. 常见错误与排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `PGRST205 Could not find the table 'public.xxx' in the schema cache` | init.sql 没执行 / 执行到了别的项目 / PostgREST 缓存没刷新 | 确认 Project URL 是同一个项目；重跑 init.sql；执行 `notify pgrst, 'reload schema';` 后刷新 Dashboard |
| `42P01 relation "public.boards" does not exist` | 同上，或脚本只跑了一部分 | 整段重跑 init.sql（幂等） |
| `42710 duplicate_object` / `42P07 relation already exists` | 之前跑过部分脚本，新脚本想重造类型/表但定义不同 | 先整段重跑一次（幂等能修复大部分）；若仍冲突，建议**新建 Supabase 项目**重跑（见第 10 节） |
| 前端 `42501 permission denied for table profiles` | 前端对 `profiles` 用了 `select('*')` | 改成显式 5 列（见契约 1.1）；管理员用户列表用 `admin_profiles` 视图 |
| 前端 `42501 permission denied for table post_votes / favorites / follows` | 前端直接写明细表 | 必须走 RPC（`vote_post` / `toggle_favorite` / `toggle_follow`） |
| `42501 permission denied for function xxx` | 调用了内部函数（触发器函数）或脚本没跑完 | 前端只调契约第 4 节列出的 RPC；重跑 init.sql |
| `PGRST202 Could not find the function public.xxx(...)` | 参数名 / 个数与数据库不一致，或缓存没刷新 | 对照契约第 4 节签名（参数名必须完全一致）；`notify pgrst, 'reload schema';` |
| 注册返回 `Database error saving new user` | `handle_new_user` 触发器报错（脚本没跑、display_name 超长、auth 触发器缺失等） | 先确认 init.sql 全绿执行；`select tgname from pg_trigger where tgrelid = 'auth.users'::regclass;` 应有 `on_auth_user_created`；到 Dashboard → Logs → Postgres 看具体错误 |
| 注册成功但 `profiles` 没数据 | 触发器没建 / 建在旧项目 / 用户是建触发器之前注册的 | 执行第 10.3 节补数据 SQL |
| 注册后没有 session / 收不到确认邮件 | 邮箱确认没关 | Dashboard → Authentication → Providers → Email → 关闭 Confirm email |
| 前端 401 / `PGRST301` / `JWT expired` | anon key 填错、项目 URL 不匹配、token 过期 | 核对 `.env.local`；重新登录 |
| `new row violates row-level security policy` | 被 RLS 拦（改别人的行、被封禁、板块锁定等）；或 author_id 触发器缺失 | 一般应看到更具体的中文提示；检查 init.sql 是否完整执行 |
| 发帖报「当前暂不支持上传图片（单帖最多 0 张）」 | 前端传了 `images` 非空 | 按简化口径不传图片：`images: []` 或不传；要开图片见第 9 节 |
| 举报第二次提交报 `23505 duplicate key ... reports_unique_idx` | 同一人对同一对象只能举报一次 | 前端捕获 23505 → 提示「你已经举报过了」 |
| 管理后台用户列表为空 / 403 | 当前账号不是 `admin`（moderator 也看不到，这是设计） | 执行第 5 节设管理员；刷新页面 |
| Supabase Studio 提示 **security definer view** 安全告警 | 指的是 `admin_profiles` 视图 | **有意为之**：视图以属主身份执行、内部用 `where public.is_super_admin()` 过滤，且只 `grant select` 给 authenticated；非 admin 查询返回空集。详见契约 1.12 |
| 修改 `app_config` 后限额没变化 | 改错了列 / JSON 不合法 | `value` 必须是合法 jsonb 数字：`update public.app_config set value = '0' where key = 'post_cooldown_minutes';`；触发器每次执行都读表，立即生效 |
| 临时封禁到期后仍显示被封禁 | 前端只看了 `is_active`，没看 `banned_until` | 按契约 4.5 的 `isBanned` 判据：`!is_active && (!banned_until || 未来)`；数据库侧已到期自动放行 |

---

## 9. 参数调整（`app_config`）

改参数**不用重新执行 init.sql、不用重新部署**——触发器 / 函数每次执行都会读表。

```sql
-- 查看当前值
select key, value, description from public.app_config order by key;

-- 改发帖冷却（分钟）
update public.app_config set value = '10', updated_at = now()
 where key = 'post_cooldown_minutes';

-- 改 24 小时发帖上限
update public.app_config set value = '5', updated_at = now()
 where key = 'post_daily_limit';

-- 改评论上限
update public.app_config set value = '20', updated_at = now()
 where key = 'comment_daily_limit';

-- 恢复图片（仍需二期接 Storage；仅改这个值不会自动支持上传）
update public.app_config set value = '9', updated_at = now()
 where key = 'max_images_per_post';
```

当前种子值（简化口径）：

| key | 值 | 说明 |
|---|---|---|
| `post_cooldown_minutes` | `0` | 注册满 0 分钟即可发帖（不限制） |
| `post_daily_limit` | `50` | 24 小时最多 50 帖 |
| `comment_cooldown_minutes` | `0` | 评论无冷却 |
| `comment_daily_limit` | `200` | 24 小时最多 200 条评论 |
| `max_images_per_post` | `0` | 暂不支持图片（前端不传） |

---

## 10. 重新初始化 / 补数据

### 10.1 重复执行

`init.sql` 是幂等的：直接整段重跑即可。它不会清空业务数据（种子用 `on conflict do update`，
管理员关闭的板块 `is_locked` 不会被覆盖）。注意：**重跑会把 `app_config` 重置回上面的种子值**。

### 10.2 彻底重置（谨慎）

初始化脚本没有内置 `drop`。**彻底重置最稳的做法是新建一个 Supabase 项目再跑 init.sql**
（免费项目可以删掉重建）。不要在生产库上 `drop schema public cascade`。

### 10.3 已有 auth 用户但没有 profile / handle 时补数据（正常流程不会出现）

```sql
-- 补 profiles
insert into public.profiles (id, display_name)
select u.id,
       case
         when char_length(coalesce(u.raw_user_meta_data ->> 'display_name', '')) >= 2
           then left(u.raw_user_meta_data ->> 'display_name', 20)
         else '新同学'
       end
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- 补 user_handles（生成合法句柄；极小概率撞名，失败就再执行一次）
insert into public.user_handles (user_id, username, is_current)
select p.id, 'u_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8), true
from public.profiles p
where not exists (
  select 1 from public.user_handles h where h.user_id = p.id and h.is_current
);
```

---

## 11. 自检记录（本次交付）

### 11.1 自检方式

无法连接真实数据库（没有数据库密码 / service_role，按任务约束不试探），因此采用：

1. **文本级自动自检**：`supabase/tools/check-init.mjs`（不连库）
   - 解析 init.sql 里所有 `create or replace function` / `grant execute` / `create trigger` / `create policy`，
     与契约、简化口径、前端 `src/lib/api.ts` 的期望逐项比对；
2. **人工通读**：逐行核对 SQL 引用对象是否先定义、简化口径、禁止项、前端真实调用；
3. **无法自动验证的部分**（交给用户在真实 Supabase 上执行 README 第 7 节自检 SQL）。

执行：

```bash
node supabase/tools/check-init.mjs
```

### 11.2 自动自检结果（当前 33 项全部 PASS）

```
PASS  分节顺序 = 表 → 函数 → 触发器 → 权限 → RLS → 种子
PASS  RLS 策略引用的函数都已在策略之前定义
PASS  策略引用的函数定义位置均早于 RLS 区
PASS  函数数量与清单一致（34 个）
PASS  RPC 参数名 / 类型 / 默认值与契约一致
PASS  RPC 返回列名 / 顺序 / 类型与契约一致
PASS  所有 security definer 函数都设置了 set search_path = public
PASS  每条 grant execute 都能对上真实函数签名
PASS  授权矩阵正确（anon 只给 8 个公开函数，内部/触发器函数不授权）
PASS  触发器都有 drop trigger if exists 前置（共 9 个）
PASS  RLS 策略都有 drop policy if exists 前置（共 19 个）
PASS  函数体 dollar 引用成对（$$ 数量为偶数）
PASS  每个函数体 / DO 块都以 $$; 收尾
PASS  函数体之外的 SQL 括号全部平衡
PASS  profiles 不含 password / username / email / anonymous_name 列
PASS  user_handles / post_votes / favorites / follows 没有直接写权限
PASS  posts 只授权可写列（insert: board_slug/title/content/images；update: title/content/images）
PASS  profiles 列级 select 只放行公开 5 列
PASS  reports 只授权 insert(target_type,target_id,reason,detail)
PASS  reports.reporter_id 使用列默认 auth.uid()
PASS  未自定义外键约束名（保留 posts_author_id_fkey 等默认名）
PASS  权限顺序：先 revoke all，再按列 grant
PASS  4 个枚举类型与取值正确（notification_type 含 follow_post）
PASS  种子数据符合简化口径（5 板块 + 5 配置，冷却 0 / 日限额 50、200 / 图片 0）
PASS  11 张表全部 enable row level security
PASS  admin_profiles 视图包含管理后台所需全部列
PASS  admin_profiles 视图用 where public.is_super_admin() 做行级过滤（仅 admin）
PASS  admin_profiles 只授权给 authenticated（非管理员查为空集）
PASS  契约文档覆盖所有对前端暴露的 RPC
PASS  契约文档里以 public.xxx( 引用的函数都真实存在
PASS  契约文档每个 RPC 小节都列全返回列名
PASS  契约文档写死了外键默认名（posts_author_id_fkey 等）
PASS  契约文档说明了 admin_profiles 视图的用法

通过 33 项，失败 0 项
```

### 11.3 文档 ↔ SQL ↔ 前端调用 对照（人工核对）

| 前端 `src/lib/api.ts` 调用 | 数据库侧 | 结论 |
|---|---|---|
| `from('boards').select('*')` | `boards` 全表 SELECT（anon+auth） | ✅ |
| `from('posts').select(POST_SELECT)` + `is_deleted=eq.false` + `range` | `posts` 全表 SELECT + `posts_select` 策略 | ✅ |
| `author:profiles!posts_author_id_fkey(id,display_name,avatar,bio,created_at)` | 默认外键名 + profiles 公开 5 列 | ✅ |
| `from('favorites').select('post:posts!favorites_post_id_fkey(...)')` | `favorites` 只有本人行 + `favorites_post_id_fkey` | ✅ |
| `from('comments')...author:profiles!comments_author_id_fkey` / `post:posts!comments_post_id_fkey` | 默认外键名 + 列权限 | ✅ |
| `from('notifications')...actor:profiles!notifications_actor_id_fkey` / `post:posts!notifications_post_id_fkey` + `update is_read` | 默认外键名 + `grant update(is_read)` + 本人行策略 | ✅ |
| `from('reports').insert({target_type,target_id,reason,detail})` | `grant insert(4 列)` + `reporter_id default auth.uid()` + 强制 pending | ✅ |
| `from('reports').select('*, reporter:profiles!reports_reporter_id_fkey')` | 本人/管理员 SELECT 策略 + 默认外键名 | ✅ |
| `from('profiles').select('id,display_name,avatar,bio,created_at')` / `update 3 列` | 列级 SELECT 5 列 / 列级 UPDATE 3 列 + 本人行策略 | ✅ |
| `from('profiles').select('*')`（**管理员**用户列表，需改表名） | `admin_profiles` 视图（仅 admin 有行） | ⚠️ 需前端把 `.from('profiles')` 改成 `.from('admin_profiles')`（已同步 Lead） |
| `from('post_votes').select('value')` / `from('favorites').select('post_id')` | 本人行 SELECT 策略 | ✅ |
| `from('user_handles')`（个人中心显示 @handle） | 本人/管理员 SELECT 策略 | ✅ |
| `rpc('search_posts', {p_query,p_board,p_sort,p_limit,p_offset})` | 同签名；16 列返回（含 author_display_name/author_avatar） | ✅ |
| `rpc('posts_by_author', {p_user_id,p_limit,p_offset})` | 同签名；`returns setof posts` | ✅ |
| `rpc('author_profile', {p_user_id})` | 10 列（含 is_following/is_me，无 role/is_active） | ✅ |
| `rpc('my_profile')` | 11 列（含 role/is_active/banned_*/username） | ✅ |
| `rpc('my_following')` / `rpc('my_followers')`（无参调用） | 参数有默认值，空参可调；5 列 | ✅ |
| `rpc('vote_post', {p_post_id,p_value})` | 返回 like_count/dislike_count/my_vote；`0`=取消 | ✅ |
| `rpc('toggle_favorite', {p_post_id})` | 返回 favorited/favorite_count | ✅ |
| `rpc('toggle_follow', {p_target_id})` | 返回 following/follower_count | ✅ |
| `rpc('mark_all_notifications_read')` | 返回 void；另有 `mark_notification_read` 兜底 | ✅ |
| `rpc('soft_delete_post')` / `rpc('soft_delete_comment')` | 作者或管理员；软删 + 计数联动 | ✅ |
| `rpc('admin_set_active' / 'admin_set_pinned' / 'admin_lock_post' / 'admin_soft_delete_post' / 'admin_resolve_report')` | 同名同参数；封禁仅 admin，其余 moderator+admin | ✅ |
| 管理员删评论 | `admin_soft_delete_comment(p_comment_id)`（新增） | ✅ |
| `is_admin()` / `is_super_admin()`（UI 显隐） | 可调，返回 boolean | ✅ |

### 11.4 已知限制 / 需要注意（未解决项如实列出）

1. **没有在真实 Supabase 上跑过**：本环境无数据库凭据，只做了文本级 + 逻辑核对。
   请用户执行后跑 README 第 7 节的自检 SQL，重点看：11 张表 RLS 开启、34 个函数存在、5 板块 5 配置、管理员角色。
2. **Supabase Studio 可能对 `admin_profiles` 报 security definer view 告警**：这是有意的（见第 8 节最后一行）。
3. **验收清单 M0「anon 查 profiles 返回 `[]`（RLS 拦掉）」「anon 查 user_handles 返回 `[]`」两处与实现有偏差**：
   - v2.5 起 `profiles` 公开可读：anon 能读公开 5 列，`select('*')` 会报 42501（不是 `[]`）；
   - `user_handles` 按设计方案 11.2 只给 `authenticated` 授权，anon 直接查会 401/403（不是 `[]`）。
   两者的安全目标（拿不到 role / username）都达到了，以 v2.5 / 本契约为准。
4. **临时封禁到期后 `is_active` 仍是 `false`**（历史标记不自动改）。恢复判据靠 `banned_until` 与 `is_active_user()`，
   前端 `isBanned` 已按同一判据实现；管理后台展示建议把「已到期」的显示为正常而不是已封禁。
5. **`posts_by_author` 返回 `setof posts`，不带 author 嵌入**；作者主页卡片如需显示作者，用 `author_profile` 的结果补。
6. **`reports.target_id` 没有外键**（可指向 post / comment / user 三种），举报内容需按 `target_type + target_id` 二次查询，不能直接 embed。
7. **图片 / 用户名登录 / Storage 按简化口径未做**：`user_handles` 仅用于展示 `@handle`，不参与登录；
   `posts.images` 前端传非空会被触发器拒绝（中文提示）。
8. **`handle_new_user` 对 metadata 里的 username 做「合法且未被占用才用，否则自动生成」**：
   前端如果想保留用户输入的用户名，注册前应先调 `username_available` 预检查；注册后实际句柄以
   `my_profile().username` 为准。

---

## 12. 数据库对象速查

- **表（11）**：`profiles`、`user_handles`、`boards`、`posts`、`comments`、`post_votes`、`favorites`、`follows`、`notifications`、`reports`、`app_config`
- **视图（1）**：`admin_profiles`（仅 admin 有行）
- **枚举（4）**：`user_role`、`report_status`、`report_target`、`notification_type`
- **RPC（对前端开放 26 个）**：
  - 公开（anon 可调）：`username_available`、`search_posts`、`posts_by_author`、`author_profile`
  - 登录：`vote_post`、`toggle_favorite`、`toggle_follow`、`soft_delete_post`、`soft_delete_comment`、
    `mark_all_notifications_read`、`mark_notification_read`、`my_profile`、`my_following`、`my_followers`
  - 管理：`admin_set_role`、`admin_set_active`、`admin_set_pinned`、`admin_lock_post`、
    `admin_soft_delete_post`、`admin_soft_delete_comment`、`admin_resolve_report`、`recount_posts`
  - UI 辅助：`is_admin`、`is_super_admin`、`is_active_user`（均返回 boolean）
- **内部函数（不对外授权）**：`handle_new_user`、`prepare_post_insert`、`prepare_comment_insert`、
  `sync_comment_count`、`notify_on_comment`、`notify_followers_on_post`、`touch_updated_at`、`cfg_int`
- **触发器（9）**：profiles/posts/comments 的 `updated_at`、`on_auth_user_created`、发帖/评论的
  `prepare_insert`、`trg_comments_sync_count`、`trg_comments_notify`、`trg_posts_notify_followers`
- **RLS 策略（19）**：见自检 7.1 ⑥

## 数据导出与备份

```bash
npm run db:export                                # 导出到 ./backups/<时间戳>（JSON）
npm run db:export -- --format both               # 同时导出 CSV
npm run db:export -- --out D:\bak\snapshot       # 指定目录
npm run db:export:verify -- backups/<时间戳>      # 校验完整性（sha256 + 行数）
```

`manifest.json` 会记录每张表的行数、列名、文件 SHA-256 与 PostgreSQL 版本，便于事后核对。
默认不导出 `encrypted_password`，需要完整还原登录凭据时加 `--with-password-hashes`（敏感）。

## 图片存储（ImgBB 图床）

论坛**不在数据库里存图片二进制**，只用 `posts.images text[]` 存 ImgBB 的图片直链：

```
浏览器选图 → POST https://api.imgbb.com/1/upload?key=*** → 返回 display_url
          → posts.images 里存 URL → 卡片/详情页直接 <img src>
```

环境变量 `VITE_IMGBB_API_KEY`（见 `.env.example`）。单帖上限由 `app_config.max_images_per_post` 控制（当前 4）。

> 注意：密钥会打进前端包，任何访客都能读到。要藏住密钥需要改成 Supabase Edge Function 代理上传。
