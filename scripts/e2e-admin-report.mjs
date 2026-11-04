/**
 * 管理员举报处理 → 点进被举报评论所在帖子 的专项验收。
 * 前提：Chrome 已带 CDP 启动（9333），.env.local 有配置，DB_* 环境变量可用（提升管理员）。
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const APP = process.env.APP_URL ?? 'http://172.17.41.64:8080'
const CDP = process.env.CHROME_CDP ?? 'http://127.0.0.1:9333'
const SHOTS = resolve(process.cwd(), '.shots')
mkdirSync(SHOTS, { recursive: true })

const suffix = Date.now().toString(36).slice(-5)
const ADMIN_EMAIL = `campus.forum.e2e.adminrep.${suffix}@gmail.com`
const REPORTER_EMAIL = `campus.forum.e2e.reporter.${suffix}@gmail.com`
const ADMIN_DISPLAY = `验收管理${suffix.slice(-2)}`
const PASSWORD = `Rep-${suffix}-Pw1`

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

async function auth(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function rest(path, { method = 'GET', token, body, prefer } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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

async function promoteToAdmin(email) {
  const { Client } = await import('pg')
  const client = new Client({
    host: process.env.DB_HOST,
    port: 5432,
    user: `postgres.${process.env.SUPABASE_REF}`,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
  try {
    await client.connect()
    const r = await client.query(
      `update public.profiles p set role = 'admin'
         from auth.users u where u.id = p.id and lower(u.email) = lower($1)`,
      [email],
    )
    return r.rowCount === 1
  } finally {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  // 1) 管理员 A：注册、提升、发一帖
  const adminSignup = await auth('/auth/v1/signup', {
    email: ADMIN_EMAIL,
    password: PASSWORD,
    data: { display_name: ADMIN_DISPLAY },
  })
  const adminToken = adminSignup.json?.access_token
  ok('管理员测试号注册', Boolean(adminToken), JSON.stringify(adminSignup.json)?.slice(0, 120))
  if (!adminToken) return finish()

  const postRes = await rest('/rest/v1/posts', {
    method: 'POST',
    token: adminToken,
    body: { board_slug: 'chat', title: `举报跳转验收帖 ${suffix}`, content: '用于验收举报跳转。' },
    prefer: 'return=representation',
  })
  const post = Array.isArray(postRes.json) ? postRes.json[0] : postRes.json
  ok('创建测试帖', postRes.status === 201 && Boolean(post?.id), `HTTP ${postRes.status}`)

  // 2) 举报人 B：注册、评论、举报该评论
  const repSignup = await auth('/auth/v1/signup', {
    email: REPORTER_EMAIL,
    password: PASSWORD,
    data: { display_name: `验收举报${suffix.slice(-2)}` },
  })
  const repToken = repSignup.json?.access_token
  const commentRes = await rest('/rest/v1/comments', {
    method: 'POST',
    token: repToken,
    body: { post_id: post.id, content: '这是一条将被举报的评论' },
    prefer: 'return=representation',
  })
  const comment = Array.isArray(commentRes.json) ? commentRes.json[0] : commentRes.json
  ok('创建被举报评论', commentRes.status === 201 && Boolean(comment?.id), `HTTP ${commentRes.status}`)

  const reportRes = await rest('/rest/v1/reports', {
    method: 'POST',
    token: repToken,
    body: {
      target_type: 'comment',
      target_id: comment.id,
      reason: '违法违规',
      detail: '自动化验收举报',
    },
    prefer: 'return=minimal',
  })
  ok('提交评论举报', reportRes.status === 201 || reportRes.status === 204, `HTTP ${reportRes.status}`)

  // 3) 提升 A 为管理员，然后浏览器登录
  ok('把测试号设为管理员', await promoteToAdmin(ADMIN_EMAIL))

  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null })
  const context = await browser.createBrowserContext()
  browserRef = browser
  contextRef = context
  const page = await context.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)))

  await page.goto(`${APP}/#/login`, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForSelector('#email', { timeout: 15000 })
  await page.type('#email', ADMIN_EMAIL)
  await page.type('#password', PASSWORD)
  for (const h of await page.$$('button')) {
    const t = (await page.evaluate((el) => el.textContent ?? '', h)).trim()
    if (t === '登录') {
      await h.click()
      break
    }
  }
  await page.waitForFunction(() => location.hash === '#/', { timeout: 30000 })
  // 等个人资料（角色）加载完，否则直接打开 /#/admin 会被误判为非管理员
  await page.waitForFunction(
    (name) => (document.querySelector('header')?.textContent ?? '').includes(name),
    { timeout: 25000 },
    ADMIN_DISPLAY,
  )
  ok('管理员登录成功', true)

  // 4) 打开管理后台 → 举报处理
  await page.goto(`${APP}/#/admin`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(
    (title) => document.body.innerText.includes('举报处理') && document.body.innerText.includes(title),
    { timeout: 20000 },
    '查看被举报评论（跳转到所在帖子）',
  )
  const adminText = await page.evaluate(() => document.body.innerText)
  ok('举报项显示「查看被举报评论」链接', adminText.includes('查看被举报评论（跳转到所在帖子）'))
  ok('举报项显示评论内容摘要', adminText.includes('这是一条将被举报的评论'))
  await page.screenshot({ path: resolve(SHOTS, 'admin-report-comment-link.png') })

  // 5) 点链接 → 跳到帖子并高亮该评论
  for (const a of await page.$$('a')) {
    const t = (await page.evaluate((el) => el.textContent ?? '', a)) ?? ''
    if (t.includes('查看被举报评论')) {
      await a.click()
      break
    }
  }
  await page.waitForFunction((id) => location.hash.includes(`?comment=${id}`), { timeout: 20000 }, comment.id)
  ok('跳转到所在帖子并带上评论定位参数', true)

  const highlighted = await page
    .waitForFunction(
      (id) => {
        const el = document.getElementById(`comment-${id}`)
        return Boolean(el) && el.className.includes('bg-amber-50')
      },
      { timeout: 20000 },
      comment.id,
    )
    .then(() => true)
    .catch(() => false)
  ok('目标评论被滚动定位并高亮', highlighted)
  await page.screenshot({ path: resolve(SHOTS, 'admin-report-comment-highlight.png') })

  console.log(`\n控制台错误: ${errors.length === 0 ? '无' : errors.length}`)
  for (const e of errors.slice(0, 6)) console.log(`  - ${e}`)

  await context.close()
  browser.disconnect()
}

function finish() {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n===== 举报跳转验收 =====\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`)
  }
  // 显式退出，避免 puppeteer 连接让进程一直挂着
  setTimeout(() => process.exit(failed.length ? 1 : 0), 300)
}

let browserRef = null
let contextRef = null

try {
  await main()
  finish()
} catch (err) {
  console.error('验收脚本异常:', err.message)
  try {
    await contextRef?.close()
  } catch {
    /* ignore */
  }
  try {
    browserRef?.disconnect()
  } catch {
    /* ignore */
  }
  finish()
}
