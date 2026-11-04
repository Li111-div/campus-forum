/**
 * 好友 + 私信 专项验收（二期）。
 *
 * 覆盖：
 *   1. 两个账号分别登录（独立浏览器上下文）
 *   2. A 在「找人」搜到 B 并发好友申请
 *   3. B 在「好友申请」看到并同意
 *   4. 双方「我的好友」里都能看到对方
 *   5. A 点「私信」进入会话并发消息
 *   6. B 的侧边栏「私信」出现红点，进会话能看到消息
 *   7. B 回复 → A 靠 3 秒轮询收到
 *   8. A 删好友后，B 的列表显示「对方已把你删除」
 *   9. 非好友直接访问 /messages/<peerId> 显示「你们还不是好友」
 *
 * 前提：Chrome 已带 CDP 启动；.env.local 有配置。
 * 运行：node scripts/e2e-friends.mjs
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const APP = process.env.APP_URL ?? 'http://172.17.41.64:8080'
const CDP = process.env.CHROME_CDP ?? 'http://127.0.0.1:9333'
const SHOTS = resolve(process.cwd(), '.shots')
mkdirSync(SHOTS, { recursive: true })

const suffix = Date.now().toString(36).slice(-5)
const PASSWORD = `Fr-${suffix}-Pw1`
const A = { email: `campus.forum.e2e.fra.${suffix}@gmail.com`, display: `好友甲${suffix.slice(-2)}` }
const B = { email: `campus.forum.e2e.frb.${suffix}@gmail.com`, display: `好友乙${suffix.slice(-2)}` }

function loadEnv() {
  const env = {}
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    /* ignore */
  }
  return env
}

const env = loadEnv()
const BASE = env.VITE_SUPABASE_URL?.replace(/\/$/, '')
const KEY = env.VITE_SUPABASE_ANON_KEY

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? ` —— ${detail}` : ''}`)
}

async function shot(page, name) {
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) })
  console.log(`  📸 ${name}.png`)
}

async function signup(user) {
  const res = await fetch(`${BASE}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      password: PASSWORD,
      data: { display_name: user.display },
    }),
    signal: AbortSignal.timeout(20000),
  })
  const json = await res.json().catch(() => null)
  return { ok: res.status === 200 && Boolean(json?.access_token), json }
}

async function clickByText(page, selector, text) {
  for (const h of await page.$$(selector)) {
    const t = (await page.evaluate((el) => el.textContent ?? '', h)).trim()
    if (t.includes(text)) {
      await h.click()
      return true
    }
  }
  return false
}

/** 等按钮出现再点（页面还在加载时直接遍历会找不到）。 */
async function waitAndClick(page, selector, text, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await clickByText(page, selector, text)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

/** 用邮箱密码换取 access_token（给 REST 直调用）。 */
async function apiToken(email) {
  const res = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
    signal: AbortSignal.timeout(20000),
  })
  const json = await res.json().catch(() => null)
  return json?.access_token ?? null
}

async function apiInsert(path, token, body) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* ignore */ }
  return { status: res.status, json }
}

/** 等页头铃铛角标变成非空，返回耗时（毫秒）。 */
async function timeToBellBadge(page, timeout = 20000) {
  const started = Date.now()
  const shown = await page
    .waitForFunction(
      () => {
        const bell = document.querySelector('header a[aria-label="通知"]')
        if (!bell) return false
        return /\d/.test(bell.textContent ?? '')
      },
      { timeout },
    )
    .then(() => true)
    .catch(() => false)
  return shown ? Date.now() - started : -1
}

async function login(page, user) {
  await page.goto(`${APP}/#/login`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForSelector('#email', { timeout: 15000 })
  await page.type('#email', user.email)
  await page.type('#password', PASSWORD)
  await clickByText(page, 'button', '登录')
  return page
    .waitForFunction(() => location.hash === '#/', { timeout: 30000 })
    .then(() => true)
    .catch(() => false)
}

/** 打开好友页并确保停在「我的好友」标签（同一个 hash 重复 goto 不会重载，状态会残留）。 */
async function openFriendList(page) {
  await page.goto(`${APP}/#/friends`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 })
  await waitAndClick(page, 'button', '我的好友')
}

/** 等聊天输入框可用（关系查询还在加载时按钮是禁用的）。 */
async function waitChatReady(page, timeout = 25000) {
  return page
    .waitForFunction(
      () => {
        const el = document.querySelector('[aria-label="私信输入框"]')
        return Boolean(el) && !el.disabled
      },
      { timeout },
    )
    .then(() => true)
    .catch(() => false)
}

/** 等某段文字出现，返回耗时（毫秒）；超时返回 -1。 */
async function timeToText(page, text, timeout = 20000) {
  const started = Date.now()
  const okShown = await page
    .waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text)
    .then(() => true)
    .catch(() => false)
  return okShown ? Date.now() - started : -1
}

async function waitText(page, text, timeout = 20000) {
  return page
    .waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text)
    .then(() => true)
    .catch(() => false)
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
  const ctxA = await browser.createBrowserContext()
  const ctxB = await browser.createBrowserContext()
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  await pageA.setViewport({ width: 1440, height: 900 })
  await pageB.setViewport({ width: 1440, height: 900 })

  const errors = []
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    page.on('pageerror', (e) => errors.push(`${label} pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${label} console: ${m.text().slice(0, 160)}`)
    })
  }

  // 删除好友会弹 confirm
  pageA.on('dialog', (dialog) => void dialog.accept())

  /* ---------- 0. 注册 ---------- */
  const sa = await signup(A)
  const sb = await signup(B)
  ok('两个测试账号注册', sa.ok && sb.ok, `${sa.ok}/${sb.ok}`)
  if (!sa.ok || !sb.ok) return finish()

  /* ---------- 1. 分别登录 ---------- */
  ok('A 登录', await login(pageA, A))
  ok('B 登录', await login(pageB, B))

  /* ---------- 1.5 Realtime 通道 ---------- */
  const rtConnected = await waitText(pageA, '实时推送已连接', 20000)
  ok('Realtime 通道已连接（侧边栏有状态提示）', rtConnected)

  /* ---------- 1.6 通知 Realtime：B 评论 A 的帖子 ---------- */
  const tokenA = await apiToken(A.email)
  const tokenB = await apiToken(B.email)
  ok('能拿到测试账号 token', Boolean(tokenA && tokenB))
  if (tokenA && tokenB) {
    const created = await apiInsert('posts', tokenA, {
      board_slug: 'chat',
      title: `Realtime 通知验收帖 ${suffix}`,
      content: '用于验证通知实时到达。',
    })
    const postId = Array.isArray(created.json) ? created.json[0]?.id : null
    ok('创建验收帖成功', Boolean(postId), `HTTP ${created.status}`)
    if (postId) {
      // A 先把未读清掉，才能确认红点是「新来的」
      await pageA.goto(`${APP}/#/notifications`, { waitUntil: 'networkidle2' })
      await new Promise((r) => setTimeout(r, 1500))
      await pageA.goto(`${APP}/#/friends`, { waitUntil: 'networkidle2' })
      await new Promise((r) => setTimeout(r, 800))
      const comment = await apiInsert('comments', tokenB, {
        post_id: postId,
        content: `Realtime 通知测试评论 ${suffix}`,
      })
      ok('B 评论成功', comment.status === 201, `HTTP ${comment.status}`)
      const bellElapsed = await timeToBellBadge(pageA, 20000)
      ok(
        '通知红点即时出现（Realtime < 5 秒）',
        bellElapsed >= 0 && bellElapsed < 5000,
        `耗时 ${bellElapsed}ms`
      )
    }
  }

  /* ---------- 2. A 搜人 + 加好友 ---------- */
  await pageA.goto(`${APP}/#/friends`, { waitUntil: 'networkidle2' })
  await pageA.waitForSelector('[aria-label="搜索用户"]', { timeout: 15000 }).catch(() => {})
  const findTab = await waitAndClick(pageA, 'button', '找人')
  ok('好友页有「找人」标签', findTab)

  const searchInput = await pageA.$('[aria-label="搜索用户"]')
  if (searchInput) {
    await searchInput.type(B.display)
    await waitAndClick(pageA, 'button', '搜索')
  }
  const foundB = await waitText(pageA, B.display)
  ok('搜到目标同学', foundB)
  await shot(pageA, 'fr-01-find')

  const addClicked = await waitAndClick(pageA, 'button', '加好友')
  const addToast = await waitText(pageA, '好友申请已发出', 15000)
  ok('A 发出好友申请', addClicked && addToast, `clicked=${addClicked} toast=${addToast}`)

  /* ---------- 3. B 处理申请 ---------- */
  await pageB.goto(`${APP}/#/friends`, { waitUntil: 'networkidle2' })
  const reqTab = await waitAndClick(pageB, 'button', '好友申请')
  ok('B 有「好友申请」标签', reqTab)
  const sawRequest = await waitText(pageB, A.display)
  ok('B 看到 A 的申请', sawRequest)
  await shot(pageB, 'fr-02-requests')

  const accepted = await waitAndClick(pageB, 'button', '同意')
  const acceptToast = await waitText(pageB, '已同意', 15000)
  ok('B 同意好友申请', accepted && acceptToast, `clicked=${accepted} toast=${acceptToast}`)

  /* ---------- 4. 双方好友列表 ---------- */
  await waitAndClick(pageB, 'button', '我的好友')
  ok('B 的「我的好友」里有 A', await waitText(pageB, A.display))

  await openFriendList(pageA)
  ok('A 的「我的好友」里有 B', await waitText(pageA, B.display, 25000))
  await shot(pageA, 'fr-03-friends')

  /* ---------- 5. A 从好友列表进私信并发消息（会话此时还不存在） ---------- */
  // 注意：侧边栏也有一个「私信」链接，这里必须限定在正文区（main）里找好友行上的按钮
  const dmOpened = await pageA.evaluate(() => {
    const link = [...document.querySelectorAll('main a[href*="#/messages/"]')][0]
    if (!link) return false
    link.click()
    return true
  })
  ok('好友列表有「私信」入口', dmOpened)
  const enteredChat = await pageA
    .waitForFunction(() => location.hash.startsWith('#/messages/'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  ok('点私信进入会话页', enteredChat)

  const boxReady = await waitChatReady(pageA)
  ok('好友之间可以打开聊天框（首次会话尚未创建也能聊）', boxReady)
  const box = await pageA.$('[aria-label="私信输入框"]')

  const MESSAGE = `你好，这是验收私信 ${suffix}`
  if (box) {
    await box.click()
    await box.type(MESSAGE)
    await waitAndClick(pageA, 'button', '发送')
  }
  const sentShown = await waitText(pageA, MESSAGE, 20000)
  ok('A 发送私信成功', Boolean(box) && sentShown)
  await shot(pageA, 'fr-04-chat')

  /* ---------- 6. B 收到私信 ---------- */
  await pageB.goto(`${APP}/#/messages`, { waitUntil: 'networkidle2' })
  const bSawChat = await waitText(pageB, A.display, 25000)
  ok('B 的私信页出现与 A 的会话', bSawChat)
  await waitChatReady(pageB)
  const bSawMessage = await waitText(pageB, MESSAGE, 20000)
  ok('B 能读到 A 发来的消息', bSawMessage)
  await shot(pageB, 'fr-05-b-chat')

  /* ---------- 7. B 回复 → A 轮询收到 ---------- */
  const REPLY = `收到啦，这是回复 ${suffix}`
  const bBox = await pageB.$('[aria-label="私信输入框"]')
  if (bBox) {
    await bBox.click()
    await bBox.type(REPLY)
    await waitAndClick(pageB, 'button', '发送')
  }
  const replySent = await waitText(pageB, REPLY, 20000)
  ok('B 回复成功', Boolean(bBox) && replySent)

  // A 页面还停在会话里：靠 Realtime 推送，轮询兜底是 30 秒（连不上时才 8 秒）
  const dmElapsed = await timeToText(pageA, REPLY, 25000)
  ok(
    'A 无需刷新即时收到回复（Realtime < 5 秒）',
    dmElapsed >= 0 && dmElapsed < 5000,
    `耗时 ${dmElapsed}ms`
  )
  await shot(pageA, 'fr-06-reply')

  /* ---------- 7.5 侧边栏会话列表 ---------- */
  await pageA.goto(`${APP}/#/messages`, { waitUntil: 'networkidle2' })
  ok('A 的会话列表里有 B', await waitText(pageA, B.display, 25000))
  /* ---------- 8. 未读数与红点 ---------- */
  // 私信页是整页铺满布局（隐藏论坛侧边栏），所以回好友页再检查侧边栏入口
  await pageB.goto(`${APP}/#/friends`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1200))
  const sidebarBadge = await pageB.evaluate(() => {
    const links = [...document.querySelectorAll('aside a')]
    const dm = links.find((a) => (a.textContent ?? '').includes('私信'))
    return dm ? dm.textContent ?? '' : ''
  })
  ok('侧边栏「私信」入口存在', sidebarBadge.includes('私信'), sidebarBadge)

  /* ---------- 8.5 私信页整页铺满（无白边） ---------- */
  await pageB.setViewport({ width: 1280, height: 800 })
  await pageB.goto(`${APP}/#/messages`, { waitUntil: 'networkidle2' })
  await new Promise((r) => setTimeout(r, 1500))
  const bleed = await pageB.evaluate(() => {
    const section = document.querySelector('main section')
    if (!section) return null
    const r = section.getBoundingClientRect()
    const style = getComputedStyle(section)
    const sidebar = [...document.querySelectorAll('aside')].find((el) => (el.textContent ?? '').includes('板块'))
    return {
      right: Math.round(window.innerWidth - r.right),
      bottom: Math.round(window.innerHeight - r.bottom),
      radius: style.borderRadius,
      border: style.borderTopWidth,
      shadow: style.boxShadow,
      hasSidebar: Boolean(sidebar) && getComputedStyle(sidebar).display !== 'none',
    }
  })
  ok(
    '私信页保留论坛侧边栏',
    Boolean(bleed?.hasSidebar),
    JSON.stringify(bleed),
  )
  ok(
    '私信页贴右边缘与底边、无圆角边框阴影',
    Boolean(bleed) && bleed.right <= 20 && bleed.bottom <= 2 && bleed.radius === '0px' && bleed.border === '0px' && bleed.shadow === 'none',
    JSON.stringify(bleed),
  )

  /* ---------- 9. A 删好友 → B 看到 half ---------- */
  await openFriendList(pageA)
  await waitText(pageA, B.display, 25000)
  const removed = await waitAndClick(pageA, 'button', '删除')
  const removeToast = await waitText(pageA, '已删除好友', 15000)
  ok('A 删除好友', removed && removeToast, `clicked=${removed} toast=${removeToast}`)

  await openFriendList(pageB)
  const bSeesHalf = await waitText(pageB, '对方已把你删除', 25000)
  ok('B 的列表显示「对方已把你删除」', bSeesHalf)
  await shot(pageB, 'fr-07-half')

  /* ---------- 10. 非好友访问私信路径 ---------- */
  await pageB.goto(`${APP}/#/friends`, { waitUntil: 'networkidle2' })
  await pageB.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 20000 }, A.display).catch(() => {})
  const peerHref = await pageB.evaluate(() => {
    const link = [...document.querySelectorAll('a[href*="#/u/"]')][0]
    return link ? link.getAttribute('href') : ''
  })
  const peerId = peerHref ? peerHref.split('/u/').pop() : ''
  if (peerId) {
    await pageB.goto(`${APP}/#/messages/${peerId}`, { waitUntil: 'networkidle2' })
    const notFriend = await waitText(pageB, '你们还不是好友', 20000)
    ok('删好友后访问私信路径提示「你们还不是好友」', notFriend)
    await shot(pageB, 'fr-08-not-friend')
  } else {
    ok('删好友后访问私信路径提示「你们还不是好友」', false, '没拿到 peerId')
  }

  /* ---------- 收尾 ---------- */
  console.log(`\n控制台错误: ${errors.length === 0 ? '无' : errors.length}`)
  for (const e of errors.slice(0, 8)) console.log(`  - ${e}`)

  await ctxA.close()
  await ctxB.close()
  browser.disconnect()
  finish()
}

function finish() {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 好友 / 私信验收 =====\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`)
    process.exitCode = 1
  }
  console.log(`\n测试账号: ${A.email} / ${B.email}`)
}

await main()
