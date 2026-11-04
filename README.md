# 校园论坛（树洞）v1

一个面向同校同学的轻量校园论坛：发帖、评论、点赞/踩、收藏、关注、通知、举报、管理后台。
前端是纯静态站点（可部署到 GitHub Pages / 任意静态托管），数据与权限全部在 Supabase。

> 设计文档：`docs/设计方案.md`（v2.5）、验收清单：`docs/验收清单.md`。
> 本仓库是设计文档落地的 **v1 简化实现**，差异见下文「与设计文档的差异」。

## 设计规范（三期视觉重做）

全站统一的设计令牌集中在 `src/index.css` 的 `@theme` 里，页面只组合工具类，不再散落魔法值：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--color-canvas` | `#f4f6fb` | 全局柔和浅灰蓝背景 |
| `--color-hairline` / `-strong` | `#eceff5` / `#e1e6f0` | 极浅描边，替掉生硬黑边 |
| `--color-ink` / `-soft` / `-muted` | `#1b2130` / `#4b5563` / `#9aa4b4` | 标题 / 正文 / 辅助三级文字 |
| `--radius-card` / `--radius-control` | `16px` / `12px` | 卡片 / 按钮输入框 |
| `--shadow-card` / `--shadow-lift` / `--shadow-float` | 柔和扩散阴影 | 静止卡片 / 悬浮 / 浮层 |

布局：整体是「固定外壳 + 内部滚动」——顶栏和左侧导航固定不动，只有内容区滚动；
顶栏与左侧导航共用白色外壳（中间无分割线），内容区左上角有 22px **内凹圆角**，并有顶栏/侧栏投向内容区的 `inset` 内阴影（方向朝内，不是内容区外阴影），滚动时圆角与阴影都保持固定；
选中项用**淡彩色底**（`bg-blue-50` + 主色文字）而不是白胶囊。

复用类（`src/index.css` 里的 `@utility`）：

- `.card`：白底 + 16px 圆角 + 极浅描边 + `0 4px 12px rgba(17,24,39,.05)` 阴影
- `.pill`：胶囊标签（板块分类、状态标记）

交互约定：帖子卡片 `hover:-translate-y-0.5` + 阴影加深；点赞/评论按钮 hover 变主色并加浅底；
侧边栏菜单项 hover 白底 + 主色文字，当前项白底 + 描边 + 阴影；侧栏隐藏滚动条（`.no-scrollbar`，仍可滚轮滚动）。

帖子列表：响应式瀑布流 —— 手机 1 列（一条独占一行）、≥640 两列、≥1024 三列、≥1280 四列、≥1536 五列。分列算法是「高度均衡贪心」：按顺序遍历帖子，每条都放进**当前累计高度最矮**的那一列（首轮用文案长度估算高度，渲染后回填实测高度再校正一次），因此列高差被压在一张卡片以内；卡片高度随内容自适应，多列下使用紧凑排版（`PostCard dense`）。

排版约定：帖子标题 `17px/600` 深灰；正文 `14px` 中灰、行高 `1.7`；作者与时间等辅助信息 `12px` 浅灰；
卡片内边距 `p-5 sm:p-6`（20–24px），卡片间距 `space-y-5`。
## 部署到 GitHub Pages

项目**没有自建后端**：数据库 / 认证 / 权限 / 实时推送都在 Supabase 云上，前端是纯静态产物（`dist/` 里只有 index.html + js + css）。
路由用 `HashRouter`，`vite.config.ts` 里 `base: './'`，所以放在 `https://<用户名>.github.io/<仓库名>/` 这种子路径下也能正常加载，不需要 404 回退规则。

### 1. 在仓库里配置 Secrets

`Settings → Secrets and variables → Actions → New repository secret`，添加三项：

| Secret | 取值 |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<项目 ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Settings → API 的 anon / publishable key |
| `VITE_IMGBB_API_KEY` | ImgBB 图床密钥（可选，不填则发帖不能传图） |

> 这三个是**构建期**变量，会被打进 JS 包里。`.env.local` 在 `.gitignore` 里，**不会**进仓库，所以线上必须靠 Secrets 注入。

### 2. 打开 Pages

`Settings → Pages → Build and deployment → Source` 选 **GitHub Actions**。
工作流 `.github/workflows/deploy.yml` 会在 push 到 `main` 时自动构建并发布。

工作流里带一道硬校验：产物里必须有 `supabase.co` 域名和 anon key，且不能是占位地址 —— 少配 Secret 会直接让部署失败，不会上线一个白屏站点。

### 3. 填 Supabase 的跳转白名单

`Supabase → Authentication → URL Configuration`：

- **Site URL**：`https://<用户名>.github.io/<仓库名>/`
- **Redirect URLs**：追加 `https://<用户名>.github.io/<仓库名>/`

不填的话登录、发帖、浏览都正常，但**找回密码的邮件链接会跳到 localhost**（打不开）。

### 4. 数据库

用一个 Supabase 项目，在 SQL Editor 里执行 `supabase/init.sql`（或本地 `npm run db:migrate`）建表、策略、RPC、Realtime 发布。

### 常见问题

| 现象 | 原因 |
| --- | --- |
| 页面显示「缺少运行配置」 | Secrets 没配或名字拼错；工作流已因此失败 |
| 打开是白屏 | 用旧包或缺配置，看 Actions 构建日志 |
| 能登录但找回密码跳 localhost | Supabase Redirect URLs 没加 Pages 域名 |
| 图片传不上去 | 没配 `VITE_IMGBB_API_KEY`（其余功能不受影响） |
| 过几天打不开 | Supabase 免费项目 7 天无活动会被暂停，去 Dashboard 恢复 |

### 关于密钥暴露

`anon key` 和 ImgBB key 都会出现在前端包里 —— 这是静态站点的固有性质。
`anon key` 本身安全（所有权限由 RLS 兜底）；ImgBB key 是**真钥匙**，别人可以拿去传图消耗额度。
要藏住它，需要把上传改走 Supabase Edge Function 代理（前端只调函数，key 存在函数的环境变量里）。

## 数据备份 / 导出

```bash
# 导出一份快照（默认 ./backups/<时间戳>，JSON）
npm run db:export

# 同时导出 CSV（Excel 可直接打开）
npm run db:export -- --format both

# 指定输出目录
npm run db:export -- --out D:\bak\2026-11-03

# 校验一个已有备份（文件完整性 + 行数 + sha256）
npm run db:export:verify -- backups/20261103-083614
```

导出内容：`public` schema 下**所有业务表**（表名从 `pg_tables` 自动发现，新增表无需改脚本）+ `auth.users` 基础字段；
每张表一个文件，`manifest.json` 记录行数、列名、SHA-256 与数据库版本。

> 默认**不导出密码哈希**。需要完整还原登录凭据时加 `--with-password-hashes`，并务必把备份目录当机密保存。
> 还原是手工流程：新库执行 `supabase/init.sql` 后，按「被引用表在前」的顺序导入 JSON。
## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19 + TypeScript 5 + Vite 8 |
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`，无 config 文件） |
| 路由 | React Router 7（HashRouter，静态托管无需 404 回退） |
| 数据 | TanStack Query 5（服务端状态）+ @supabase/supabase-js 2 |
| 后端 | Supabase（PostgreSQL + Auth + RLS + RPC），不维护自建服务器 |
| 图标 / 提示 | lucide-react / sonner |

## 目录结构

```
campus-forum-app/
├─ docs/                    # 设计方案、验收清单、数据库接口契约
├─ supabase/
│  ├─ init.sql              # 一次性建库脚本（SQL Editor 整段执行）
│  └─ README.md             # 建库步骤、设管理员、自检 SQL、常见错误
├─ src/
│  ├─ lib/                  # supabase client、api 数据层、auth、格式化、常量
│  ├─ types/db.ts           # 与数据库表/RPC 对齐的类型
│  ├─ components/           # Layout、PostCard、ui、RequireAuth
│  └─ pages/                # 首页/详情/发帖/登录/注册/个人中心/作者页/通知/规则/管理后台
├─ .env.local               # Supabase URL + publishable key（本地用，不提交）
└─ package.json
```

## 快速开始

### 1. 初始化数据库（只做一次）

1. 打开 Supabase Dashboard → 你的项目 → 左侧 **SQL Editor**；
2. 把 `supabase/init.sql` **整个文件**粘贴进去 → 点 **Run**；
3. 看到 `Success. No rows returned` 即可（脚本末尾会输出板块与配置的查询结果）。

详细步骤、建管理员、验收查询见 [`supabase/README.md`](./supabase/README.md)。

### 2. 配置环境变量

`.env.local` 已填好本项目的 URL 与 publishable key：

```bash
VITE_SUPABASE_URL=https://xxxx.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_xxx
```

> 这里只能用 **publishable / anon** key。`service_role` key 绝不能进前端。
> 安全边界在数据库：RLS + 列级 GRANT + RPC 三层防线，前端隐藏按钮不算安全。

### 3. 本地运行

```bash
npm install        # 首次
npm run dev        # http://127.0.0.1:5173，同时可用 http://<本机IP>:5173
```

构建与预览：

```bash
npm run build      # 产物在 dist/，纯静态
npm run preview    # 预览构建产物（8080）
npm run lan        # 构建 + 以 0.0.0.0:8080 启动，供同局域网设备访问
```

> 局域网测试用 `npm run lan`，同网段设备访问 `http://<本机IP>:8080/`。
> 本机 80 端口被其他程序占用，所以用 8080；需要放行防火墙时见 `docs/使用说明.md`。

### 4. 注册并设置管理员

1. 打开站点，点右上角「注册」，用邮箱注册（本项目后台已开启「跳过邮箱确认」，注册完直接是登录态）；
2. 回到 Supabase SQL Editor，执行（把邮箱换成你注册的）：

```sql
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'you@example.com');
```

3. 刷新页面，右上角头像菜单里会出现「管理后台」，地址是 `/#/admin`。

### 5. 自动化验收（可选，但推荐）

建库完成后，在 `campus-forum-app` 目录执行：

```bash
node scripts/verify-db.mjs
```

它会自动检查：表与种子、anon 能读什么/不能写什么、注册两个临时账号走完
发帖→评论→点赞→收藏→关注→通知→搜索→软删，并验证越权（改 role、改计数、直写明细表、调管理员 RPC）全部被数据库拦住。
全部通过会打印「结果：通过 N，失败 0」。测试账号形如 `verify.a+xxx@example.com`，可在 Authentication → Users 里删除。


## 已实现功能（v1）

- 账号：邮箱注册 / 登录 / 退出 / 会话保持 / 修改昵称、**自定义头像（180+ 图标 × 20 套渐变背景，还可取色器自定义两色）**、简介
- 板块：校园闲聊、学习求助、表白墙、失物招领、交友脱单
- 帖子：列表（最新 / 最热、板块筛选、**时间筛选：今天 / 近 3 天 / 近 7 天 / 近 30 天 / 自定义日期区间**、分页）、详情、发帖、删除自己的帖子
- 互动：点赞 / 踩（RPC 原子更新计数）、**列表卡片直接点赞**、**评论点赞（点一次 +1，再点取消，刷新保持）**、收藏、评论、**回复评论（楼中楼）**、删除自己的评论
- 搜索：标题 + 正文（RPC，已转义 `% _ \`）
- 关注：关注 / 取关、作者主页（帖子、粉丝、关注数）
- 通知：评论通知、**回复通知（type=reply，通知被回复的人）**、关注的人发新帖、**侧边栏「通知」红色未读角标（带数量）**、**打开通知页自动全部已读**、全部已读按钮
- 举报：帖子 / 评论 / 用户，管理员处理（已处理 / 驳回）
- 反馈：**意见反馈页**（建议 / 问题 / 其他 + 可选联系方式 + 「我的反馈」处理进度）；管理员在「管理后台 → 反馈」查看全部、筛选、标记已处理
- 好友：**搜人加好友**（昵称 ≥2 字，防遍历）、好友申请同意/拒绝、删好友、拉黑（拉黑后对方无法发私信）
- 图片：**发帖可传图**（最多 4 张，单张 ≤ 8MB），图片存到 ImgBB 图床，数据库只存 URL；卡片显示首图缩略图，详情页点击看原图
- 备份：**一键数据导出**（`npm run db:export`）→ 生成带行数与 SHA-256 的快照目录（JSON + 可选 CSV），`--verify` 可校验完整性
- 实时：**Supabase Realtime** 推送通知与私信（WebSocket），断线自动退回轮询兜底，侧边栏有连接状态提示
- 私信：**1 对 1 聊天**（只有双向好友能发，3 秒轮询近实时）、会话列表 + 未读数、侧边栏好友/私信红点
- 密码：**个人中心「修改密码」**（先验证当前密码，改完其它设备登出）+ **找回密码**（登录页「忘记密码？」→ 邮件重置链接 → `/#/reset-password` 设新密码，含失效链接兜底页）
- 管理后台：**举报可直接点进被举报的帖子 / 评论（评论会自动滚动定位并高亮）、展示被举报评论内容**、帖子（置顶 / 锁帖 / 删除）、用户（封禁 / 解封）、**违禁词词库（增删查）**、**意见反馈（查看 / 标记处理）**
- 内容安全：**违禁词检测**——发帖标题/正文、评论、昵称、用户名命中词库就直接拒绝并给中文提示；忽略大小写与空白（`F U C K` 也会被拦），词库由管理员在后台维护
- 安全：RLS + 列级 GRANT + RPC；`post_votes` / `favorites` / `follows` 前端不可直写；
  `profiles` 只公开昵称/头像/简介，`role` / 封禁信息仅本人和管理员可见

## 与设计文档的差异（v1 简化口径）

| 项 | 设计文档 v2.5 | 本实现 v1 |
|---|---|---|
| 用户名登录 | Edge Function `login` | **未做**，只用邮箱登录；用户名（`user_handles`）注册时自动生成，为二期预留 |
| 图片 | Storage 上传 ≤9 张 | **未做**，`posts.images` 字段保留，图片上传是下一步 |
| 发帖/评论限额 | 注册 10 分钟后可发帖 | 保留机制，种子值放宽为 0 分钟 / 单日 50 帖 / 200 评论（可在 `app_config` 调整） |
| 匿名 | v2.5 已取消匿名 | 一致：显示昵称 |
| 好友 / 私信 / Realtime | 二期 | 未做 |

## 当前部署状态（2026-11-01）

- Supabase 项目：`qkdyfrwsiikluyaristy`（Tokyo / ap-northeast-1）
- 数据库：已执行 `supabase/init.sql`，文本级自检 `node supabase/tools/check-init.mjs` 33/33 通过
- 认证：已关闭「Confirm email」（注册即登录）
- 访问控制：**未登录访问任何页面都会先跳到登录/注册页**（`/rules` 除外），登录后回到原页面
- 首个账号 `3806133211@qq.com` 已设为管理员
- 局域网测试地址：`http://172.17.41.64:8080/`（`npm run lan`）
- 本地开发地址：`http://127.0.0.1:5173`

## 验收记录

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | 通过（0 错误） |
| `npm run build` | 通过（dist 纯静态） |
| `node supabase/tools/check-init.mjs`（init.sql 文本自检：函数清单/参数/授权/RLS/表数/契约覆盖） | **33 / 33 通过** |
| `npm run db:verify`（142 项：结构/RLS/RPC/越权/楼中楼/时间筛选/评论点赞/违禁词/意见反馈/安全加固/好友私信/Realtime 授权） | **152 / 152 通过** |
| `npm run e2e:auth-gate`（登录网关：未登录跳转/注册/退出/重新登录） | **11 / 11 通过，控制台 0 错误** |
| `npm run e2e:ui`（浏览器：注册→**昵称违禁词拦截**→发帖→**发帖违禁词拦截**→评论→**评论违禁词拦截**→**回复评论**→**评论点赞**→点赞→**列表点赞**→收藏→**时间筛选**→**通知红点**→**自动已读**→**自定义头像**→**提交意见反馈**→个人中心→管理后台→**违禁词增删**→**反馈查看与标记处理**→移动端） | **38 / 38 通过，控制台 0 错误** |
| `npm run e2e:admin-report`（管理后台：举报评论→跳转帖子→定位高亮） | **10 / 10 通过** |
| `npm run e2e:password`（修改密码 / 找回密码：格式校验→发送重置→当前密码校验→改密→旧密码失效→重置链接→失效链接兜底） | **19 / 19 通过，控制台 0 错误** |
| `npm run e2e:friends`（好友 / 私信 / **Realtime**：搜人→加好友→同意→私信→**即时收到回复与通知红点**→删好友→非好友禁发） | **31 / 31 通过，控制台 0 错误** |
| `npm run e2e:backup`（数据导出：快照生成→行数比对→完整性校验→**篡改检测**） | **11 / 11 通过** |

页面截图（验收时自动生成）：

| 登录页（未登录第一屏） | 论坛首页（侧边导航贴左、内容列居中） |
|---|---|
| ![登录页](./docs/screenshots/01-login-page.png) | ![首页](./docs/screenshots/03-home.png) |
| **帖子详情** | **个人中心** |
| ![帖子详情](./docs/screenshots/05-post-detail.png) | ![个人中心](./docs/screenshots/09-profile.png) |

| 管理后台 |
|---|
| ![管理后台](./docs/screenshots/10-admin.png) |

![移动端](./docs/screenshots/12-mobile-home.png)

![首页筛选栏：最新/最热 + 时间选项同一行](./docs/screenshots/29-home-filters.png)

![通知未读角标](./docs/screenshots/13-notification-badge.png)

![打开通知页自动已读](./docs/screenshots/15-notification-auto-read.png)

![回复评论（楼中楼）](./docs/screenshots/14-comment-replies.png)

![自定义头像编辑器](./docs/screenshots/16-avatar-editor.png)

![管理后台：举报跳转并高亮被举报评论](./docs/screenshots/18-admin-report-jump.png)

![首页时间筛选（近 7 天）](./docs/screenshots/19-time-filter.png)

![自定义时间区间（空结果提示）](./docs/screenshots/19b-time-filter-custom.png)

![评论点赞（赞数变蓝并 +1）](./docs/screenshots/20-comment-liked.png)

![发帖命中违禁词：就地提示，不提交](./docs/screenshots/21-banned-word-blocked.png)

![管理后台：违禁词词库增删](./docs/screenshots/22-admin-words.png)

![意见反馈：提交后「我的反馈」立即出现（待处理）](./docs/screenshots/23-feedback-page.png)

![管理后台：反馈列表（可筛选、标记已处理）](./docs/screenshots/24-admin-feedback.png)

![用户端同步显示「已处理」](./docs/screenshots/25-feedback-resolved.png)

![好友页：我的好友 / 好友申请 / 找人](./docs/screenshots/30-friends.png)

![私信：微信式布局（保留论坛侧边栏 / 左列表白底 / 右聊天浅灰 / 贴边无白框）](./docs/screenshots/31-messages.png)

![私信：移动端聊天](./docs/screenshots/33-chat-mobile.png)

![私信：移动端会话列表](./docs/screenshots/34-message-list.png)

![找回密码：输入邮箱](./docs/screenshots/26-forgot-password.png)

![个人中心：修改密码弹窗](./docs/screenshots/27-change-password.png)

![重置密码：设置新密码](./docs/screenshots/28-reset-password.png)

> 截图里的「UI 验收帖」是自动化验收创建的测试内容，验收完已随测试账号一起清理。

## 常见问题

- **页面报「数据库还没有初始化」**：说明 `init.sql` 还没执行，或执行失败；按 `supabase/README.md` 重跑。
- **注册报「Database error saving new user」**：多半是 `handle_new_user` 触发器报错（例如昵称长度不合法），看 Supabase → Logs → Postgres 日志。
- **发帖/评论返回英文错误**：数据库里的 `raise exception` 文案是中文的，会直接展示；如果是 PostgREST 错误，检查 RLS 与 GRANT。
- **免费项目 7 天无请求会被暂停**：每周打开一次站点即可（或按设计文档加 GitHub Actions 定时 ping）。
