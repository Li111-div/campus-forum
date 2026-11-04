/**
 * 登录网关验收：未登录访问任何页面都应进入登录/注册页，登录后回到论坛。
 *
 * 前提：先启动带 CDP 的 Chrome（与 e2e-ui.mjs 相同）：
 *   "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9333 --user-data-dir=<workspace>\.chrome-profile about:blank
 * 运行：node scripts/e2e-auth-gate.mjs
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5173'
const CDP = process.env.CHROME_CDP ?? 'http://127.0.0.1:9333'
const SHOTS = resolve(process.cwd(), '.shots')
mkdirSync(SHOTS, { recursive: true })

const suffix = Date.now().toString(36).slice(-5)
const EMAIL = `campus.forum.e2e.gate.${suffix}@gmail.com`
const PASSWORD = `Gate-${suffix}-Pw1`
const DISPLAY = `网关验收${suffix.slice(-2)}`

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

async function checkGuestRedirect(page, path, label) {
  await page.goto(`${APP}/#${path}`, { waitUntil: 'networkidle2', timeout: 30000 })
  try {
    await page.waitForFunction(() => location.hash === '#/login', { timeout: 15000 })
    ok(label, true)
  } catch {
    const hash = await page.evaluate(() => location.hash)
    ok(label, false, `当前 hash=${hash}`)
  }
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
  // 用独立浏览器上下文（相当于无痕窗口），避免上一次验收残留的登录态影响结果
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)))

  /* 1. 未登录访问各页面都应落到登录页 */
  await checkGuestRedirect(page, '/', '未登录访问 / → 登录页')
  await checkGuestRedirect(page, '/new', '未登录访问 /new → 登录页')
  await checkGuestRedirect(page, '/me', '未登录访问 /me → 登录页')
  await checkGuestRedirect(page, '/notifications', '未登录访问 /notifications → 登录页')
  await shot(page, 'gate-01-login')

  const loginText = await page.evaluate(() => document.body.innerText)
  ok('登录页没有侧边栏/搜索框', !loginText.includes('板块') && !loginText.includes('搜索帖子'))
  ok('登录页显示登录/注册入口', loginText.includes('登录') && loginText.includes('注册'))

  /* 2. 注册 → 自动进首页 */
  await page.goto(`${APP}/#/register`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#displayName', { timeout: 15000 })
  await page.type('#displayName', DISPLAY)
  await page.type('#email', EMAIL)
  await page.type('#password', PASSWORD)
  await page.type('#confirm', PASSWORD)
  await shot(page, 'gate-02-register')
  await clickByText(page, 'button', '注册')
  await page.waitForFunction(() => location.hash === '#/', { timeout: 30000 })
  await page.waitForFunction(() => document.body.innerText.includes('全部'), { timeout: 20000 })
  ok('注册后进入论坛首页', true)
  await shot(page, 'gate-03-home-after-register')

  /* 3. 退出登录 → 回到登录页 */
  await page.waitForFunction((name) => document.body.innerText.includes(name), { timeout: 20000 }, DISPLAY)
  const opened = await clickByText(page, 'header button', DISPLAY)
  ok('头像菜单可打开', opened)
  await new Promise((r) => setTimeout(r, 500))
  const logoutClicked = await clickByText(page, 'button', '退出登录')
  ok('点击退出登录', logoutClicked)
  await page.waitForFunction(() => location.hash === '#/login', { timeout: 20000 })
  ok('退出登录后回到登录页', true)
  await shot(page, 'gate-04-after-logout')

  /* 4. 用刚注册的账号重新登录 → 首页 */
  await page.waitForSelector('#email', { timeout: 15000 })
  await page.type('#email', EMAIL)
  await page.type('#password', PASSWORD)
  await clickByText(page, 'button', '登录')
  await page.waitForFunction(() => location.hash === '#/', { timeout: 30000 })
  await page.waitForFunction(() => document.body.innerText.includes('全部'), { timeout: 20000 })
  ok('重新登录后进入首页', true)
  await shot(page, 'gate-05-home-after-login')

  console.log(`\n控制台错误: ${errors.length === 0 ? '无' : errors.length}`)
  for (const e of errors.slice(0, 8)) console.log(`  - ${e}`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 登录网关验收 =====\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`)
    process.exitCode = 1
  }
  console.log(`\n测试账号: ${EMAIL}`)

  await context.close()
  browser.disconnect()
}

await main()
