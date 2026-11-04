/**
 * UI 端到端验收（需要先启动带 CDP 的 Chrome，见 README）。
 *
 * 1) 启动 Chrome：
 *    "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9333 --user-data-dir=<workspace>\.chrome-profile --window-size=1440,900 about:blank
 * 2) 运行：node scripts/e2e-ui.mjs
 *
 * 会用数据库直连把测试账号提升为管理员（只影响 campus.forum.e2e.* 这个测试账号）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5173'
const CDP = process.env.CHROME_CDP ?? 'http://127.0.0.1:9333'
const SHOTS = resolve(process.cwd(), '.shots')
mkdirSync(SHOTS, { recursive: true })

const suffix = Date.now().toString(36).slice(-5)
const EMAIL = `campus.forum.e2e.${suffix}@gmail.com`
const BANNED_EMAIL = `campus.forum.e2e.banned.${suffix}@gmail.com`
const PASSWORD = `E2e-${suffix}-Pw1`
const DISPLAY = `验收同学${suffix.slice(-2)}`
const TITLE = `UI 验收帖 ${suffix}`
const CONTENT = '这是自动化 UI 端到端验收创建的帖子，用来验证发帖、评论、点赞、收藏、管理后台等页面。'

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? ` —— ${detail}` : ''}`)
}

async function shot(page, name) {
  const path = resolve(SHOTS, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  console.log(`  📸 ${name}.png`)
}

async function clickByText(page, selector, text) {
  const handles = await page.$$(selector)
  for (const h of handles) {
    const t = (await page.evaluate((el) => el.textContent ?? '', h)).trim()
    if (t.includes(text)) {
      await h.click()
      return true
    }
  }
  return false
}

/** 给 <input type="date"> 赋值（绕过 React 受控组件的 value tracker）。 */
async function setDateValue(page, selector, value) {
  return page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel)
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    },
    selector,
    value,
  )
}

/** 读取 HashRouter 地址栏 ?key=... 的值。 */
async function hashParam(page, key) {
  return page.evaluate((k) => new URLSearchParams(location.hash.split('?')[1] ?? '').get(k), key)
}

/* ---------- 用第二个账号评论，给被验收账号制造一条未读通知 ---------- */

function loadEnv() {
  const env = {}
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* 忽略 */
  }
  return env
}

async function createUnreadNotification(postId) {
  const env = loadEnv()
  const base = env.VITE_SUPABASE_URL?.replace(/\/$/, '')
  const key = env.VITE_SUPABASE_ANON_KEY
  if (!base || !key) {
    console.log('  缺少 .env.local 配置，跳过通知测试')
    return false
  }
  const email = `campus.forum.e2e.n.${suffix}@gmail.com`
  const signup = await fetch(`${base}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, data: { display_name: `通知${suffix.slice(-2)}` } }),
    signal: AbortSignal.timeout(20000),
  })
  const session = await signup.json().catch(() => ({}))
  const token = session?.access_token
  if (!token) {
    console.log('  第二个账号注册失败:', JSON.stringify(session).slice(0, 160))
    return false
  }
  const res = await fetch(`${base}/rest/v1/comments`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ post_id: postId, content: '触发一条未读通知的评论' }),
    signal: AbortSignal.timeout(20000),
  })
  console.log(`  第二个账号评论状态: ${res.status}`)
  return res.ok
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
  // 独立浏览器上下文，避免上一次验收残留登录态
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 1440, height: 900 })

  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`)
  })
  // 删除类操作会弹 window.confirm：验收里统一确认
  page.on('dialog', (dialog) => void dialog.accept())

  /* 1. 未登录访问首页 → 应被带到登录页 */
  await page.goto(`${APP}/#/`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction(() => location.hash === '#/login', { timeout: 20000 })
  await page.waitForSelector('#email', { timeout: 15000 })
  await shot(page, '01-login-page')
  ok('未登录访问首页自动跳转登录页', true)

  /* 2. 注册（先验证昵称违禁词拦截，再正常注册） */
  await page.goto(`${APP}/#/register`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#displayName', { timeout: 15000 })

  // 2.1 昵称含违禁词：提交前就被前端拦下，不应创建账号
  await page.type('#displayName', `傻逼${suffix.slice(-2)}`)
  await page.type('#email', BANNED_EMAIL)
  await page.type('#password', PASSWORD)
  await page.type('#confirm', PASSWORD)
  await clickByText(page, 'button', '注册')
  const bannedNameBlocked = await page
    .waitForFunction(() => document.body.innerText.includes('昵称包含违禁词'), { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  const stayedOnRegister = await page.evaluate(() => location.hash === '#/register')
  ok(
    '注册昵称含违禁词被拦截',
    bannedNameBlocked && stayedOnRegister,
    `blocked=${bannedNameBlocked} stay=${stayedOnRegister}`,
  )
  await shot(page, '02b-register-banned-name')

  // 2.2 正常注册（刷新清空上一次的表单状态）
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('#displayName', { timeout: 15000 })
  await page.type('#displayName', DISPLAY)
  await page.type('#email', EMAIL)
  await page.type('#password', PASSWORD)
  await page.type('#confirm', PASSWORD)
  await shot(page, '02-register')
  await clickByText(page, 'button', '注册')
  await page.waitForFunction(
    () => location.hash === '#/' && Boolean(Object.keys(localStorage).find((k) => k.includes('auth-token'))),
    { timeout: 30000 },
  )
  // 等首页真正渲染出「发帖」按钮，别用固定 sleep（慢一点就误判）
  const loggedIn = await page
    .waitForFunction(() => document.body.innerText.includes('发帖'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  ok('注册后自动登录', loggedIn)
  await shot(page, '03-home-logged-in')

  /* 3. 发帖（先验证违禁词拦截） */
  await page.goto(`${APP}/#/new`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#title', { timeout: 15000 })

  await page.type('#title', '违禁词拦截测试')
  await page.type('#content', '正文里写「傻逼」看看会不会被拦下')
  await clickByText(page, 'button', '发布')
  const postBlocked = await page
    .waitForFunction(() => document.body.innerText.includes('包含违禁词'), { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  const stayedOnNew = await page.evaluate(() => location.hash === '#/new')
  ok('发帖含违禁词被拦截', postBlocked && stayedOnNew, `blocked=${postBlocked} stay=${stayedOnNew}`)
  await shot(page, '04b-post-banned')

  // 清空后填正常内容
  await page.click('#title')
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.type('#title', TITLE)
  await page.click('#content')
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyA')
  await page.keyboard.up('Control')
  await page.type('#content', CONTENT)
  await shot(page, '04-new-post')
  await clickByText(page, 'button', '发布')
  await page.waitForFunction(() => location.hash.startsWith('#/post/'), { timeout: 30000 })
  const createdPostId = await page.evaluate(() => location.hash.replace('#/post/', ''))
  const detailShown = await page
    .waitForFunction((title) => document.body.innerText.includes(title), { timeout: 20000 }, TITLE)
    .then(() => true)
    .catch(() => false)
  ok('发帖后进入详情页', detailShown)
  await shot(page, '05-post-detail')

  /* 4. 点赞 / 收藏 / 评论 */
  // 投票状态加载完之前「赞」按钮是禁用的（否则会把已点赞误判成未点赞而取消掉），先等它就绪
  await page
    .waitForFunction(
      () => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          b.textContent?.trim().startsWith('赞'),
        )
        return Boolean(btn) && !btn.disabled
      },
      { timeout: 15000 },
    )
    .catch(() => {})
  const likeBefore = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('赞'))
    return btn?.textContent?.trim() ?? ''
  })
  await clickByText(page, 'button', '赞')
  await new Promise((r) => setTimeout(r, 1200))
  const likeAfter = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('赞'))
    return btn?.textContent?.trim() ?? ''
  })
  ok('点赞计数变化', likeBefore !== likeAfter, `${likeBefore} -> ${likeAfter}`)

  await clickByText(page, 'button', '收藏')
  const favorited = await page
    .waitForFunction(() => document.body.innerText.includes('已收藏'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  ok('收藏按钮变为已收藏', favorited)
  await shot(page, '06-post-liked')

  const commentBox = await page.$('textarea[placeholder*="友善发言"]')
  if (commentBox) {
    // 4.0 评论违禁词拦截（不发请求，前端预检直接提示）
    await commentBox.type('傻逼评论应该被拦下')
    await clickByText(page, 'button', '发表评论')
    const commentBlocked = await page
      .waitForFunction(() => document.body.innerText.includes('评论内容包含违禁词'), { timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    ok('评论含违禁词被拦截', commentBlocked)

    // 4.1 正常评论
    await commentBox.click()
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await commentBox.type('UI 验收评论：页面交互正常。')
    await clickByText(page, 'button', '发表评论')
    await page.waitForFunction(() => document.body.innerText.includes('UI 验收评论'), { timeout: 20000 })
    ok('发表评论成功', true)
  } else {
    ok('评论含违禁词被拦截', false, '找不到评论输入框')
    ok('发表评论成功', false, '找不到评论输入框')
  }
  await shot(page, '07-comments')

  /* 4.5 楼中楼：回复评论 */
  const replyOpened = await clickByText(page, 'button', '回复')
  if (replyOpened) {
    try {
      await page.waitForSelector('textarea[placeholder*="回复 @"]', { timeout: 8000 })
      const replyBox = await page.$('textarea[placeholder*="回复 @"]')
      await replyBox.type('UI 验收回复：楼中楼正常。')
      await clickByText(page, 'button', '发送回复')
      await page.waitForFunction(
        () => document.body.innerText.includes('UI 验收回复：楼中楼正常。'),
        { timeout: 20000 },
      )
      const nested = await page.evaluate(() => document.body.innerText.includes('回复 @'))
      ok('能回复评论（楼中楼）', nested, nested ? '' : '回复已提交但没看到“回复 @”标记')
      await shot(page, '07b-comment-reply')
    } catch (err) {
      ok('能回复评论（楼中楼）', false, String(err.message ?? err).slice(0, 140))
    }
  } else {
    ok('能回复评论（楼中楼）', false, '找不到「回复」按钮')
  }

  /* 4.6 给评论点赞：评论右侧的 赞 按钮（赞 → 刷新保持 → 再点取消） */
  const commentTarget = 'UI 验收评论：页面交互正常。'
  const commentLikeSnapshot = async () =>
    page.evaluate((text) => {
      const rows = [...document.querySelectorAll('[id^="comment-"]')]
      const row = rows.find((r) => r.innerText.includes(text))
      const btn = row?.querySelector('button[data-testid="comment-like"]')
      return {
        found: Boolean(btn),
        disabled: Boolean(btn?.disabled),
        pressed: btn?.getAttribute('aria-pressed') === 'true',
        text: btn?.textContent?.trim() ?? '',
      }
    }, commentTarget)
  const clickCommentLike = async () =>
    page.evaluate((text) => {
      const rows = [...document.querySelectorAll('[id^="comment-"]')]
      const row = rows.find((r) => r.innerText.includes(text))
      const btn = row?.querySelector('button[data-testid="comment-like"]')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    }, commentTarget)

  try {
    await page.waitForFunction(
      (text) => {
        const rows = [...document.querySelectorAll('[id^="comment-"]')]
        const row = rows.find((r) => r.innerText.includes(text))
        const btn = row?.querySelector('button[data-testid="comment-like"]')
        return Boolean(btn) && !btn.disabled
      },
      { timeout: 15000 },
      commentTarget,
    )
  } catch {
    /* 下面会判失败 */
  }

  const commentLikeClicked = await clickCommentLike()
  await new Promise((r) => setTimeout(r, 1500))
  const likeSnap1 = await commentLikeSnapshot()
  ok(
    '能给评论点赞',
    commentLikeClicked && likeSnap1.pressed && likeSnap1.text.includes('1'),
    `${commentLikeClicked} ${JSON.stringify(likeSnap1)}`,
  )
  await shot(page, '07c-comment-liked')

  await page.reload({ waitUntil: 'networkidle2' })
  await page
    .waitForFunction(() => document.body.innerText.includes('UI 验收评论'), { timeout: 20000 })
    .catch(() => {})
  try {
    await page.waitForFunction(
      (text) => {
        const rows = [...document.querySelectorAll('[id^="comment-"]')]
        const row = rows.find((r) => r.innerText.includes(text))
        const btn = row?.querySelector('button[data-testid="comment-like"]')
        return Boolean(btn) && !btn.disabled && btn.getAttribute('aria-pressed') === 'true'
      },
      { timeout: 15000 },
      commentTarget,
    )
  } catch {
    /* 下面会判失败 */
  }
  const likeSnap2 = await commentLikeSnapshot()
  ok('评论点赞刷新后保持', likeSnap2.pressed && likeSnap2.text.includes('1'), JSON.stringify(likeSnap2))

  const unliked = await clickCommentLike()
  await new Promise((r) => setTimeout(r, 1500))
  const likeSnap3 = await commentLikeSnapshot()
  ok(
    '再点一次取消评论点赞',
    unliked && likeSnap3.pressed === false,
    `${unliked} ${JSON.stringify(likeSnap3)}`,
  )

  /* 5. 首页列表 */
  await page.goto(`${APP}/#/`, { waitUntil: 'networkidle2' })
  const homeHasPost = await page
    .waitForFunction(() => document.body.innerText.includes('UI 验收帖'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  ok('首页能看到新帖', homeHasPost)

  // 首页侧边栏应只选中「全部」，不能同时亮起别的项
  const homeNav = await page.evaluate(() =>
    [...document.querySelectorAll('aside nav a')]
      .filter((a) => a.className.includes('nav-item-active'))
      .map((a) => (a.textContent ?? '').trim()),
  )
  ok('首页侧边栏只选中「全部」', homeNav.length === 1 && homeNav[0] === '全部', JSON.stringify(homeNav))
  await shot(page, '08-home-with-post')

  /* 5.5 列表卡片直接点赞（等投票状态加载完再点） */
  try {
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('article button[aria-label*="点赞"]')
        return Boolean(btn) && !btn.disabled
      },
      { timeout: 15000 },
    )
  } catch {
    /* 下面会判失败 */
  }
  const listLikeBefore = await page.evaluate(() => {
    const btn = document.querySelector('article button[aria-label*="点赞"]')
    return { label: btn?.getAttribute('aria-label') ?? '', text: btn?.textContent?.trim() ?? '' }
  })
  const cardLike = await page.$('article button[aria-label*="点赞"]')
  if (cardLike) {
    await cardLike.click()
    await new Promise((r) => setTimeout(r, 2000))
    const listLikeAfter = await page.evaluate(() => {
      const btn = document.querySelector('article button[aria-label*="点赞"]')
      return { label: btn?.getAttribute('aria-label') ?? '', text: btn?.textContent?.trim() ?? '' }
    })
    ok(
      '首页列表点赞按钮可切换状态',
      listLikeAfter.label !== listLikeBefore.label,
      `${listLikeBefore.label}(${listLikeBefore.text}) -> ${listLikeAfter.label}(${listLikeAfter.text})`,
    )
    await shot(page, '08b-home-liked')
  } else {
    ok('首页列表点赞按钮可切换状态', false, '找不到列表卡片上的点赞按钮')
  }

  /* 5.55 时间筛选：预设「近 7 天」→ 自定义区间 → 刷新保持 → 恢复全部 */
  await page.goto(`${APP}/#/`, { waitUntil: 'networkidle2' })
  await page
    .waitForFunction((title) => document.body.innerText.includes(title), { timeout: 20000 }, TITLE)
    .catch(() => {})

  const presetClicked = await clickByText(page, 'button', '近 7 天')
  await new Promise((r) => setTimeout(r, 600))
  const presetActive = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('近 7 天'))
    return btn?.getAttribute('aria-pressed') === 'true'
  })
  const presetRange = await hashParam(page, 'range')
  ok(
    '时间筛选「近 7 天」生效',
    presetClicked && presetActive && presetRange === '7d',
    `clicked=${presetClicked} active=${presetActive} range=${presetRange}`,
  )
  // 等列表重新取完再判断（固定 sleep 在帖子多、网络慢时会误判）
  const stillVisible = await page
    .waitForFunction((title) => document.body.innerText.includes(title), { timeout: 20000 }, TITLE)
    .then(() => true)
    .catch(() => false)
  ok('时间筛选后新帖仍在列表中', stillVisible)
  await shot(page, '19-time-filter')

  const customOpened = await clickByText(page, 'button', '自定义')
  let panelShown = false
  try {
    await page.waitForSelector('input[aria-label="开始日期"]', { timeout: 8000 })
    panelShown = true
  } catch {
    /* 下面判失败 */
  }
  if (panelShown) {
    await setDateValue(page, 'input[aria-label="开始日期"]', '2020-01-01')
    await setDateValue(page, 'input[aria-label="结束日期"]', '2020-01-02')
  }
  const applied = panelShown && (await clickByText(page, 'button', '应用'))
  const emptyShown = await page
    .waitForFunction(() => document.body.innerText.includes('这段时间还没有帖子'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  const postHidden = await page.evaluate((title) => !document.body.innerText.includes(title), TITLE)
  const customRange = await hashParam(page, 'range')
  ok(
    '自定义时间区间为空时显示空状态',
    customOpened && applied && emptyShown && postHidden && customRange === 'custom',
    `open=${customOpened} apply=${applied} empty=${emptyShown} hidden=${postHidden} range=${customRange}`,
  )
  await shot(page, '19b-time-filter-custom')

  await page.reload({ waitUntil: 'networkidle2' })
  const persisted = await page
    .waitForFunction(() => document.body.innerText.includes('这段时间还没有帖子'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  ok('刷新后时间筛选保持', persisted)

  const cleared = await clickByText(page, 'button', '不限时间')
  const restored = await page
    .waitForFunction((title) => document.body.innerText.includes(title), { timeout: 20000 }, TITLE)
    .then(() => true)
    .catch(() => false)
  const rangeGone = (await hashParam(page, 'range')) === null
  ok(
    '切回「不限时间」恢复全部帖子',
    cleared && restored && rangeGone,
    `clicked=${cleared} restored=${restored} rangeGone=${rangeGone}`,
  )

  /* 5.6 侧边栏「通知」未读红点/数量：用第二个账号评论，触发对被验收账号的通知 */
  const notified = await createUnreadNotification(createdPostId)
  if (notified) {
    await page.goto(`${APP}/#/`, { waitUntil: 'networkidle2' })
    await page.reload({ waitUntil: 'networkidle2' })
    await new Promise((r) => setTimeout(r, 2500))
    const badge = await page.evaluate(() => {
      const link = [...document.querySelectorAll('aside a')].find((a) =>
        (a.textContent ?? '').includes('通知'),
      )
      const el = link?.querySelector('[aria-label$="未读通知"]')
      return el?.textContent?.trim() ?? null
    })
    ok('侧边栏「通知」显示未读数量', badge === '1', `badge=${badge}`)
    await shot(page, '08c-sidebar-notification-badge')
  } else {
    ok('侧边栏「通知」显示未读数量', false, '无法创建通知')
  }

  /* 6. 个人中心 */
  await page.goto(`${APP}/#/me`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1500))
  const meText = await page.evaluate(() => document.body.innerText)
  ok('个人中心渲染', meText.includes(DISPLAY) && meText.includes('我的帖子'))

  // 侧边栏选中态必须唯一：在 /me 时不该还亮着「全部」（曾出现过同时选中两个的 bug）
  const activeNav = await page.evaluate(() =>
    [...document.querySelectorAll('aside nav a')]
      .filter((a) => a.className.includes('nav-item-active'))
      .map((a) => (a.textContent ?? '').trim()),
  )
  ok('侧边栏只有一个选中项', activeNav.length === 1, JSON.stringify(activeNav))
  ok('个人中心页选中项是「个人中心」', activeNav[0] === '个人中心', JSON.stringify(activeNav))

  await shot(page, '09-profile')

  /* 6.5 自定义头像：自选图标 + 背景 */
  await clickByText(page, 'button', '编辑资料')
  await page.waitForSelector('[data-avatar-emoji]', { timeout: 15000 })
  const pickedEmoji = await clickByText(page, '[data-avatar-emoji]', '🐦‍🔥')
  const bgHandle = await page.$('[data-avatar-bg="樱花"]')
  if (bgHandle) await bgHandle.click()
  const pickedBg = Boolean(bgHandle)
  ok('头像编辑器可打开并选择图标/背景', pickedEmoji && pickedBg)
  await shot(page, '09b-avatar-editor')
  await clickByText(page, 'button', '保存')
  const avatarSaved = await page
    .waitForFunction(() => (document.querySelector('header')?.textContent ?? '').includes('🐦‍🔥'), {
      timeout: 20000,
    })
    .then(() => true)
    .catch(() => false)
  ok('自定义头像保存后立即生效', avatarSaved)

  await page.reload({ waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1500))
  const avatarPersisted = await page.evaluate(
    () => (document.querySelector('header')?.textContent ?? '').includes('🐦‍🔥'),
  )
  ok('刷新后自定义头像仍保留', avatarPersisted)
  await shot(page, '09c-avatar-saved')

  /* 6.7 意见反馈：提交 → 我的反馈出现 */
  await page.goto(`${APP}/#/feedback`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#feedback-content', { timeout: 15000 })
  const feedbackText = `UI 验收反馈 ${suffix}：希望增加夜间模式。`
  await page.type('#feedback-content', feedbackText)
  await page.type('#feedback-contact', 'e2e@example.com')
  await shot(page, '09d-feedback-form')
  // 等按钮可用再点；万一首次点击没生效（页面还在挂载），重试一次
  await page
    .waitForFunction(
      () => {
        const btn = [...document.querySelectorAll('button')].find((b) =>
          (b.textContent ?? '').includes('提交反馈'),
        )
        return Boolean(btn) && !btn.disabled
      },
      { timeout: 15000 },
    )
    .catch(() => {})
  await clickByText(page, 'button', '提交反馈')
  const waitFeedback = () =>
    page
      .waitForFunction((txt) => document.body.innerText.includes(txt), { timeout: 15000 }, feedbackText)
      .then(() => true)
      .catch(() => false)
  let feedbackSubmitted = await waitFeedback()
  if (!feedbackSubmitted) {
    await clickByText(page, 'button', '提交反馈')
    feedbackSubmitted = await waitFeedback()
  }
  ok('提交意见反馈成功（我的反馈立即出现）', feedbackSubmitted)
  const feedbackPending = await page.evaluate(() => document.body.innerText.includes('待处理'))
  ok('新反馈状态为「待处理」', feedbackPending)
  await shot(page, '09e-feedback-submitted')

  /* 7. 提升为管理员（数据库直连），再看管理后台 */
  const promoted = await promoteToAdmin(EMAIL)
  ok('数据库直连设置管理员', promoted)
  await page.goto(`${APP}/#/`, { waitUntil: 'networkidle2' })
  await page.reload({ waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1500))
  await page.goto(`${APP}/#/admin`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1800))
  const adminText = await page.evaluate(() => document.body.innerText)
  ok('管理后台渲染', adminText.includes('举报') && adminText.includes('用户'), adminText.slice(0, 120))
  await shot(page, '10-admin')

  /* 7.5 违禁词标签：添加 → 列表出现 → 删除 */
  await clickByText(page, 'button', '违禁词')
  await new Promise((r) => setTimeout(r, 1200))
  const wordsTabShown = await page.evaluate(
    () => document.body.innerText.includes('违禁词检测') && document.body.innerText.includes('词库'),
  )
  ok('管理后台「违禁词」标签可用', wordsTabShown)
  await shot(page, '10b-admin-words')

  const testWord = `e2e违禁词${suffix.slice(-3)}`
  await page.waitForSelector('input[aria-label="违禁词"]', { timeout: 15000 })
  await page.type('input[aria-label="违禁词"]', testWord)
  await clickByText(page, 'button', '添加')
  const wordAdded = await page
    .waitForFunction((w) => document.body.innerText.includes(w), { timeout: 15000 }, testWord)
    .then(() => true)
    .catch(() => false)
  ok('能添加违禁词', wordAdded)
  await shot(page, '10c-admin-words-added')

  await page.evaluate((w) => {
    const li = [...document.querySelectorAll('li')].find(
      (el) =>
        el.innerText.includes(w) &&
        [...el.querySelectorAll('button')].some((b) => b.innerText.includes('删除')),
    )
    const btn = [...(li?.querySelectorAll('button') ?? [])].find((b) => b.innerText.includes('删除'))
    btn?.click()
  }, testWord)
  const wordDeleted = await page
    .waitForFunction((w) => !document.body.innerText.includes(w), { timeout: 15000 }, testWord)
    .then(() => true)
    .catch(() => false)
  ok('能删除违禁词', wordDeleted)

  /* 7.6 反馈标签：能看到用户刚提交的反馈 → 标记已处理 */
  await clickByText(page, 'button', '反馈')
  await new Promise((r) => setTimeout(r, 1200))
  const adminFeedbackVisible = await page
    .waitForFunction((t) => document.body.innerText.includes(t), { timeout: 15000 }, feedbackText)
    .then(() => true)
    .catch(() => false)
  ok('管理后台能看到用户反馈', adminFeedbackVisible)
  await shot(page, '10d-admin-feedback')

  await clickByText(page, 'button', '标记已处理')
  const feedbackResolved = await page
    .waitForFunction(() => document.body.innerText.includes('重新打开'), { timeout: 15000 })
    .then(() => true)
    .catch(() => false)
  ok('管理员能标记反馈已处理', feedbackResolved)
  await shot(page, '10e-admin-feedback-resolved')

  // 用户端同步
  await page.goto(`${APP}/#/feedback`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1200))
  const userSeesResolved = await page
    .waitForFunction(
      (t) => document.body.innerText.includes(t) && document.body.innerText.includes('已处理'),
      { timeout: 20000 },
      feedbackText,
    )
    .then(() => true)
    .catch(() => false)
  ok('用户端同步显示「已处理」', userSeesResolved)
  await shot(page, '09f-feedback-resolved')

  /* 8. 通知：打开通知页应自动全部标记已读，未读角标自动消失 */
  await page.goto(`${APP}/#/notifications`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1200))
  ok('通知页渲染', (await page.evaluate(() => document.body.innerText)).includes('通知'))
  await shot(page, '11-notifications')

  const badgeCleared = await page
    .waitForFunction(
      () => {
        const link = [...document.querySelectorAll('aside a')].find((a) =>
          (a.textContent ?? '').includes('通知'),
        )
        return Boolean(link) && !link.querySelector('[aria-label$="未读通知"]')
      },
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false)
  ok('打开通知页后未读角标自动消失', badgeCleared)
  await shot(page, '11b-notifications-auto-read')

  /* 9. 移动端 */
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await page.goto(`${APP}/#/`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1200))
  await shot(page, '12-mobile-home')
  ok('移动端首页渲染', true)

  console.log(`\n控制台错误: ${errors.length === 0 ? '无' : errors.length}`)
  for (const e of errors.slice(0, 10)) console.log(`  - ${e}`)

  console.log('\n===== UI 验收结果 =====')
  const failed = results.filter((r) => !r.pass)
  console.log(`通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`)
    process.exitCode = 1
  }
  console.log(`\n测试账号: ${EMAIL}`)
  console.log(`截图目录: ${SHOTS}`)

  await page.close()
  browser.disconnect()
}

async function promoteToAdmin(email) {
  const password = process.env.DB_PASSWORD
  const ref = process.env.SUPABASE_REF
  const host = process.env.DB_HOST
  if (!password || !ref || !host) return false
  const { Client } = await import('pg')
  const client = new Client({
    host,
    port: 5432,
    user: `postgres.${ref}`,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
  try {
    await client.connect()
    const r = await client.query(
      `update public.profiles p set role = 'admin'
         from auth.users u where u.id = p.id and lower(u.email) = lower($1) returning p.id`,
      [email],
    )
    return r.rowCount === 1
  } catch (err) {
    console.log(`  设置管理员失败: ${err.message?.slice(0, 120)}`)
    return false
  } finally {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }
}

await main()
