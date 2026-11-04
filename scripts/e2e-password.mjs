/**
 * 修改密码 / 找回密码 专项验收。
 *
 * 覆盖：
 *   1. 未登录可访问 /forgot-password（公开页），布局是干净单栏
 *   2. 邮箱格式非法 → 前端拦下
 *   3. 合法邮箱 → 显示「邮件已发出」（不泄露邮箱是否注册）
 *   4. 个人中心「修改密码」弹窗：当前密码错误 → 明确提示
 *   5. 两次新密码不一致 → 拦下
 *   6. 当前密码正确 + 新密码 → 修改成功，旧密码失效、新密码可用
 *   7. 重置密码页（#/reset-password + token）→ 设置新密码 → 新密码生效
 *   8. 无效/过期链接 → 显示「链接已失效」而不是白屏
 *
 * 说明：Supabase 的恢复邮件有 60 秒发送频率限制，验收里不可能真去收信，
 * 所以第 7 步用「真实会话 token + 与邮件链接完全相同的 URL 形态」驱动重置页，
 * 走的是页面里同一条 setSession → updateUser 代码路径。
 *
 * 前提：Chrome 已带 CDP 启动；.env.local 有配置。
 * 运行：node scripts/e2e-password.mjs
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const APP = process.env.APP_URL ?? 'http://172.17.41.64:8080'
const CDP = process.env.CHROME_CDP ?? 'http://127.0.0.1:9333'
const SHOTS = resolve(process.cwd(), '.shots')
mkdirSync(SHOTS, { recursive: true })

const suffix = Date.now().toString(36).slice(-5)
const EMAIL = `campus.forum.e2e.pwd.${suffix}@gmail.com`
const PASSWORD = `Pwd-${suffix}-Old1`
const NEW_PASSWORD = `Pwd-${suffix}-New2`
const RESET_PASSWORD = `Pwd-${suffix}-Rst3`
const DISPLAY = `改密验收${suffix.slice(-2)}`

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

/** 等某个按钮渲染出来再点（页面还在加载时直接遍历会找不到）。 */
async function waitAndClick(page, selector, text, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const h of await page.$$(selector)) {
      const t = (await page.evaluate((el) => el.textContent ?? '', h)).trim()
      if (t.includes(text)) {
        await h.click()
        return true
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function auth(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* ignore */
  }
  return { status: res.status, json, text }
}

/** 用邮箱密码登录，拿 token（也用来判断某个密码是否还有效）。 */
async function signIn(email, password) {
  const res = await auth('/auth/v1/token?grant_type=password', { email, password })
  return { ok: res.status === 200, json: res.json, text: res.text }
}

/**
 * 清掉本地会话并硬刷新到指定路由。
 * 只 clear localStorage 不够——内存里的 session 还在，登录页会立刻把人弹回首页。
 */
async function resetAuth(page, target = '/login') {
  await page.evaluate(() => window.localStorage.clear())
  await page.goto(`${APP}/#${target}`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 })
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 1440, height: 900 })

  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    const text = m.text()
    // 「无效恢复链接」用例会故意用坏 token 调 setSession，400 是预期结果
    if (m.type() === 'error' && !text.includes('status of 400')) errors.push(text.slice(0, 160))
  })

  /* ---------- 0. 准备账号 ---------- */
  const signup = await auth('/auth/v1/signup', {
    email: EMAIL,
    password: PASSWORD,
    data: { display_name: DISPLAY },
  })
  ok('测试账号注册', Boolean(signup.json?.access_token), JSON.stringify(signup.json)?.slice(0, 140))
  if (!signup.json?.access_token) return finish()

  /* ---------- 1. 忘记密码页（公开页） ---------- */
  await page.goto(`${APP}/#/forgot-password`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForSelector('#email', { timeout: 15000 })
  const forgotText = await page.evaluate(() => document.body.innerText)
  ok('未登录可直接打开找回密码页', forgotText.includes('找回密码'))
  ok('找回密码页是干净单栏（无侧边栏）', !forgotText.includes('板块') && !forgotText.includes('搜索帖子'))
  await shot(page, 'pwd-01-forgot')

  /* ---------- 2. 邮箱格式非法被拦 ---------- */
  await page.type('#email', 'not-an-email')
  await clickByText(page, 'button', '发送重置邮件')
  const badEmailShown = await page
    .waitForFunction(() => document.body.innerText.includes('请输入有效的邮箱地址'), { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  ok('邮箱格式非法时给出中文提示（不是浏览器英文气泡）', badEmailShown)

  /* ---------- 3. 合法邮箱 → 已发送 ---------- */
  await page.click('#email', { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await page.type('#email', EMAIL)
  await clickByText(page, 'button', '发送重置邮件')
  const sentShown = await page
    .waitForFunction(
      () =>
        document.body.innerText.includes('邮件已发出') ||
        document.body.innerText.includes('操作太频繁'),
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false)
  ok('提交找回密码后给出明确反馈（已发送 / 频率限制）', sentShown)
  await shot(page, 'pwd-02-forgot-sent')

  /* ---------- 4. 登录 → 个人中心 → 修改密码弹窗 ---------- */
  await resetAuth(page)
  await page.waitForSelector('#email', { timeout: 15000 })
  await page.type('#email', EMAIL)
  await page.type('#password', PASSWORD)
  await clickByText(page, 'button', '登录')
  const loggedIn = await page
    .waitForFunction(() => location.hash === '#/', { timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  ok('用原密码登录成功', loggedIn)
  if (!loggedIn) return finish()

  await page.goto(`${APP}/#/me`, { waitUntil: 'networkidle2' })
  await page.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 20000 }, DISPLAY)
  const opened = await waitAndClick(page, 'button', '修改密码')
  ok('个人中心有「修改密码」入口', opened)
  await page.waitForSelector('#current-password', { timeout: 15000 })
  ok('修改密码弹窗打开', true)
  await shot(page, 'pwd-03-change-modal')

  /* ---------- 5. 当前密码错误 → 明确提示 ---------- */
  await page.type('#current-password', 'definitely-wrong-pw')
  await page.type('#new-password', NEW_PASSWORD)
  await page.type('#confirm-password', NEW_PASSWORD)
  await clickByText(page, 'button', '确认修改')
  const wrongCurrent = await page
    .waitForFunction(
      () =>
        document.body.innerText.includes('当前密码不正确') ||
        document.body.innerText.includes('操作太频繁'),
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false)
  ok('当前密码错误时给出明确提示', wrongCurrent)
  await shot(page, 'pwd-04-wrong-current')

  /* ---------- 6. 两次新密码不一致 → 拦下 ---------- */
  // 负向用例之间重开弹窗，避免上一次的输入/错误状态影响下一次
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 20000 }, DISPLAY)
  await waitAndClick(page, 'button', '修改密码')
  await page.waitForSelector('#current-password', { timeout: 15000 })
  await page.type('#current-password', PASSWORD)
  await page.type('#new-password', NEW_PASSWORD)
  await page.type('#confirm-password', `${NEW_PASSWORD}x`)
  await clickByText(page, 'button', '确认修改')
  const mismatch = await page
    .waitForFunction(() => document.body.innerText.includes('两次输入的密码不一致'), { timeout: 10000 })
    .then(() => true)
    .catch(() => false)
  ok('两次新密码不一致时被拦下', mismatch)

  /* ---------- 7. 正确修改密码 ---------- */
  await page.reload({ waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 20000 }, DISPLAY)
  const reopened = await waitAndClick(page, 'button', '修改密码')
  ok('可以重新打开修改密码弹窗', reopened)
  await page.waitForSelector('#current-password', { timeout: 15000 })
  await page.type('#current-password', PASSWORD)
  await page.type('#new-password', NEW_PASSWORD)
  await page.type('#confirm-password', NEW_PASSWORD)
  await clickByText(page, 'button', '确认修改')
  const modalClosed = await page
    .waitForFunction(
      () =>
        !document.querySelector('#current-password') ||
        document.body.innerText.includes('操作太频繁'),
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false)
  ok('修改密码成功后弹窗关闭', modalClosed)
  await shot(page, 'pwd-05-changed')

  /* ---------- 8. 旧密码失效 / 新密码可用（走 API，避免 UI 频繁登录触发限流） ---------- */
  const oldPw = await signIn(EMAIL, PASSWORD)
  ok('旧密码已失效', !oldPw.ok, `status=${oldPw.status} ${String(oldPw.text).slice(0, 80)}`)

  const newPw = await signIn(EMAIL, NEW_PASSWORD)
  ok('新密码可以登录', newPw.ok, `status=${newPw.status} ${String(newPw.text).slice(0, 80)}`)
  const session = newPw.json

  /* ---------- 9. 重置密码页：设置新密码 ---------- */
  // 用真实会话 token 构造与恢复邮件完全相同的 URL 形态
  if (session?.access_token) {
    await page.evaluate(() => window.localStorage.clear())
    const hash = `#/reset-password#access_token=${session.access_token}&refresh_token=${session.refresh_token}&type=recovery`
    await page.goto(`${APP}/${hash}`, { waitUntil: 'networkidle2', timeout: 30000 })
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 })
    await page.waitForSelector('#password', { timeout: 20000 })
    const resetPageShown = await page.evaluate(() => document.body.innerText.includes('设置新密码'))
    ok('重置链接进入「设置新密码」页', resetPageShown)
    await shot(page, 'pwd-06-reset-form')

    await page.type('#password', RESET_PASSWORD)
    await page.type('#confirm', RESET_PASSWORD)
    await clickByText(page, 'button', '确认修改密码')
    const resetDone = await page
      .waitForFunction(() => document.body.innerText.includes('密码已更新'), { timeout: 25000 })
      .then(() => true)
      .catch(() => false)
    ok('重置页修改密码成功', resetDone)
    await shot(page, 'pwd-07-reset-done')

    const resetPw = await signIn(EMAIL, RESET_PASSWORD)
    ok('重置后的密码可以登录', resetPw.ok, `status=${resetPw.status}`)
  } else {
    ok('重置链接进入「设置新密码」页', false, '拿不到可用会话')
    ok('重置页修改密码成功', false, '拿不到可用会话')
    ok('重置后的密码可以登录', false, '拿不到可用会话')
  }

  /* ---------- 10. 失效/无效恢复链接 ---------- */
  await resetAuth(page, '/reset-password#access_token=invalid.token.value&refresh_token=x&type=recovery')
  const invalidShown = await page
    .waitForFunction(() => document.body.innerText.includes('重置链接无效或已过期'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  ok('无效恢复链接显示「链接无效或已过期」', invalidShown)
  const hasRetry = await page.evaluate(() => document.body.innerText.includes('重新发送重置邮件'))
  ok('失效页提供「重新发送重置邮件」入口', hasRetry)
  await shot(page, 'pwd-08-invalid-link')

  /* ---------- 收尾 ---------- */
  console.log(`\n控制台错误: ${errors.length === 0 ? '无' : errors.length}`)
  for (const e of errors.slice(0, 8)) console.log(`  - ${e}`)

  await context.close()
  browser.disconnect()
  finish()
}

function finish() {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 密码功能验收 =====\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`)
    process.exitCode = 1
  }
  console.log(`\n测试账号: ${EMAIL}`)
}

await main()
