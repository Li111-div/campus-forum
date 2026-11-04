#!/usr/bin/env node
/**
 * 数据库端到端验收脚本（不依赖浏览器）。
 *
 * 用法：node scripts/verify-db.mjs
 * 前提：已在 Supabase SQL Editor 执行过 supabase/init.sql；.env.local 里有 URL 与 publishable key。
 *
 * 它会：
 *   1. 检查表/种子数据是否就绪
 *   2. 检查匿名（anon）能读什么、不能写什么
 *   3. 注册两个临时账号，走一遍 发帖→评论→点赞→收藏→关注→通知→搜索→软删
 *   4. 检查越权：普通用户改 role / 改计数 / 直写明细表 / 调管理员 RPC 必须失败
 *
 * 会留下 2 个测试账号（verify.a+/verify.b+ 开头的邮箱）和 1 条已删除的测试帖。
 * 清理：Supabase Dashboard → Authentication → Users 删除这两个邮箱；测试帖已被软删，不影响前台。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/* ------------------------------ 读取配置 ------------------------------ */

function loadEnv() {
  const file = resolve(process.cwd(), '.env.local')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    console.error('找不到 .env.local，请在 campus-forum-app 目录下运行本脚本')
    process.exit(1)
  }
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return env
}

const env = loadEnv()
const BASE = env.VITE_SUPABASE_URL?.replace(/\/$/, '')
const KEY = env.VITE_SUPABASE_ANON_KEY
if (!BASE || !KEY) {
  console.error('.env.local 缺少 VITE_SUPABASE_URL 或 VITE_SUPABASE_ANON_KEY')
  process.exit(1)
}

/* ------------------------------ 小工具 ------------------------------ */

let passed = 0
let failed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  \u2713 ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
    console.log(`  \u2717 ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

async function request(path, { method = 'GET', token, body, headers = {}, prefer } = {}) {
  const h = {
    apikey: KEY,
    ...headers,
  }
  if (token) h.Authorization = `Bearer ${token}`
  else h.Authorization = `Bearer ${KEY}`
  if (body !== undefined) h['Content-Type'] = 'application/json'
  if (prefer) h.Prefer = prefer
  let res
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    })
  } catch (err) {
    return { status: 0, text: String(err), json: null }
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON（例如 HTML 错误页） */
  }
  return { status: res.status, text, json }
}

function errText(r) {
  if (!r.json) return r.text?.slice(0, 200) ?? ''
  const j = r.json
  return j.message || j.error_description || j.msg || j.error || JSON.stringify(j).slice(0, 200)
}

function unwrapRows(r) {
  return Array.isArray(r.json) ? r.json : []
}

const suffix = Date.now().toString(36).slice(-6)
const EMAIL_A = `campus.forum.verify.${suffix}.a@gmail.com`
const EMAIL_B = `campus.forum.verify.${suffix}.b@gmail.com`
const PASSWORD = `Verify-${suffix}-Pw1`
const DISPLAY_A = `验收甲${suffix.slice(-3)}`
const DISPLAY_B = `验收乙${suffix.slice(-3)}`

async function signUp(email, displayName) {
  const r = await request('/auth/v1/signup', {
    method: 'POST',
    body: { email, password: PASSWORD, data: { display_name: displayName } },
  })
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`注册失败 ${email}: ${r.status} ${errText(r)}`)
  }
  let token = r.json?.access_token
  if (!token) {
    // 项目开了「Confirm email」时注册不返回 session。
    // 如果给了数据库密码，就直接把测试账号标记为已确认，再走密码登录（仅测试账号）。
    const confirmed = await autoConfirm(email)
    if (confirmed) {
      const login = await request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email, password: PASSWORD },
      })
      if (login.status === 200 && login.json?.access_token) {
        token = login.json.access_token
        console.log(`  （已用数据库直连确认测试账号邮箱：${email}）`)
      }
    }
    if (!token) {
      throw new Error(
        `注册成功但没有返回 session（项目开启了邮箱确认）。请在 Supabase → Authentication → Sign In / Providers → Email 关闭 "Confirm email"，或给脚本提供 DB_PASSWORD/SUPABASE_REF/DB_HOST 让它自动确认测试账号`,
      )
    }
  }
  return { token, userId: r.json.user?.id }
}

/* ---------------- 数据库直连（可选，仅用于自动确认测试账号邮箱） ---------------- */

let dbClient = null
/** 懒加载数据库直连；没有配置 DB_* 环境变量时返回 null（脚本降级为纯 HTTP 检查） */
async function getDbClient() {
  if (dbClient) return dbClient
  const password = process.env.DB_PASSWORD
  const ref = process.env.SUPABASE_REF
  const host = process.env.DB_HOST
  if (!password || !ref || !host) return null
  const { Client } = await import('pg')
  dbClient = new Client({
    host,
    port: 5432,
    user: `postgres.${ref}`,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
  await dbClient.connect()
  return dbClient
}

async function autoConfirm(email) {
  try {
    const client = await getDbClient()
    if (!client) return false
    await client.query(
      `update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where lower(email) = lower($1)`,
      [email],
    )
    return true
  } catch (err) {
    console.log(`  （自动确认邮箱失败: ${err.message?.slice(0, 120)}）`)
    return false
  }
}

async function main() {
  console.log(`Supabase: ${BASE}`)
  console.log(`测试账号: ${EMAIL_A} / ${EMAIL_B}`)

  /* ---------- 1. 结构与种子 ---------- */
  section('1. 表与种子数据（anon 可读）')
  const boards = await request('/rest/v1/boards?select=slug,name,sort_order&order=sort_order')
  check('boards 可读', boards.status === 200, `HTTP ${boards.status} ${errText(boards)}`)
  check('板块种子 5 条', unwrapRows(boards).length === 5, `实际 ${unwrapRows(boards).length}`)

  const config = await request('/rest/v1/app_config?select=key,value')
  check('app_config 可读', config.status === 200, `HTTP ${config.status} ${errText(config)}`)
  check('app_config 种子 5 条', unwrapRows(config).length === 5, `实际 ${unwrapRows(config).length}`)

  const postsAnon = await request('/rest/v1/posts?select=id')
  check('anon 可读 posts（空库为空数组）', postsAnon.status === 200 && Array.isArray(postsAnon.json), `HTTP ${postsAnon.status} ${errText(postsAnon)}`)

  const profilesAnon = await request('/rest/v1/profiles?select=id,display_name')
  check('anon 可读 profiles 公开列', profilesAnon.status === 200, `HTTP ${profilesAnon.status} ${errText(profilesAnon)}`)

  const handlesAnon = await request('/rest/v1/user_handles?select=username')
  check('anon 读不到 user_handles', handlesAnon.status === 200 ? unwrapRows(handlesAnon).length === 0 : handlesAnon.status >= 400, `HTTP ${handlesAnon.status} ${errText(handlesAnon)}`)

  const adminProfilesAnon = await request('/rest/v1/admin_profiles?select=id')
  check('anon 读不到 admin_profiles', adminProfilesAnon.status >= 400 || unwrapRows(adminProfilesAnon).length === 0, `HTTP ${adminProfilesAnon.status}`)

  /* ---------- 2. 未登录不能写 ---------- */
  section('2. 未登录（anon）不能写')
  const anonInsertPost = await request('/rest/v1/posts', {
    method: 'POST',
    body: { board_slug: 'chat', title: 'anon 注入测试', content: 'x' },
    prefer: 'return=representation',
  })
  check('anon 不能发帖', anonInsertPost.status >= 400, `HTTP ${anonInsertPost.status}`)

  const anonDeletePost = await request('/rest/v1/posts?id=eq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' })
  check('anon 不能删帖', anonDeletePost.status >= 400 || anonDeletePost.status === 204, `HTTP ${anonDeletePost.status}`)

  /* ---------- 3. 注册与资料 ---------- */
  section('3. 注册 / 触发器建资料 / my_profile')
  let userA
  let userB
  try {
    userA = await signUp(EMAIL_A, DISPLAY_A)
    userB = await signUp(EMAIL_B, DISPLAY_B)
  } catch (err) {
    check('注册两个测试账号', false, err.message)
    return summary()
  }
  check('注册两个测试账号', Boolean(userA.token && userB.token))

  const profileA = await request('/rest/v1/rpc/my_profile', { method: 'POST', token: userA.token, body: {} })
  const pA = Array.isArray(profileA.json) ? profileA.json[0] : profileA.json
  check('my_profile 可用', profileA.status === 200, `HTTP ${profileA.status} ${errText(profileA)}`)
  check('触发器建了 profiles', pA?.display_name === DISPLAY_A, `display_name=${pA?.display_name}`)
  check('触发器建了 user_handles（username 合法）', /^[a-z0-9_]{3,20}$/.test(pA?.username ?? ''), `username=${pA?.username}`)
  check('新用户 role=user', pA?.role === 'user', `role=${pA?.role}`)
  check('新用户 is_active=true', pA?.is_active === true, `is_active=${pA?.is_active}`)

  /* ---------- 4. 帖子 ---------- */
  section('4. 发帖 / 列表 / 详情')
  const title = `验收帖子 ${suffix}`
  const content = '这是一条自动化验收内容，含关键词 verification-keyword。'
  const created = await request('/rest/v1/posts', {
    method: 'POST',
    token: userA.token,
    body: { board_slug: 'chat', title, content },
    prefer: 'return=representation',
    headers: { Prefer: 'return=representation' },
  })
  const newPost = Array.isArray(created.json) ? created.json[0] : created.json
  check('登录用户能发帖', created.status === 201, `HTTP ${created.status} ${errText(created)}`)
  check('author_id 由数据库填充', newPost?.author_id === userA.userId, `author_id=${newPost?.author_id}`)
  check('计数初始为 0', newPost?.like_count === 0 && newPost?.comment_count === 0, JSON.stringify(newPost))

  const postId = newPost?.id
  if (!postId) {
    console.error('没有拿到帖子 id，后续测试跳过')
    return summary()
  }

  const listAnon = await request(`/rest/v1/posts?select=id,title,author:profiles!posts_author_id_fkey(display_name)&id=eq.${postId}`)
  check('anon 能看到新帖（含作者昵称）', listAnon.status === 200 && unwrapRows(listAnon)[0]?.author?.display_name === DISPLAY_A, JSON.stringify(listAnon.json)?.slice(0, 200))

  const search = await request('/rest/v1/rpc/search_posts', {
    method: 'POST',
    body: { p_query: 'verification-keyword', p_board: null, p_sort: 'new', p_limit: 10, p_offset: 0 },
  })
  const searchRows = unwrapRows(search)
  check('search_posts 命中且带作者昵称', search.status === 200 && searchRows.some((r) => r.id === postId && r.author_display_name === DISPLAY_A), `HTTP ${search.status} ${errText(search)}`)

  const searchWildcard = await request('/rest/v1/rpc/search_posts', {
    method: 'POST',
    body: { p_query: '100%', p_board: null, p_sort: 'new', p_limit: 10, p_offset: 0 },
  })
  check('search_posts 通配符不报错', searchWildcard.status === 200, `HTTP ${searchWildcard.status} ${errText(searchWildcard)}`)

  const searchEmpty = await request('/rest/v1/rpc/search_posts', {
    method: 'POST',
    body: { p_query: '   ', p_board: null, p_sort: 'new', p_limit: 10, p_offset: 0 },
  })
  check('search_posts 空关键词返回空集', searchEmpty.status === 200 && unwrapRows(searchEmpty).length === 0)

  /* ---------- 4.1 时间筛选（p_since / p_until） ---------- */
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString()
  const past = hoursAgo(48)
  const future = hoursAgo(-1)

  const sinceHit = await request('/rest/v1/rpc/search_posts', {
    method: 'POST',
    body: { p_query: 'verification-keyword', p_since: past, p_until: future },
  })
  check(
    'search_posts 时间区间内命中',
    sinceHit.status === 200 && unwrapRows(sinceHit).some((r) => r.id === postId),
    `HTTP ${sinceHit.status} ${errText(sinceHit)}`,
  )

  const sinceMiss = await request('/rest/v1/rpc/search_posts', {
    method: 'POST',
    body: { p_query: 'verification-keyword', p_since: future },
  })
  check(
    'search_posts p_since 晚于发帖时间 → 不命中',
    sinceMiss.status === 200 && unwrapRows(sinceMiss).length === 0,
    `HTTP ${sinceMiss.status} ${errText(sinceMiss)}`,
  )

  const untilMiss = await request('/rest/v1/rpc/search_posts', {
    method: 'POST',
    body: { p_query: 'verification-keyword', p_until: past },
  })
  check(
    'search_posts p_until 早于发帖时间 → 不命中',
    untilMiss.status === 200 && unwrapRows(untilMiss).length === 0,
    `HTTP ${untilMiss.status} ${errText(untilMiss)}`,
  )

  const legacyArgs = await request('/rest/v1/rpc/search_posts', {
    method: 'POST',
    body: { p_query: 'verification-keyword', p_limit: 10 },
  })
  check(
    'search_posts 不传时间参数（兼容旧调用）仍命中',
    legacyArgs.status === 200 && unwrapRows(legacyArgs).some((r) => r.id === postId),
    `HTTP ${legacyArgs.status} ${errText(legacyArgs)}`,
  )

  const listSince = await request(
    `/rest/v1/posts?select=id&id=eq.${postId}&created_at=gte.${encodeURIComponent(past)}`,
  )
  check('列表按 created_at >= 过滤命中', unwrapRows(listSince).some((r) => r.id === postId))

  const listUntil = await request(
    `/rest/v1/posts?select=id&id=eq.${postId}&created_at=lt.${encodeURIComponent(past)}`,
  )
  check('列表按 created_at < 过滤排除', unwrapRows(listUntil).length === 0)

  /* ---------- 5. 互动 ---------- */
  // ---------- 4.5 图片字段：协议白名单 + 数量上限 ----------
const badScheme = await request('/rest/v1/posts', {
  method: 'POST',
  token: userA.token,
  body: {
    board_slug: 'chat',
    title: '图片协议校验用例',
    content: '测试',
    images: ['javascript:alert(document.cookie)'],
  },
})
check('图片地址白名单：javascript: 被拒绝', badScheme.status >= 400, `HTTP ${badScheme.status}`)

const badDataUri = await request('/rest/v1/posts', {
  method: 'POST',
  token: userA.token,
  body: {
    board_slug: 'chat',
    title: '图片协议校验用例2',
    content: '测试',
    images: ['data:image/svg+xml,<svg onload=alert(1)>'],
  },
})
check('图片地址白名单：data: 被拒绝', badDataUri.status >= 400, `HTTP ${badDataUri.status}`)

const badSchemeFtp = await request('/rest/v1/posts', {
  method: 'POST',
  token: userA.token,
  body: {
    board_slug: 'chat',
    title: '图片协议校验用例3',
    content: '测试',
    images: ['ftp://evil.example.com/x.png'],
  },
})
check('图片地址白名单：ftp 被拒绝', badSchemeFtp.status >= 400, `HTTP ${badSchemeFtp.status}`)

const tooManyImages = await request('/rest/v1/posts', {
  method: 'POST',
  token: userA.token,
  body: {
    board_slug: 'chat',
    title: '图片数量校验用例',
    content: '测试',
    images: Array.from({ length: 5 }, (_, i) => `https://i.ibb.co/x${i}.png`),
  },
})
check('单帖图片数量上限：5 张被拒绝', tooManyImages.status >= 400, `HTTP ${tooManyImages.status}`)

const goodImagePost = await request('/rest/v1/posts', {
  method: 'POST',
  token: userA.token,
  prefer: 'return=representation',
  body: {
    board_slug: 'chat',
    title: '正常图片地址用例',
    content: '测试',
    images: ['https://i.ibb.co/abc/test.png'],
  },
})
check('正常 https 图片地址可以发布', goodImagePost.status === 201, `HTTP ${goodImagePost.status}`)

section('5. 点赞 / 踩 / 收藏 / 关注')
  const voteUp = await request('/rest/v1/rpc/vote_post', { method: 'POST', token: userB.token, body: { p_post_id: postId, p_value: 1 } })
  const v1 = unwrapRows(voteUp)[0]
  check('B 点赞 → like_count=1 my_vote=1', voteUp.status === 200 && v1?.like_count === 1 && v1?.my_vote === 1, `${voteUp.status} ${JSON.stringify(voteUp.json)}`)

  const voteCancel = await request('/rest/v1/rpc/vote_post', { method: 'POST', token: userB.token, body: { p_post_id: postId, p_value: 0 } })
  const v2 = unwrapRows(voteCancel)[0]
  check('B 再点 → 取消 my_vote=null', v2?.like_count === 0 && v2?.my_vote === null, JSON.stringify(voteCancel.json))

  const voteDown = await request('/rest/v1/rpc/vote_post', { method: 'POST', token: userB.token, body: { p_post_id: postId, p_value: -1 } })
  const v3 = unwrapRows(voteDown)[0]
  check('B 点踩 → dislike_count=1', v3?.dislike_count === 1, JSON.stringify(voteDown.json))

  const voteSwitch = await request('/rest/v1/rpc/vote_post', { method: 'POST', token: userB.token, body: { p_post_id: postId, p_value: 1 } })
  const v4 = unwrapRows(voteSwitch)[0]
  check('赞踩切换守恒', v4?.like_count === 1 && v4?.dislike_count === 0, JSON.stringify(voteSwitch.json))

  const favOn = await request('/rest/v1/rpc/toggle_favorite', { method: 'POST', token: userB.token, body: { p_post_id: postId } })
  const f1 = unwrapRows(favOn)[0]
  check('B 收藏 → favorited=true', f1?.favorited === true && f1?.favorite_count === 1, JSON.stringify(favOn.json))
  const favOff = await request('/rest/v1/rpc/toggle_favorite', { method: 'POST', token: userB.token, body: { p_post_id: postId } })
  check('B 再点 → 取消收藏', unwrapRows(favOff)[0]?.favorited === false, JSON.stringify(favOff.json))

  const followOn = await request('/rest/v1/rpc/toggle_follow', { method: 'POST', token: userB.token, body: { p_target_id: userA.userId } })
  check('B 关注 A → following=true', unwrapRows(followOn)[0]?.following === true, JSON.stringify(followOn.json))
  const following = await request('/rest/v1/rpc/my_following', { method: 'POST', token: userB.token, body: {} })
  check('my_following 包含 A', unwrapRows(following).some((u) => u.user_id === userA.userId), JSON.stringify(following.json)?.slice(0, 200))

  const authorProfile = await request('/rest/v1/rpc/author_profile', { method: 'POST', token: userB.token, body: { p_user_id: userA.userId } })
  const ap = unwrapRows(authorProfile)[0]
  check('author_profile 返回公开字段', authorProfile.status === 200 && ap?.display_name === DISPLAY_A && ap?.post_count >= 1 && ap?.follower_count === 1 && ap?.is_following === true, JSON.stringify(authorProfile.json)?.slice(0, 300))
  check('author_profile 不含 role/is_active', ap ? !('role' in ap) && !('is_active' in ap) : false)

  const postsByAuthor = await request('/rest/v1/rpc/posts_by_author', { method: 'POST', token: userB.token, body: { p_user_id: userA.userId, p_limit: 10, p_offset: 0 } })
  check('posts_by_author 返回帖子', unwrapRows(postsByAuthor).some((p) => p.id === postId), JSON.stringify(postsByAuthor.json)?.slice(0, 200))

  /* ---------- 6. 评论与通知 ---------- */
  section('6. 评论 / 计数 / 通知')
  const comment = await request('/rest/v1/comments', {
    method: 'POST',
    token: userB.token,
    body: { post_id: postId, content: '验收评论：说得好。' },
    headers: { Prefer: 'return=representation' },
  })
  const newComment = Array.isArray(comment.json) ? comment.json[0] : comment.json
  check('B 能评论', comment.status === 201, `HTTP ${comment.status} ${errText(comment)}`)

  const afterComment = await request(`/rest/v1/posts?select=comment_count&id=eq.${postId}`)
  check('comment_count 触发器 +1', unwrapRows(afterComment)[0]?.comment_count === 1, JSON.stringify(afterComment.json))

  const notifA = await request('/rest/v1/notifications?select=id,type,is_read,actor_id&order=created_at.desc', { token: userA.token })
  const notifRows = unwrapRows(notifA)
  check('A 收到评论通知', notifA.status === 200 && notifRows.some((n) => n.type === 'comment' && n.is_read === false), `HTTP ${notifA.status} ${JSON.stringify(notifA.json)?.slice(0, 200)}`)

  const notifB = await request('/rest/v1/notifications?select=id', { token: userB.token })
  check('B 的评论没有给自己发通知', unwrapRows(notifB).length === 0, JSON.stringify(notifB.json)?.slice(0, 100))

  /* ---------- 6.5 楼中楼：回复评论 ---------- */
  const commentId = newComment?.id
  const reply = await request('/rest/v1/comments', {
    method: 'POST',
    token: userA.token,
    body: { post_id: postId, content: '验收回复：收到你的评论', parent_id: commentId },
    headers: { Prefer: 'return=representation' },
  })
  const newReply = Array.isArray(reply.json) ? reply.json[0] : reply.json
  check('A 能回复 B 的评论（parent_id 生效）', reply.status === 201 && newReply?.parent_id === commentId, `HTTP ${reply.status} ${errText(reply)}`)

  const afterReply = await request(`/rest/v1/posts?select=comment_count&id=eq.${postId}`)
  check('回复也计入 comment_count（=2）', unwrapRows(afterReply)[0]?.comment_count === 2, JSON.stringify(afterReply.json))

  /* ---------- 6.4 评论点赞 ---------- */
  const likeC1 = await request('/rest/v1/rpc/toggle_comment_like', {
    method: 'POST',
    token: userA.token,
    body: { p_comment_id: commentId },
  })
  const likeRow1 = unwrapRows(likeC1)[0]
  check(
    'A 能给 B 的评论点赞（liked=true，like_count=1）',
    likeC1.status === 200 && likeRow1?.liked === true && likeRow1?.like_count === 1,
    `HTTP ${likeC1.status} ${JSON.stringify(likeC1.json)}`,
  )

  const commentAfterLike = await request(`/rest/v1/comments?select=like_count&id=eq.${commentId}`)
  check('评论 like_count 已落库为 1', unwrapRows(commentAfterLike)[0]?.like_count === 1, JSON.stringify(commentAfterLike.json))

  const myLikes = await request(`/rest/v1/comment_likes?select=comment_id&comment_id=eq.${commentId}`, {
    token: userA.token,
  })
  check('A 能读到自己赞过的记录', unwrapRows(myLikes).length === 1, JSON.stringify(myLikes.json)?.slice(0, 120))

  const otherLikes = await request('/rest/v1/comment_likes?select=comment_id', { token: userB.token })
  check('B 读不到 A 的点赞记录（RLS 只返回本人）', unwrapRows(otherLikes).length === 0, JSON.stringify(otherLikes.json)?.slice(0, 120))

  const likeAgain = await request('/rest/v1/rpc/toggle_comment_like', {
    method: 'POST',
    token: userA.token,
    body: { p_comment_id: commentId },
  })
  const likeRow2 = unwrapRows(likeAgain)[0]
  check(
    '再点一次取消点赞（liked=false，like_count 归零）',
    likeAgain.status === 200 && likeRow2?.liked === false && likeRow2?.like_count === 0,
    JSON.stringify(likeAgain.json),
  )

  const likeB = await request('/rest/v1/rpc/toggle_comment_like', {
    method: 'POST',
    token: userB.token,
    body: { p_comment_id: commentId },
  })
  const likeRow3 = unwrapRows(likeB)[0]
  check('B 也能点赞（重复点赞只算一次）', likeRow3?.liked === true && likeRow3?.like_count === 1, JSON.stringify(likeB.json))

  const anonLike = await request('/rest/v1/rpc/toggle_comment_like', {
    method: 'POST',
    body: { p_comment_id: commentId },
  })
  check('未登录不能给评论点赞', anonLike.status >= 400, `HTTP ${anonLike.status} ${errText(anonLike)}`)

  const notifB2 = await request('/rest/v1/notifications?select=type,comment_id,is_read&order=created_at.desc', { token: userB.token })
  check(
    'B 收到 type=reply 通知（被回复）',
    unwrapRows(notifB2).some((n) => n.type === 'reply' && n.comment_id === newReply?.id),
    JSON.stringify(notifB2.json)?.slice(0, 200),
  )

  // 删除主评论 → 其下回复应一并软删，计数归零
  const delParent = await request('/rest/v1/rpc/soft_delete_comment', { method: 'POST', token: userB.token, body: { p_comment_id: commentId } })
  check('B 能删除自己的评论', delParent.status === 200 || delParent.status === 204, `HTTP ${delParent.status} ${errText(delParent)}`)
  const commentsLeft = await request(`/rest/v1/comments?select=id&post_id=eq.${postId}`)
  check('删除主评论后其回复一并隐藏', unwrapRows(commentsLeft).length === 0, JSON.stringify(commentsLeft.json))
  const afterCascade = await request(`/rest/v1/posts?select=comment_count&id=eq.${postId}`)
  check('级联删除后 comment_count 归零', unwrapRows(afterCascade)[0]?.comment_count === 0, JSON.stringify(afterCascade.json))

  const likeDeleted = await request('/rest/v1/rpc/toggle_comment_like', {
    method: 'POST',
    token: userA.token,
    body: { p_comment_id: commentId },
  })
  check('已删除的评论不能点赞', likeDeleted.status >= 400, `HTTP ${likeDeleted.status} ${errText(likeDeleted)}`)

  const readAll = await request('/rest/v1/rpc/mark_all_notifications_read', { method: 'POST', token: userA.token, body: {} })
  check('mark_all_notifications_read 可用', readAll.status === 200 || readAll.status === 204, `HTTP ${readAll.status} ${errText(readAll)}`)
  const unreadAfter = await request('/rest/v1/notifications?select=id&is_read=eq.false', { token: userA.token })
  check('已读后未读为 0', unwrapRows(unreadAfter).length === 0)

  /* ---------- 7. 越权（最关键） ---------- */
  section('7. 越权检查（普通用户必须被数据库拦住）')
  const escalateRole = await request(`/rest/v1/profiles?id=eq.${userB.userId}`, {
    method: 'PATCH',
    token: userB.token,
    body: { role: 'admin' },
  })
  check('不能给自己改 role', escalateRole.status >= 400 || unwrapRows(escalateRole).length === 0, `HTTP ${escalateRole.status}`)

  const escalateBan = await request(`/rest/v1/profiles?id=eq.${userB.userId}`, {
    method: 'PATCH',
    token: userB.token,
    body: { is_active: false },
  })
  check('不能改自己的 is_active', escalateBan.status >= 400 || unwrapRows(escalateBan).length === 0, `HTTP ${escalateBan.status}`)

  const fakeCount = await request(`/rest/v1/posts?id=eq.${postId}`, {
    method: 'PATCH',
    token: userA.token,
    body: { like_count: 9999 },
  })
  check('作者也不能直接改计数', fakeCount.status >= 400 || unwrapRows(fakeCount).length === 0, `HTTP ${fakeCount.status}`)

  const fakePin = await request(`/rest/v1/posts?id=eq.${postId}`, {
    method: 'PATCH',
    token: userA.token,
    body: { is_pinned: true },
  })
  check('作者也不能自己置顶', fakePin.status >= 400 || unwrapRows(fakePin).length === 0, `HTTP ${fakePin.status}`)

  const directVote = await request('/rest/v1/post_votes', {
    method: 'POST',
    token: userB.token,
    body: { post_id: postId, user_id: userB.userId, value: 1 },
  })
  check('不能直写 post_votes', directVote.status >= 400, `HTTP ${directVote.status}`)

  const directCommentLike = await request('/rest/v1/comment_likes', {
    method: 'POST',
    token: userB.token,
    body: { comment_id: commentId, user_id: userB.userId },
  })
  check('不能直写 comment_likes', directCommentLike.status >= 400, `HTTP ${directCommentLike.status}`)

  const directFav = await request('/rest/v1/favorites', {
    method: 'POST',
    token: userB.token,
    body: { user_id: userB.userId, post_id: postId },
  })
  check('不能直写 favorites', directFav.status >= 400, `HTTP ${directFav.status}`)

  const directFollow = await request('/rest/v1/follows', {
    method: 'POST',
    token: userB.token,
    body: { follower_id: userB.userId, target_id: userA.userId },
  })
  check('不能直写 follows', directFollow.status >= 400, `HTTP ${directFollow.status}`)

  const adminRpc = await request('/rest/v1/rpc/admin_set_active', {
    method: 'POST',
    token: userB.token,
    body: { p_user_id: userA.userId, p_active: false, p_reason: '越权测试', p_until: null },
  })
  check('普通用户不能调 admin_set_active', adminRpc.status >= 400, `HTTP ${adminRpc.status} ${errText(adminRpc)}`)

  const adminUsers = await request('/rest/v1/admin_profiles?select=id,role', { token: userB.token })
  check('普通用户读 admin_profiles 为空', adminUsers.status === 200 && unwrapRows(adminUsers).length === 0, `HTTP ${adminUsers.status} ${JSON.stringify(adminUsers.json)?.slice(0, 100)}`)

  const otherProfile = await request(`/rest/v1/profiles?select=role,is_active&id=eq.${userA.userId}`, { token: userB.token })
  check('读不到别人的 role/is_active', otherProfile.status >= 400 || unwrapRows(otherProfile).length === 0, `HTTP ${otherProfile.status}`)

  /* ---------- 8. 举报 / 软删 ---------- */
  section('8. 举报 / 软删除')
  const report = await request('/rest/v1/reports', {
    method: 'POST',
    token: userB.token,
    body: { target_type: 'post', target_id: postId, reason: '其他', detail: '自动化验收举报' },
    headers: { Prefer: 'return=minimal' },
  })
  check('B 能举报帖子', report.status === 201 || report.status === 204, `HTTP ${report.status} ${errText(report)}`)

  const myReports = await request('/rest/v1/reports?select=id,status&reporter_id=eq.' + userB.userId, { token: userB.token })
  check('举报人能看到自己的举报', unwrapRows(myReports).some((r) => r.status === 'pending'), JSON.stringify(myReports.json)?.slice(0, 200))

  const deleteOther = await request('/rest/v1/rpc/soft_delete_post', { method: 'POST', token: userB.token, body: { p_post_id: postId } })
  check('B 不能删 A 的帖子', deleteOther.status >= 400, `HTTP ${deleteOther.status} ${errText(deleteOther)}`)

  const deleteOwn = await request('/rest/v1/rpc/soft_delete_post', { method: 'POST', token: userA.token, body: { p_post_id: postId } })
  check('A 能软删自己的帖子', deleteOwn.status === 200 || deleteOwn.status === 204, `HTTP ${deleteOwn.status} ${errText(deleteOwn)}`)

  const postAfterDelete = await request(`/rest/v1/posts?select=id&id=eq.${postId}`)
  check('软删后 anon 看不到帖子', unwrapRows(postAfterDelete).length === 0)

  // 举报必须指向真实存在的对象，且不能举报自己（reports.target_id 没有外键，靠触发器兜）
  const ghostReport = await request('/rest/v1/reports', {
    method: 'POST',
    token: userB.token,
    body: {
      target_type: 'post',
      target_id: '00000000-0000-4000-8000-0000000000aa',
      reason: '垃圾广告',
      detail: '举报一个不存在的帖子',
    },
  })
  check('不能举报不存在的帖子', ghostReport.status >= 400, `HTTP ${ghostReport.status} ${errText(ghostReport)}`)

  const selfReport = await request('/rest/v1/reports', {
    method: 'POST',
    token: userB.token,
    body: { target_type: 'user', target_id: userB.userId, reason: '其他', detail: '举报自己' },
  })
  check('不能举报自己', selfReport.status >= 400, `HTTP ${selfReport.status} ${errText(selfReport)}`)

  /* ---------- 9. 违禁词检测 ---------- */
  section('9. 违禁词检测（发帖 / 评论 / 昵称 / 用户名）')

  const hitAnon = await request('/rest/v1/rpc/check_banned_word', {
    method: 'POST',
    body: { p_text: '这里含傻逼两个字' },
  })
  check(
    '匿名可预检违禁词（返回命中的词）',
    hitAnon.status === 200 && hitAnon.json === '傻逼',
    `HTTP ${hitAnon.status} ${JSON.stringify(hitAnon.json)?.slice(0, 120)}`,
  )

  const cleanAnon = await request('/rest/v1/rpc/check_banned_word', {
    method: 'POST',
    body: { p_text: '今天食堂的红烧肉不错' },
  })
  check('正常文本预检返回 null', cleanAnon.status === 200 && cleanAnon.json === null, JSON.stringify(cleanAnon.json))

  const obfuscated = await request('/rest/v1/rpc/check_banned_word', {
    method: 'POST',
    body: { p_text: 'F U C K 这种写法也要拦' },
  })
  check(
    '忽略大小写与空白的变体也能命中',
    obfuscated.status === 200 && obfuscated.json === 'fuck',
    JSON.stringify(obfuscated.json),
  )

  const wordsAnon = await request('/rest/v1/banned_words?select=word')
  check(
    'anon 读不到违禁词库',
    wordsAnon.status >= 400 || unwrapRows(wordsAnon).length === 0,
    `HTTP ${wordsAnon.status}`,
  )

  // 零宽 / 软连字符 / BOM 之类的不可见字符不能用来把违禁词拆开绕过
  const invisibleVariants = [
    ['零宽空格', '代开\u200b发票'],
    ['软连字符', '代开\u00ad发票'],
    ['BOM', '代开\ufeff发票'],
    ['零宽连接符', '赌博\u200d网站'],
  ]
  for (const [label, text] of invisibleVariants) {
    const res = await request('/rest/v1/rpc/check_banned_word', {
      method: 'POST',
      body: { p_text: text },
    })
    check(
      `插入${label}不能绕过违禁词`,
      res.status === 200 && typeof res.json === 'string' && res.json.length > 0,
      `HTTP ${res.status} ${JSON.stringify(res.json)}`,
    )
  }

  const plainPostRes = await request('/rest/v1/posts', {
    method: 'POST',
    token: userA.token,
    body: { board_slug: 'chat', title: '违禁词验收帖', content: '正常正文，用来测评论违禁词。' },
    headers: { Prefer: 'return=representation' },
  })
  const plainPost = Array.isArray(plainPostRes.json) ? plainPostRes.json[0] : plainPostRes.json
  check('正常帖子仍能发布', plainPostRes.status === 201 && Boolean(plainPost?.id), `HTTP ${plainPostRes.status} ${errText(plainPostRes)}`)

  const badTitlePost = await request('/rest/v1/posts', {
    method: 'POST',
    token: userA.token,
    body: { board_slug: 'chat', title: '傻逼标题', content: '正常正文' },
  })
  check(
    '标题含违禁词被拒绝',
    badTitlePost.status >= 400 && /违禁词/.test(errText(badTitlePost)),
    `HTTP ${badTitlePost.status} ${errText(badTitlePost)}`,
  )

  const badContentPost = await request('/rest/v1/posts', {
    method: 'POST',
    token: userA.token,
    body: { board_slug: 'chat', title: '正常标题', content: '正文里写代开发票，应该被拦。' },
  })
  check(
    '正文含违禁词被拒绝',
    badContentPost.status >= 400 && /违禁词/.test(errText(badContentPost)),
    `HTTP ${badContentPost.status} ${errText(badContentPost)}`,
  )

  const badComment = await request('/rest/v1/comments', {
    method: 'POST',
    token: userB.token,
    body: { post_id: plainPost.id, content: '评论里骂傻逼' },
  })
  check(
    '评论含违禁词被拒绝',
    badComment.status >= 400 && /违禁词/.test(errText(badComment)),
    `HTTP ${badComment.status} ${errText(badComment)}`,
  )

  const goodComment = await request('/rest/v1/comments', {
    method: 'POST',
    token: userB.token,
    body: { post_id: plainPost.id, content: '正常评论：支持一下。' },
    headers: { Prefer: 'return=representation' },
  })
  check('正常评论仍能发布', goodComment.status === 201, `HTTP ${goodComment.status} ${errText(goodComment)}`)

  const badName = await request(`/rest/v1/profiles?id=eq.${userB.userId}`, {
    method: 'PATCH',
    token: userB.token,
    body: { display_name: '傻逼用户' },
  })
  check(
    '昵称含违禁词被拒绝',
    badName.status >= 400 && /违禁词/.test(errText(badName)),
    `HTTP ${badName.status} ${errText(badName)}`,
  )

  const goodName = await request(`/rest/v1/profiles?id=eq.${userB.userId}`, {
    method: 'PATCH',
    token: userB.token,
    body: { display_name: DISPLAY_B },
  })
  check('正常昵称仍能修改', goodName.status === 204 || goodName.status === 200, `HTTP ${goodName.status} ${errText(goodName)}`)

  // 简介（bio）对外可见，同样要过词库
  const badBio = await request(`/rest/v1/profiles?id=eq.${userB.userId}`, {
    method: 'PATCH',
    token: userB.token,
    body: { bio: '这里写代开发票的广告' },
  })
  check(
    '简介含违禁词被拒绝',
    badBio.status >= 400 && /违禁词/.test(errText(badBio)),
    `HTTP ${badBio.status} ${errText(badBio)}`,
  )

  const goodBio = await request(`/rest/v1/profiles?id=eq.${userB.userId}`, {
    method: 'PATCH',
    token: userB.token,
    body: { bio: '喜欢打篮球和看剧' },
  })
  check('正常简介仍能修改', goodBio.status === 204 || goodBio.status === 200, `HTTP ${goodBio.status} ${errText(goodBio)}`)

  const bannedWrite = await request('/rest/v1/banned_words', {
    method: 'POST',
    token: userB.token,
    body: { word: '越权词' },
  })
  check('不能直写 banned_words', bannedWrite.status >= 400, `HTTP ${bannedWrite.status}`)

  const bannedListAsUser = await request('/rest/v1/rpc/admin_banned_words', {
    method: 'POST',
    token: userB.token,
    body: {},
  })
  check('普通用户不能查违禁词库', bannedListAsUser.status >= 400, `HTTP ${bannedListAsUser.status} ${errText(bannedListAsUser)}`)

  const bannedAddAsUser = await request('/rest/v1/rpc/admin_add_banned_word', {
    method: 'POST',
    token: userB.token,
    body: { p_word: '越权词', p_note: null },
  })
  check('普通用户不能添加违禁词', bannedAddAsUser.status >= 400, `HTTP ${bannedAddAsUser.status} ${errText(bannedAddAsUser)}`)

  // 收尾：把验收帖软删，避免留在前台
  await request('/rest/v1/rpc/soft_delete_post', { method: 'POST', token: userA.token, body: { p_post_id: plainPost.id } })

  /* ---------- 10. 意见反馈 ---------- */
  // ---------- 9.5 全站计数一致性（用数据库直连统计，避免 RLS 只看得到自己的投票）----------
const statsClient = await getDbClient()
if (statsClient) {
  const drift = (
    await statsClient.query(`
      select
        (select count(*)::int from public.posts p
          where p.like_count <> (select count(*) from public.post_votes v where v.post_id = p.id and v.value = 1)) as like_bad,
        (select count(*)::int from public.posts p
          where p.dislike_count <> (select count(*) from public.post_votes v where v.post_id = p.id and v.value = -1)) as dislike_bad,
        (select count(*)::int from public.posts p
          where p.comment_count <> (select count(*) from public.comments c where c.post_id = p.id and c.is_deleted = false)) as comment_bad,
        (select count(*)::int from public.posts p
          where p.favorite_count <> (select count(*) from public.favorites f where f.post_id = p.id)) as favorite_bad,
        (select count(*)::int from public.comments c
          where c.like_count <> (select count(*) from public.comment_likes l where l.comment_id = c.id)) as comment_like_bad
    `)
  ).rows[0]

  check('全站 like_count 与实际投票一致', drift.like_bad === 0, `${drift.like_bad} 条不一致`)
  check('全站 dislike_count 与实际投票一致', drift.dislike_bad === 0, `${drift.dislike_bad} 条不一致`)
  check('全站 comment_count 与实际评论一致', drift.comment_bad === 0, `${drift.comment_bad} 条不一致`)
  check('全站 favorite_count 与实际收藏一致', drift.favorite_bad === 0, `${drift.favorite_bad} 条不一致`)
  check('全站评论点赞数与实际一致', drift.comment_like_bad === 0, `${drift.comment_like_bad} 条不一致`)
} else {
  console.log('  - 跳过全站计数一致性检查（没有数据库直连）')
}

section('10. 意见反馈（提交 / 我的 / 隐私 / 越权）')

  const FEEDBACK_TEXT = `验收反馈内容 ${suffix}：希望首页增加夜间模式。`

  const anonFeedback = await request('/rest/v1/rpc/submit_feedback', {
    method: 'POST',
    body: { p_content: '匿名也想提建议，应该被拒绝' },
  })
  check('未登录不能提交反馈', anonFeedback.status >= 400, `HTTP ${anonFeedback.status} ${errText(anonFeedback)}`)

  const submit = await request('/rest/v1/rpc/submit_feedback', {
    method: 'POST',
    token: userA.token,
    body: { p_content: FEEDBACK_TEXT, p_category: '建议', p_contact: 'qa@example.com' },
  })
  check('登录用户能提交反馈', submit.status === 200 || submit.status === 204, `HTTP ${submit.status} ${errText(submit)}`)

  const mine = await request('/rest/v1/rpc/my_feedback', { method: 'POST', token: userA.token, body: {} })
  const mineRows = unwrapRows(mine)
  check(
    'my_feedback 能看到自己刚提交的反馈',
    mineRows.some((r) => r.content === FEEDBACK_TEXT && r.status === 'pending' && r.contact === 'qa@example.com'),
    JSON.stringify(mineRows)?.slice(0, 200),
  )

  const mineB = await request('/rest/v1/rpc/my_feedback', { method: 'POST', token: userB.token, body: {} })
  check(
    'B 的 my_feedback 看不到 A 的反馈',
    !unwrapRows(mineB).some((r) => r.content === FEEDBACK_TEXT),
    JSON.stringify(unwrapRows(mineB))?.slice(0, 160),
  )

  const defaultCategory = await request('/rest/v1/rpc/submit_feedback', {
    method: 'POST',
    token: userB.token,
    body: { p_content: `B 的默认类型反馈 ${suffix}` },
  })
  const mineAfterDefault = await request('/rest/v1/rpc/my_feedback', { method: 'POST', token: userB.token, body: {} })
  check(
    '不传类型时默认为「建议」',
    defaultCategory.status < 400 && unwrapRows(mineAfterDefault).some((r) => r.category === '建议'),
    JSON.stringify(unwrapRows(mineAfterDefault))?.slice(0, 160),
  )

  const tooShort = await request('/rest/v1/rpc/submit_feedback', {
    method: 'POST',
    token: userA.token,
    body: { p_content: '太短' },
  })
  check('反馈内容过短被拒绝', tooShort.status >= 400 && /至少写 5 个字/.test(errText(tooShort)), `HTTP ${tooShort.status} ${errText(tooShort)}`)

  const bannedFeedback = await request('/rest/v1/rpc/submit_feedback', {
    method: 'POST',
    token: userA.token,
    body: { p_content: '反馈里骂傻逼，应该被违禁词拦下' },
  })
  check(
    '反馈内容含违禁词被拒绝',
    bannedFeedback.status >= 400 && /违禁词/.test(errText(bannedFeedback)),
    `HTTP ${bannedFeedback.status} ${errText(bannedFeedback)}`,
  )

  const directRead = await request('/rest/v1/feedback?select=content', { token: userA.token })
  check(
    '不能直读 feedback 表（隐私字段走 RPC）',
    directRead.status >= 400 || unwrapRows(directRead).length === 0,
    `HTTP ${directRead.status}`,
  )

  const directWrite = await request('/rest/v1/feedback', {
    method: 'POST',
    token: userA.token,
    body: { content: '直写应该失败的内容' },
  })
  check('不能直写 feedback 表', directWrite.status >= 400, `HTTP ${directWrite.status} ${errText(directWrite)}`)

  const adminListAsUser = await request('/rest/v1/rpc/admin_feedback', { method: 'POST', token: userB.token, body: {} })
  check('普通用户不能查看全部反馈', adminListAsUser.status >= 400, `HTTP ${adminListAsUser.status} ${errText(adminListAsUser)}`)

  const adminResolveAsUser = await request('/rest/v1/rpc/admin_resolve_feedback', {
    method: 'POST',
    token: userB.token,
    body: { p_id: mineRows[0]?.id, p_status: 'resolved' },
  })
  check('普通用户不能标记反馈已处理', adminResolveAsUser.status >= 400, `HTTP ${adminResolveAsUser.status} ${errText(adminResolveAsUser)}`)

  const mineAnon = await request('/rest/v1/rpc/my_feedback', { method: 'POST', body: {} })
  check('未登录不能查看我的反馈', mineAnon.status >= 400, `HTTP ${mineAnon.status}`)

  /* ---------- 11. 好友 / 私信（二期） ---------- */
  section('11. 好友 / 私信（搜人 / 申请 / 拉黑 / 私信 / 越权）')

  const anonSearch = await request('/rest/v1/rpc/search_users', {
    method: 'POST',
    body: { p_keyword: '验收', p_limit: 5 },
  })
  check('未登录不能搜人', anonSearch.status >= 400, `HTTP ${anonSearch.status}`)

  const oneChar = await request('/rest/v1/rpc/search_users', {
    method: 'POST',
    token: userA.token,
    body: { p_keyword: '验', p_limit: 5 },
  })
  check('搜人至少 2 个字（1 个字返回空）', oneChar.status === 200 && unwrapRows(oneChar).length === 0, JSON.stringify(oneChar.json)?.slice(0, 120))

  const found = await request('/rest/v1/rpc/search_users', {
    method: 'POST',
    token: userA.token,
    body: { p_keyword: DISPLAY_B.slice(0, 3), p_limit: 5 },
  })
  const foundB = unwrapRows(found).find((u) => u.user_id === userB.userId)
  check('能搜到目标用户', Boolean(foundB), JSON.stringify(found.json)?.slice(0, 200))
  check('搜人结果不含 username', foundB ? !('username' in foundB) : false, JSON.stringify(foundB))

  const selfReq = await request('/rest/v1/rpc/send_friend_request', {
    method: 'POST',
    token: userA.token,
    body: { p_to: userA.userId },
  })
  check('不能加自己为好友', selfReq.status >= 400 && /不能加自己/.test(errText(selfReq)), `HTTP ${selfReq.status} ${errText(selfReq)}`)

  const friendReq = await request('/rest/v1/rpc/send_friend_request', {
    method: 'POST',
    token: userA.token,
    body: { p_to: userB.userId, p_message: '验收好友申请' },
  })
  check('A 能给 B 发好友申请', friendReq.status === 200 || friendReq.status === 204, `HTTP ${friendReq.status} ${errText(friendReq)}`)

  const repeatReq = await request('/rest/v1/rpc/send_friend_request', {
    method: 'POST',
    token: userA.token,
    body: { p_to: userB.userId, p_message: '重复申请' },
  })
  check('重复申请不报错（覆盖留言）', repeatReq.status === 200 || repeatReq.status === 204, `HTTP ${repeatReq.status} ${errText(repeatReq)}`)

  const reqListB = await request('/rest/v1/rpc/my_friend_requests', { method: 'POST', token: userB.token, body: {} })
  const incoming = unwrapRows(reqListB).find((r) => r.peer_id === userA.userId && r.direction === 'incoming')
  check('B 能看到 A 的申请（direction=incoming）', Boolean(incoming), JSON.stringify(reqListB.json)?.slice(0, 200))

  const badgesB1 = await request('/rest/v1/rpc/social_badges', { method: 'POST', token: userB.token, body: {} })
  check('角标显示待处理申请 1 条', unwrapRows(badgesB1)[0]?.pending_requests === 1, JSON.stringify(badgesB1.json))

  const notMine = await request('/rest/v1/rpc/respond_friend_request', {
    method: 'POST',
    token: userA.token,
    body: { p_request_id: incoming?.request_id, p_accept: true },
  })
  check('不能同意发给别人的申请', notMine.status >= 400, `HTTP ${notMine.status} ${errText(notMine)}`)

  const accept = await request('/rest/v1/rpc/respond_friend_request', {
    method: 'POST',
    token: userB.token,
    body: { p_request_id: incoming?.request_id, p_accept: true },
  })
  check('B 能同意好友申请', accept.status === 200 || accept.status === 204, `HTTP ${accept.status} ${errText(accept)}`)

  const friendsA = await request('/rest/v1/rpc/my_friends', { method: 'POST', token: userA.token, body: {} })
  const friendsB = await request('/rest/v1/rpc/my_friends', { method: 'POST', token: userB.token, body: {} })
  check('同意后双向成为好友', unwrapRows(friendsA).some((f) => f.friend_id === userB.userId) && unwrapRows(friendsB).some((f) => f.friend_id === userA.userId), `A=${JSON.stringify(unwrapRows(friendsA).map((f) => f.relation))} B=${JSON.stringify(unwrapRows(friendsB).map((f) => f.relation))}`)

  const reAccept = await request('/rest/v1/rpc/respond_friend_request', {
    method: 'POST',
    token: userB.token,
    body: { p_request_id: incoming?.request_id, p_accept: true },
  })
  check('重复同意报「已经处理过了」', reAccept.status >= 400 && /已经处理过/.test(errText(reAccept)), `HTTP ${reAccept.status} ${errText(reAccept)}`)

  const dmToStranger = await request('/rest/v1/rpc/send_dm', {
    method: 'POST',
    token: userB.token,
    body: { p_to: userA.userId, p_content: 'x' },
  })
  check('好友之间可以发私信', dmToStranger.status === 200 || dmToStranger.status === 204, `HTTP ${dmToStranger.status} ${errText(dmToStranger)}`)

  const dmSend = await request('/rest/v1/rpc/send_dm', {
    method: 'POST',
    token: userA.token,
    body: { p_to: userB.userId, p_content: '验收私信第一条' },
  })
  check('A 能给好友 B 发私信', dmSend.status === 200 || dmSend.status === 204, `HTTP ${dmSend.status} ${errText(dmSend)}`)

  const convA = unwrapRows(await request('/rest/v1/rpc/my_conversations', { method: 'POST', token: userA.token, body: {} }))
  const conv = convA.find((c) => c.peer_id === userB.userId)
  check('A 的会话列表有未读 1 条', conv?.unread_count === 1, JSON.stringify(conv))

  const msgs = unwrapRows(await request('/rest/v1/rpc/dm_messages', {
    method: 'POST',
    token: userA.token,
    body: { p_conversation_id: conv?.conversation_id },
  }))
  check('能拉到会话消息', msgs.length >= 1, JSON.stringify(msgs).slice(0, 160))

  const afterSeq = unwrapRows(await request('/rest/v1/rpc/dm_messages', {
    method: 'POST',
    token: userA.token,
    body: { p_conversation_id: conv?.conversation_id, p_after_seq: 1 },
  }))
  check('p_after_seq 只返回增量', afterSeq.every((m) => m.seq > 1), JSON.stringify(afterSeq).slice(0, 120))

  await request('/rest/v1/rpc/mark_conversation_read', {
    method: 'POST',
    token: userA.token,
    body: { p_conversation_id: conv?.conversation_id },
  })
  const convA2 = unwrapRows(await request('/rest/v1/rpc/my_conversations', { method: 'POST', token: userA.token, body: {} }))
  check('标记已读后未读数归零', convA2.find((c) => c.peer_id === userB.userId)?.unread_count === 0, JSON.stringify(convA2.find((c) => c.peer_id === userB.userId)))

  const dmBanned = await request('/rest/v1/rpc/send_dm', {
    method: 'POST',
    token: userA.token,
    body: { p_to: userB.userId, p_content: '私信里发代开发票广告' },
  })
  check('私信含违禁词被拒绝', dmBanned.status >= 400 && /违禁词/.test(errText(dmBanned)), `HTTP ${dmBanned.status} ${errText(dmBanned)}`)

  const anonReadFriends = await request('/rest/v1/friendships?select=*')
  const userReadFriends = await request('/rest/v1/friendships?select=*', { token: userA.token })
  check('anon 读不到 friendships 表', anonReadFriends.status >= 400 || unwrapRows(anonReadFriends).length === 0, `HTTP ${anonReadFriends.status}`)
  check('登录用户读不到 friendships 表（只能走 RPC）', userReadFriends.status >= 400, `HTTP ${userReadFriends.status}`)

  const anonReadDm = await request('/rest/v1/direct_messages?select=*')
  check('anon 读不到私信表', anonReadDm.status >= 400 || unwrapRows(anonReadDm).length === 0, `HTTP ${anonReadDm.status}`)

  // 二期 Realtime 需要 conversations / direct_messages 可 SELECT，
  // 但 RLS 必须把范围限制在「自己参与的会话」，这里逐行核对。
  const dmRead = await request('/rest/v1/direct_messages?select=seq,conversation:conversations!direct_messages_conversation_id_fkey(user_a,user_b)', { token: userA.token })
  const dmRows = unwrapRows(dmRead)
  check(
    '登录用户能读到自己参与的私信（Realtime 需要 SELECT）',
    dmRead.status === 200 && dmRows.length >= 1,
    `HTTP ${dmRead.status} rows=${dmRows.length}`,
  )
  check(
    '私信读取被 RLS 限制在自己参与的会话',
    dmRows.every((r) => r.conversation && (r.conversation.user_a === userA.userId || r.conversation.user_b === userA.userId)),
    JSON.stringify(dmRows.slice(0, 3)),
  )

  const convRead = await request('/rest/v1/conversations?select=user_a,user_b', { token: userB.token })
  const convRows = unwrapRows(convRead)
  check(
    '会话列表读取被 RLS 限制在参与者',
    convRead.status === 200 && convRows.length >= 1 && convRows.every((c) => c.user_a === userB.userId || c.user_b === userB.userId),
    JSON.stringify(convRows.slice(0, 3)),
  )

  const removeF = await request('/rest/v1/rpc/remove_friend', {
    method: 'POST',
    token: userA.token,
    body: { p_friend_id: userB.userId },
  })
  check('A 能删好友', removeF.status === 200 || removeF.status === 204, `HTTP ${removeF.status}`)

  const friendsA2 = unwrapRows(await request('/rest/v1/rpc/my_friends', { method: 'POST', token: userA.token, body: {} }))
  const friendsB2 = unwrapRows(await request('/rest/v1/rpc/my_friends', { method: 'POST', token: userB.token, body: {} }))
  const halfB = friendsB2.find((f) => f.friend_id === userA.userId)
  check('删好友只删自己那条（A 空 / B 变 half）', !friendsA2.some((f) => f.friend_id === userB.userId) && halfB?.relation === 'half', `A=${friendsA2.length} B=${halfB?.relation}`)

  const dmAfterRemove = await request('/rest/v1/rpc/send_dm', {
    method: 'POST',
    token: userB.token,
    body: { p_to: userA.userId, p_content: '删了好友还能发吗' },
  })
  check('删好友后不能再发私信', dmAfterRemove.status >= 400, `HTTP ${dmAfterRemove.status} ${errText(dmAfterRemove)}`)

  await request('/rest/v1/rpc/set_friend_block', {
    method: 'POST',
    token: userA.token,
    body: { p_friend_id: userB.userId, p_blocked: true },
  })
  const blockedReq = await request('/rest/v1/rpc/send_friend_request', {
    method: 'POST',
    token: userB.token,
    body: { p_to: userA.userId },
  })
  check('被拉黑后不能加好友（文案不泄露细节）', blockedReq.status >= 400 && /当前无法添加/.test(errText(blockedReq)), `HTTP ${blockedReq.status} ${errText(blockedReq)}`)

  const blockedSearch = unwrapRows(await request('/rest/v1/rpc/search_users', {
    method: 'POST',
    token: userA.token,
    body: { p_keyword: DISPLAY_B.slice(0, 3), p_limit: 5 },
  })).find((u) => u.user_id === userB.userId)
  check('拉黑后搜人 relation=blocked', blockedSearch?.relation === 'blocked', JSON.stringify(blockedSearch))

  await request('/rest/v1/rpc/set_friend_block', {
    method: 'POST',
    token: userA.token,
    body: { p_friend_id: userB.userId, p_blocked: false },
  })
  const unblockedSearch = unwrapRows(await request('/rest/v1/rpc/search_users', {
    method: 'POST',
    token: userA.token,
    body: { p_keyword: DISPLAY_B.slice(0, 3), p_limit: 5 },
  })).find((u) => u.user_id === userB.userId)
  // 取消拉黑只删掉「我→他」那条阻塞行；B 那边仍留着好友行，所以正确结果是 half（不再是 blocked）
  check('取消拉黑后不再显示 blocked', unblockedSearch?.relation && unblockedSearch.relation !== 'blocked', JSON.stringify(unblockedSearch))

  summary()
  // 关掉数据库直连，避免进程挂住不退出
  if (dbClient) {
    try { await dbClient.end() } catch { /* ignore */ }
    dbClient = null
  }
}

function summary() {
  console.log(`\n${'='.repeat(56)}`)
  console.log(`结果：通过 ${passed}，失败 ${failed}`)
  if (failed > 0) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    console.log(
      '\n提示：如果是「数据库还没有初始化」，请先在 Supabase SQL Editor 执行 supabase/init.sql；' +
        '如果是 RLS/权限相关，把失败项和 SQL 片段发给开发排查。',
    )
    process.exitCode = 1
  } else {
    console.log('全部通过 ✅ 数据库、RLS 与 RPC 行为符合前端预期。')
  }
}

await main()
