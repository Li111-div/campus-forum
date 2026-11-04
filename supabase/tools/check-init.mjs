#!/usr/bin/env node
/**
 * init.sql / 接口契约 文本级自检脚本（不连数据库）
 *
 * 用法：node supabase/tools/check-init.mjs
 *
 * 检查内容：
 *   1. 文件分节顺序：表 → 函数 → 触发器 → 权限 → RLS 策略 → 种子
 *   2. 函数清单与预期完全一致（多一个少一个都报错）
 *   3. 每个 security definer 函数都有 set search_path = public
 *   4. 每个 grant execute 都能对上真实存在的函数签名与参数类型
 *   5. 匿名角色只拿到该拿的 RPC；内部/触发器函数不对外授权
 *   6. 返回列名、参数名、默认值与前端契约完全一致
 *   7. 触发器 / 策略都有 drop if exists 前置；策略引用的函数先定义
 *   8. 禁用项：profiles 禁列、明细表禁直写、禁自定义 _fkey 名
 *   9. 种子值符合简化口径（冷却 0 / 日限额 50、200 / 图片 0）
 *  10. 契约文档覆盖所有对前端暴露的 RPC 与关键返回列
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SUPABASE_DIR = path.resolve(__dirname, '..')
const APP_DIR = path.resolve(SUPABASE_DIR, '..')
const SQL_FILE = path.join(SUPABASE_DIR, 'init.sql')
const CONTRACT_FILE = path.join(APP_DIR, 'docs', '数据库-接口契约.md')

const sql = fs.readFileSync(SQL_FILE, 'utf8')

let passed = 0
const failures = []
function ok(name) { passed++; console.log(`PASS  ${name}`) }
function fail(name, detail) {
  failures.push({ name, detail })
  console.log(`FAIL  ${name}${detail ? `\n       ↳ ${detail}` : ''}`)
}
function check(name, cond, detail) { cond ? ok(name) : fail(name, detail) }

/* ------------------------------------------------------------------ */
/* 解析工具                                                            */
/* ------------------------------------------------------------------ */

const normType = (t) => t
  .trim()
  .toLowerCase()
  .replace(/^public\./, '')
  .replace(/\s+/g, '')
  .replace(/^(int|int4|integer)$/, 'int')
  .replace(/^(int2|smallint)$/, 'smallint')
  .replace(/^(bool|boolean)$/, 'boolean')

const normWs = (s) => s.replace(/\s+/g, ' ').trim()

/** 从 startIdx 处的 '(' 找到配对的 ')'，返回 { inner, end } */
function matchParen(text, startIdx) {
  let depth = 0
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { inner: text.slice(startIdx + 1, i), end: i }
    }
  }
  throw new Error(`括号不匹配 @${startIdx}`)
}

/** 顶层逗号切分 */
function splitTopLevel(text, sep = ',') {
  const out = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last) out.push(last)
  return out.filter(Boolean)
}

/** 解析参数列表：返回 [{name, type, default}] */
function parseParams(raw) {
  return splitTopLevel(raw).map((chunk) => {
    const m = chunk.match(/^(\w+)\s+([\s\S]+?)(?:\s+default\s+([\s\S]+))?$/i)
    if (!m) throw new Error(`无法解析参数: ${chunk}`)
    return {
      name: m[1].toLowerCase(),
      type: normType(m[2]),
      default: m[3] === undefined ? null : normWs(m[3]).toLowerCase().replace(/\s+/g, ''),
    }
  })
}

/** 解析 returns table(...) 的列；非 table 返回 null */
function parseReturnCols(returnSpec) {
  const m = returnSpec.match(/^table\s*\(([\s\S]*)\)$/i)
  if (!m) return null
  return splitTopLevel(m[1]).map((chunk) => {
    const parts = chunk.match(/^(\w+)\s+([\s\S]+)$/)
    if (!parts) throw new Error(`无法解析返回列: ${chunk}`)
    return { name: parts[1].toLowerCase(), type: normType(parts[2]) }
  })
}

/** 抽取所有 create or replace function 定义 */
function parseFunctions(text) {
  const defs = []
  const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi
  let m
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase()
    const openIdx = m.index + m[0].length - 1
    const { inner: argsRaw, end: closeIdx } = matchParen(text, openIdx)

    // 函数头：从 ')' 到 'as $tag$'
    const asMatch = text.slice(closeIdx).match(/\bas\s+\$(\w*)\$/)
    if (!asMatch) throw new Error(`找不到函数体起始: ${name}`)
    const asStart = closeIdx + asMatch.index
    const header = text.slice(closeIdx + 1, asStart)

    const retMatch = header.match(/returns\s+([\s\S]*?)\n\s*language/i)
    if (!retMatch) throw new Error(`找不到 returns 子句: ${name}`)
    const returnSpec = normWs(retMatch[1])

    const tag = asMatch[1]
    const bodyStart = asStart + asMatch[0].length
    const endTag = tag === '' ? '$$' : `$${tag}$`
    const bodyClose = text.indexOf(endTag, bodyStart)
    if (bodyClose === -1) throw new Error(`找不到函数体结束: ${name}`)

    defs.push({
      name,
      params: parseParams(argsRaw),
      returnSpec,
      returnCols: parseReturnCols(returnSpec),
      header,
      body: text.slice(bodyStart, bodyClose),
      offset: m.index,
    })
  }
  return defs
}

const fns = parseFunctions(sql)
const fnByName = new Map(fns.map((f) => [f.name, f]))

/** 抽取 grant execute on function ... */
function parseGrants(text) {
  const grants = []
  const re = /grant\s+execute\s+on\s+function\s+public\.(\w+)\s*\(([^)]*)\)\s*to\s+([^;]+);/gi
  let m
  while ((m = re.exec(text)) !== null) {
    grants.push({
      name: m[1].toLowerCase(),
      types: m[2].trim() ? m[2].split(',').map((t) => normType(t)) : [],
      roles: m[3].split(',').map((r) => r.trim().toLowerCase()).sort(),
      offset: m.index,
    })
  }
  return grants
}
const grants = parseGrants(sql)

/* ------------------------------------------------------------------ */
/* 1. 分节顺序                                                         */
/* ------------------------------------------------------------------ */
const boundaries = [
  ['-- 2. 表', 'schema(tables)'],
  ['-- 3. 基础判断函数', 'functions(helpers)'],
  ['-- 4. 触发器函数', 'functions(triggers)'],
  ['-- 5. RPC 函数', 'functions(rpc)'],
  ['-- 6. 触发器', 'triggers'],
  ['-- 7. 权限', 'privileges'],
  ['-- 8. RLS', 'policies'],
  ['-- 9. 种子数据', 'seed'],
]
let lastIdx = -1
let orderOk = true
for (const [marker, label] of boundaries) {
  const idx = sql.indexOf(marker)
  if (idx === -1) { fail(`分节存在: ${label}`, `找不到标记 ${marker}`); orderOk = false; continue }
  if (idx < lastIdx) { fail(`分节顺序: ${label}`, `${label} 出现在上一节之前`); orderOk = false }
  lastIdx = idx
}
check('分节顺序 = 表 → 函数 → 触发器 → 权限 → RLS → 种子', orderOk)

// 策略区在函数区之后（教训 4）；只取「8. RLS」到「9. 种子」之间，避免种子里的 insert 误报
const rlsIdx = sql.indexOf('-- 8. RLS')
const seedIdx = sql.indexOf('-- 9. 种子数据')
const rlsSection = sql.slice(rlsIdx, seedIdx === -1 ? undefined : seedIdx)
const policyFnRefs = [...rlsSection.matchAll(/public\.([a-z_]+)\s*\(/g)].map((m) => m[1])
const missingPolicyFns = [...new Set(policyFnRefs)].filter((n) => !fnByName.has(n))
check('RLS 策略引用的函数都已在策略之前定义', missingPolicyFns.length === 0, missingPolicyFns.join(', '))

// 每个被策略引用的非触发器函数，定义位置必须早于策略区
const orderProblems = [...new Set(policyFnRefs)]
  .filter((n) => fnByName.has(n) && fnByName.get(n).offset > rlsIdx)
  .map((n) => `${n} 定义在策略之后`)
check('策略引用的函数定义位置均早于 RLS 区', orderProblems.length === 0, orderProblems.join('; '))

/* ------------------------------------------------------------------ */
/* 2. 函数清单与签名                                                    */
/* ------------------------------------------------------------------ */

const EXPECTED = {
  // 基础 / 内部
  cfg_int: { params: [['p_key', 'text'], ['p_default', 'int']], grant: null },
  is_admin: { params: [], grant: ['anon', 'authenticated'] },
  is_super_admin: { params: [], grant: ['anon', 'authenticated'] },
  is_active_user: { params: [], grant: ['anon', 'authenticated'] },
  can_read_post: { params: [['p_post_id', 'uuid']], grant: ['anon', 'authenticated'] },
  username_available: { params: [['p_username', 'text']], grant: ['anon', 'authenticated'] },
  // 触发器函数
  touch_updated_at: { params: [], grant: null, trigger: 'returns trigger' },
  handle_new_user: { params: [], grant: null, trigger: 'returns trigger' },
  prepare_post_insert: { params: [], grant: null, trigger: 'returns trigger' },
  prepare_comment_insert: { params: [], grant: null, trigger: 'returns trigger' },
  sync_comment_count: { params: [], grant: null, trigger: 'returns trigger' },
  notify_on_comment: { params: [], grant: null, trigger: 'returns trigger' },
  notify_followers_on_post: { params: [], grant: null, trigger: 'returns trigger' },
  // 互动 RPC
  vote_post: {
    params: [['p_post_id', 'uuid'], ['p_value', 'smallint']],
    grant: ['authenticated'],
    returns: [['like_count', 'int'], ['dislike_count', 'int'], ['my_vote', 'smallint']],
  },
  toggle_comment_like: {
    params: [['p_comment_id', 'uuid']],
    grant: ['authenticated'],
    returns: [['like_count', 'int'], ['liked', 'boolean']],
  },
  toggle_favorite: {
    params: [['p_post_id', 'uuid']],
    grant: ['authenticated'],
    returns: [['favorited', 'boolean'], ['favorite_count', 'int']],
  },
  toggle_follow: {
    params: [['p_target_id', 'uuid']],
    grant: ['authenticated'],
    returns: [['following', 'boolean'], ['follower_count', 'int']],
  },
  soft_delete_post: { params: [['p_post_id', 'uuid']], grant: ['authenticated'], returnsMark: 'void' },
  soft_delete_comment: { params: [['p_comment_id', 'uuid']], grant: ['authenticated'], returnsMark: 'void' },
  mark_all_notifications_read: { params: [], grant: ['authenticated'], returnsMark: 'void' },
  mark_notification_read: { params: [['p_notification_id', 'uuid']], grant: ['authenticated'], returnsMark: 'void' },
  // 查询 RPC
  search_posts: {
    params: [
      ['p_query', 'text', null],
      ['p_board', 'text', 'null'],
      ['p_sort', 'text', "'new'"],
      ['p_limit', 'int', '20'],
      ['p_offset', 'int', '0'],
      ['p_since', 'timestamptz', 'null'],
      ['p_until', 'timestamptz', 'null'],
    ],
    grant: ['anon', 'authenticated'],
    returns: [
      ['id', 'uuid'], ['board_slug', 'text'], ['author_id', 'uuid'], ['title', 'text'],
      ['content', 'text'], ['images', 'text[]'], ['like_count', 'int'], ['dislike_count', 'int'],
      ['comment_count', 'int'], ['favorite_count', 'int'], ['is_pinned', 'boolean'],
      ['is_locked', 'boolean'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
      ['author_display_name', 'text'], ['author_avatar', 'text'],
    ],
  },
  posts_by_author: {
    params: [['p_user_id', 'uuid'], ['p_limit', 'int', '20'], ['p_offset', 'int', '0']],
    grant: ['anon', 'authenticated'],
    returnsMark: 'setof public.posts',
  },
  author_profile: {
    params: [['p_user_id', 'uuid']],
    grant: ['anon', 'authenticated'],
    returns: [
      ['user_id', 'uuid'], ['display_name', 'text'], ['avatar', 'text'], ['bio', 'text'],
      ['created_at', 'timestamptz'], ['post_count', 'bigint'], ['follower_count', 'bigint'],
      ['following_count', 'bigint'], ['is_following', 'boolean'], ['is_me', 'boolean'],
    ],
  },
  my_following: {
    params: [['p_limit', 'int', '20'], ['p_offset', 'int', '0']],
    grant: ['authenticated'],
    returns: [
      ['user_id', 'uuid'], ['display_name', 'text'], ['avatar', 'text'], ['bio', 'text'],
      ['followed_at', 'timestamptz'],
    ],
  },
  my_followers: {
    params: [['p_limit', 'int', '20'], ['p_offset', 'int', '0']],
    grant: ['authenticated'],
    returns: [
      ['user_id', 'uuid'], ['display_name', 'text'], ['avatar', 'text'], ['bio', 'text'],
      ['followed_at', 'timestamptz'],
    ],
  },
  my_profile: {
    params: [],
    grant: ['authenticated'],
    returns: [
      ['id', 'uuid'], ['display_name', 'text'], ['avatar', 'text'], ['bio', 'text'],
      ['role', 'user_role'], ['is_active', 'boolean'], ['banned_reason', 'text'],
      ['banned_until', 'timestamptz'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
      ['username', 'text'],
    ],
  },
  // 管理 RPC
  admin_set_role: {
    params: [['p_user_id', 'uuid'], ['p_role', 'user_role']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  admin_set_active: {
    params: [
      ['p_user_id', 'uuid'], ['p_active', 'boolean'],
      ['p_reason', 'text', 'null'], ['p_until', 'timestamptz', 'null'],
    ],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  admin_set_pinned: {
    params: [['p_post_id', 'uuid'], ['p_pinned', 'boolean']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  admin_lock_post: {
    params: [['p_post_id', 'uuid'], ['p_locked', 'boolean']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  admin_soft_delete_post: { params: [['p_post_id', 'uuid']], grant: ['authenticated'], returnsMark: 'void' },
  admin_soft_delete_comment: { params: [['p_comment_id', 'uuid']], grant: ['authenticated'], returnsMark: 'void' },
  admin_resolve_report: {
    params: [['p_report_id', 'uuid'], ['p_status', 'report_status'], ['p_note', 'text', 'null']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  recount_posts: { params: [], grant: ['authenticated'], returnsMark: 'int' },
  // 明细行删除时反向扣减计数（触发器调用）
  sync_vote_count_on_delete: { params: [], grant: null, trigger: 'returns trigger' },
  sync_comment_like_count_on_delete: { params: [], grant: null, trigger: 'returns trigger' },
  sync_favorite_count_on_delete: { params: [], grant: null, trigger: 'returns trigger' },
  // 违禁词（内部匹配 + 触发器 + 管理 RPC）
  invisible_chars: { params: [], grant: null, returnsMark: 'text' },
  find_banned_word: { params: [['p_text', 'text']], grant: null, returnsMark: 'text' },
  assert_no_banned_word: {
    params: [['p_text', 'text'], ['p_label', 'text']],
    grant: null,
    returnsMark: 'void',
  },
  check_banned_word: { params: [['p_text', 'text']], grant: ['anon', 'authenticated'], returnsMark: 'text' },
  check_post_words: { params: [], grant: null, trigger: 'returns trigger' },
  check_comment_words: { params: [], grant: null, trigger: 'returns trigger' },
  check_profile_words: { params: [], grant: null, trigger: 'returns trigger' },
  check_handle_words: { params: [], grant: null, trigger: 'returns trigger' },
  admin_banned_words: {
    params: [],
    grant: ['authenticated'],
    returns: [
      ['id', 'uuid'],
      ['word', 'text'],
      ['note', 'text'],
      ['created_at', 'timestamptz'],
    ],
  },
  admin_add_banned_word: {
    params: [['p_word', 'text'], ['p_note', 'text', 'null']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  admin_delete_banned_word: { params: [['p_id', 'uuid']], grant: ['authenticated'], returnsMark: 'void' },
  // 意见反馈（提交 / 我的 / 管理端）
  check_feedback_words: { params: [], grant: null, trigger: 'returns trigger' },
  submit_feedback: {
    params: [['p_content', 'text'], ['p_category', 'text', "'建议'"], ['p_contact', 'text', 'null']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  my_feedback: {
    params: [],
    grant: ['authenticated'],
    returns: [
      ['id', 'uuid'], ['category', 'text'], ['content', 'text'], ['contact', 'text'],
      ['status', 'text'], ['created_at', 'timestamptz'], ['handled_at', 'timestamptz'],
    ],
  },
  admin_feedback: {
    params: [['p_status', 'text', 'null']],
    grant: ['authenticated'],
    returns: [
      ['id', 'uuid'], ['user_id', 'uuid'], ['display_name', 'text'], ['category', 'text'],
      ['content', 'text'], ['contact', 'text'], ['status', 'text'],
      ['created_at', 'timestamptz'], ['handled_at', 'timestamptz'],
    ],
  },
  admin_resolve_feedback: {
    params: [['p_id', 'uuid'], ['p_status', 'text']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  // 举报目标校验（reports 触发器调用）
  validate_report_target: { params: [], grant: null, trigger: 'returns trigger' },

  // ---- 二期：好友 / 私信 ----
  pair_state: {
    params: [['p_a', 'uuid'], ['p_b', 'uuid']],
    grant: null,
    returnsMark: 'text',
  },
  check_friend_request_words: { params: [], grant: null, trigger: 'returns trigger' },
  check_dm_words: { params: [], grant: null, trigger: 'returns trigger' },
  search_users: {
    params: [['p_keyword', 'text'], ['p_limit', 'int', '20']],
    grant: ['authenticated'],
    returns: [
      ['user_id', 'uuid'], ['display_name', 'text'], ['avatar', 'text'], ['relation', 'text'],
    ],
  },
  send_friend_request: {
    params: [['p_to', 'uuid'], ['p_message', 'text', "''"]],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  respond_friend_request: {
    params: [['p_request_id', 'uuid'], ['p_accept', 'boolean']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  my_friend_requests: {
    params: [],
    grant: ['authenticated'],
    returns: [
      ['request_id', 'uuid'], ['direction', 'text'], ['peer_id', 'uuid'], ['peer_name', 'text'],
      ['peer_avatar', 'text'], ['message', 'text'], ['status', 'text'], ['created_at', 'timestamptz'],
    ],
  },
  my_friends: {
    params: [],
    grant: ['authenticated'],
    returns: [
      ['friend_id', 'uuid'], ['display_name', 'text'], ['avatar', 'text'], ['bio', 'text'],
      ['since', 'timestamptz'], ['relation', 'text'],
    ],
  },
  remove_friend: {
    params: [['p_friend_id', 'uuid']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  set_friend_block: {
    params: [['p_friend_id', 'uuid'], ['p_blocked', 'boolean']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  send_dm: {
    params: [['p_to', 'uuid'], ['p_content', 'text']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  my_conversations: {
    params: [],
    grant: ['authenticated'],
    returns: [
      ['conversation_id', 'uuid'], ['peer_id', 'uuid'], ['peer_name', 'text'], ['peer_avatar', 'text'],
      ['last_content', 'text'], ['last_at', 'timestamptz'], ['unread_count', 'int'],
    ],
  },
  dm_messages: {
    params: [['p_conversation_id', 'uuid'], ['p_after_seq', 'int', '0']],
    grant: ['authenticated'],
    returns: [
      ['seq', 'int'], ['sender_id', 'uuid'], ['content', 'text'], ['is_read', 'boolean'],
      ['created_at', 'timestamptz'],
    ],
  },
  mark_conversation_read: {
    params: [['p_conversation_id', 'uuid']],
    grant: ['authenticated'],
    returnsMark: 'void',
  },
  social_badges: {
    params: [],
    grant: ['authenticated'],
    returns: [['pending_requests', 'int'], ['unread_dms', 'int']],
  },
  user_relation: {
    params: [['p_user_id', 'uuid']],
    grant: ['authenticated'],
    returnsMark: 'text',
  },
}
// 规范化类型名（去 public. 前缀已在 normType 处理；user_role / report_status 保留）
for (const spec of Object.values(EXPECTED)) {
  if (spec.params) spec.params = spec.params.map((p) => [p[0], normType(p[1]), p[2] === undefined ? null : p[2]])
}

const actualNames = [...fnByName.keys()].sort()
const expectedNames = Object.keys(EXPECTED).sort()
check(
  `函数数量与清单一致（${expectedNames.length} 个）`,
  JSON.stringify(actualNames) === JSON.stringify(expectedNames),
  `多出: ${actualNames.filter((n) => !EXPECTED[n]).join(', ') || '无'}; 缺少: ${expectedNames.filter((n) => !fnByName.has(n)).join(', ') || '无'}`,
)

// 逐个函数检查参数名 / 类型 / 默认值 / 返回
const paramProblems = []
const returnProblems = []
for (const [name, spec] of Object.entries(EXPECTED)) {
  const fn = fnByName.get(name)
  if (!fn) continue
  // 参数
  if (spec.params) {
    const actual = fn.params.map((p) => [p.name, p.type, p.default === undefined ? null : p.default])
    const expected = spec.params
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      paramProblems.push(`${name}: 实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`)
    }
  }
  // 返回 table 列
  if (spec.returns) {
    const actual = fn.returnCols || []
    const expected = spec.returns.map(([n, t]) => ({ name: n, type: normType(t) }))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      returnProblems.push(`${name}: 实际 ${JSON.stringify(actual)} ≠ 期望 ${JSON.stringify(expected)}`)
    }
  }
  // 返回标记（void / setof posts / int）
  if (spec.returnsMark) {
    const mark = normWs(fn.returnSpec).toLowerCase()
    if (mark !== spec.returnsMark.toLowerCase()) {
      returnProblems.push(`${name}: returns ${mark} ≠ ${spec.returnsMark}`)
    }
  }
  if (spec.trigger) {
    if (normWs(fn.returnSpec).toLowerCase() !== 'trigger') {
      returnProblems.push(`${name}: 期望 returns trigger`)
    }
  }
}
check('RPC 参数名 / 类型 / 默认值与契约一致', paramProblems.length === 0, paramProblems.join('\n       ↳ '))
check('RPC 返回列名 / 顺序 / 类型与契约一致', returnProblems.length === 0, returnProblems.join('\n       ↳ '))

/* ------------------------------------------------------------------ */
/* 3. security definer 必须 set search_path                            */
/* ------------------------------------------------------------------ */
const definerProblems = fns
  .filter((f) => /security\s+definer/i.test(f.header))
  .filter((f) => !/set\s+search_path\s*=\s*public/i.test(f.header))
  .map((f) => f.name)
check('所有 security definer 函数都设置了 set search_path = public', definerProblems.length === 0, definerProblems.join(', '))

/* ------------------------------------------------------------------ */
/* 4. grant execute 与函数签名对齐                                     */
/* ------------------------------------------------------------------ */
const grantProblems = []
for (const g of grants) {
  const fn = fnByName.get(g.name)
  if (!fn) { grantProblems.push(`grant 指向不存在的函数 ${g.name}`); continue }
  const actualTypes = fn.params.map((p) => p.type)
  if (JSON.stringify(actualTypes) !== JSON.stringify(g.types)) {
    grantProblems.push(`${g.name}: grant 参数 (${g.types.join(',')}) ≠ 定义 (${actualTypes.join(',')})`)
  }
}
check('每条 grant execute 都能对上真实函数签名', grantProblems.length === 0, grantProblems.join('\n       ↳ '))

// 期望的授权矩阵
const grantMatrixProblems = []
for (const [name, spec] of Object.entries(EXPECTED)) {
  const actual = grants.find((g) => g.name === name)
  if (spec.grant === null) {
    if (actual) grantMatrixProblems.push(`${name} 不应被 grant execute（内部/触发器函数）`)
  } else {
    if (!actual) grantMatrixProblems.push(`${name} 缺少 grant execute`)
    else if (JSON.stringify(actual.roles) !== JSON.stringify([...spec.grant].sort())) {
      grantMatrixProblems.push(`${name} 授权角色 ${JSON.stringify(actual.roles)} ≠ ${JSON.stringify(spec.grant)}`)
    }
  }
}
check('授权矩阵正确（anon 只给 8 个公开函数，内部/触发器函数不授权）', grantMatrixProblems.length === 0, grantMatrixProblems.join('\n       ↳ '))

/* ------------------------------------------------------------------ */
/* 5. 触发器 / 策略 都有 drop if exists 前置                           */
/* ------------------------------------------------------------------ */
const triggerNames = [...sql.matchAll(/create\s+trigger\s+(\w+)/gi)].map((m) => m[1].toLowerCase())
const triggerProblems = triggerNames.filter((name) => {
  const createIdx = sql.toLowerCase().indexOf(`create trigger ${name}`)
  const before = sql.slice(0, createIdx).toLowerCase()
  return !before.includes(`drop trigger if exists ${name}`)
})
check(`触发器都有 drop trigger if exists 前置（共 ${triggerNames.length} 个）`, triggerProblems.length === 0, triggerProblems.join(', '))

const policyNames = [...sql.matchAll(/create\s+policy\s+(\w+)/gi)].map((m) => m[1].toLowerCase())
const policyProblems = policyNames.filter((name) => {
  const createIdx = sql.toLowerCase().indexOf(`create policy ${name}`)
  const before = sql.slice(0, createIdx).toLowerCase()
  return !before.includes(`drop policy if exists ${name}`)
})
check(`RLS 策略都有 drop policy if exists 前置（共 ${policyNames.length} 个）`, policyProblems.length === 0, policyProblems.join(', '))

/* ------------------------------------------------------------------ */
/* 5.5 基础文本结构：$ 引用配对 / 函数体外括号平衡 / 函数体以 $$; 收尾  */
/* ------------------------------------------------------------------ */
const dollarPositions = []
{
  let idx = sql.indexOf('$$')
  while (idx !== -1) {
    dollarPositions.push(idx)
    idx = sql.indexOf('$$', idx + 2)
  }
}
check('函数体 dollar 引用成对（$$ 数量为偶数）', dollarPositions.length % 2 === 0, `$$ 出现 ${dollarPositions.length} 次`)

const closings = dollarPositions.filter((_, i) => i % 2 === 1)
const badClosings = closings.filter((pos) => !/^\s*;/.test(sql.slice(pos + 2, pos + 12)))
check('每个函数体 / DO 块都以 $$; 收尾', badClosings.length === 0, badClosings.map((p) => `@${p}`).join(', '))

// 去掉行注释与 dollar 区域后，括号应完全平衡（能发现 SQL 层的括号笔误）
let outside = ''
{
  let i = 0
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl + 1
      continue
    }
    if (sql.startsWith('$$', i)) {
      const end = sql.indexOf('$$', i + 2)
      if (end === -1) { outside += '__UNCLOSED__'; break }
      i = end + 2
      outside += ' '
      continue
    }
    outside += sql[i]
    i++
  }
}
let parenDepth = 0
for (const ch of outside) {
  if (ch === '(') parenDepth++
  else if (ch === ')') parenDepth--
}
check('函数体之外的 SQL 括号全部平衡', parenDepth === 0, `括号差 ${parenDepth}`)

/* ------------------------------------------------------------------ */
/* 6. 禁用项                                                           */
/* ------------------------------------------------------------------ */
// 6.1 profiles 禁列
const profilesBlock = (() => {
  const start = sql.indexOf('create table if not exists public.profiles')
  const end = sql.indexOf('create index if not exists profiles_role_idx')
  return sql.slice(start, end === -1 ? start + 2000 : end)
})()
const forbiddenProfileCols = ['password', 'username', 'email', 'anonymous_name']
const foundForbidden = forbiddenProfileCols.filter((c) => new RegExp(`^\\s*${c}\\s`, 'mi').test(profilesBlock))
check('profiles 不含 password / username / email / anonymous_name 列', foundForbidden.length === 0, foundForbidden.join(', '))

// 6.2 明细表禁止直写
const writeGrantLines = [...sql.matchAll(/grant\s+(insert|update|delete)[^;]*;/gi)].map((m) => normWs(m[0]))
const forbiddenWrites = writeGrantLines.filter((line) =>
  /\bon public\.(user_handles|post_votes|comment_likes|banned_words|feedback|favorites|follows)\b/i.test(line),
)
check('user_handles / post_votes / comment_likes / banned_words / feedback / favorites / follows 没有直接写权限', forbiddenWrites.length === 0, forbiddenWrites.join(' | '))

// 6.3 计数列 / 管理列不可写
const postsInsertGrant = writeGrantLines.find((l) => /grant insert \(board_slug, title, content, images\) on public\.posts/i.test(l))
const postsUpdateGrant = writeGrantLines.find((l) => /grant update \(title, content, images\) on public\.posts/i.test(l))
check('posts 只授权可写列（insert: board_slug/title/content/images；update: title/content/images）',
  Boolean(postsInsertGrant && postsUpdateGrant),
  `insert=${postsInsertGrant ?? '缺失'} update=${postsUpdateGrant ?? '缺失'}`)

const profilesSelectCols = (() => {
  const m = sql.match(/grant\s+select\s*\(([^)]+)\)\s*\n\s*on public\.profiles to anon, authenticated;/i)
  return m ? m[1].split(',').map((s) => s.trim()) : null
})()
check('profiles 列级 select 只放行公开 5 列',
  JSON.stringify(profilesSelectCols) === JSON.stringify(['id', 'display_name', 'avatar', 'bio', 'created_at']),
  JSON.stringify(profilesSelectCols))

// 6.4 reports 只授 INSERT 的指定列（reporter_id 用默认值，不授列权限）
const reportsGrant = writeGrantLines.find((l) => /on public\.reports\b/i.test(l))
check('reports 只授权 insert(target_type,target_id,reason,detail)',
  Boolean(reportsGrant && /grant insert \(target_type, target_id, reason, detail\) on public\.reports to authenticated;/i.test(reportsGrant)),
  reportsGrant ?? '缺失')
check('reports.reporter_id 使用列默认 auth.uid()', /reporter_id\s+uuid\s+not\s+null\s+default\s+auth\.uid\(\)/i.test(sql))

// 6.5 不能出现自定义 _fkey 约束名（前端嵌入查询依赖默认名）
check('未自定义外键约束名（保留 posts_author_id_fkey 等默认名）', !/constraint\s+\w+_fkey/i.test(sql))

// 6.6 先 revoke 后 grant
const revokeIdx = sql.indexOf('revoke all on all tables in schema public from anon, authenticated;')
const firstGrantIdx = sql.indexOf('grant select on public.boards')
check('权限顺序：先 revoke all，再按列 grant', revokeIdx !== -1 && firstGrantIdx !== -1 && revokeIdx < firstGrantIdx)

/* ------------------------------------------------------------------ */
/* 7. 枚举、种子、视图、RLS 开启                                       */
/* ------------------------------------------------------------------ */
const enumChecks = [
  ['user_role', ['user', 'moderator', 'admin']],
  ['report_status', ['pending', 'resolved', 'rejected']],
  ['report_target', ['post', 'comment', 'user']],
  ['notification_type', ['comment', 'reply', 'like', 'system', 'follow_post']],
]
const enumProblems = []
for (const [type, labels] of enumChecks) {
  const m = sql.match(new RegExp(`create type public\\.${type} as enum\\s*\\(([^)]*)\\)`, 'i'))
  if (!m) { enumProblems.push(`${type} 缺失`); continue }
  const actual = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  if (JSON.stringify(actual) !== JSON.stringify(labels)) enumProblems.push(`${type}: ${JSON.stringify(actual)}`)
}
check('4 个枚举类型与取值正确（notification_type 含 follow_post）', enumProblems.length === 0, enumProblems.join('; '))

const seedProblems = []
const configSeeds = [
  ['post_cooldown_minutes', '0'],
  ['post_daily_limit', '50'],
  ['comment_cooldown_minutes', '0'],
  ['comment_daily_limit', '200'],
  ['max_images_per_post', '0'],
]
for (const [key, value] of configSeeds) {
  const re = new RegExp(`\\('${key}',\\s*'${value}'::jsonb`, 'i')
  if (!re.test(sql)) seedProblems.push(`${key} 种子值应为 ${value}`)
}
for (const slug of ['chat', 'study', 'love', 'lost', 'friend']) {
  if (!new RegExp(`\\('${slug}',`).test(sql)) seedProblems.push(`板块 ${slug} 缺失`)
}
check('种子数据符合简化口径（5 板块 + 5 配置，冷却 0 / 日限额 50、200 / 图片 0）', seedProblems.length === 0, seedProblems.join('; '))

const rlsTables = ['profiles', 'user_handles', 'boards', 'posts', 'comments', 'post_votes', 'comment_likes', 'banned_words', 'feedback', 'favorites', 'follows', 'notifications', 'reports', 'app_config', 'friendships', 'friend_requests', 'conversations', 'direct_messages']
const rlsProblems = rlsTables.filter((t) => !new RegExp(`alter table public\\.${t}\\s+enable row level security;`, 'i').test(sql))
check(`${rlsTables.length} 张表全部 enable row level security`, rlsProblems.length === 0, rlsProblems.join(', '))

const adminViewCols = ['id', 'display_name', 'avatar', 'bio', 'role', 'is_active', 'banned_reason', 'banned_until', 'created_at', 'updated_at', 'username', 'post_count', 'comment_count', 'follower_count']
const viewBlock = (() => {
  const start = sql.indexOf('create or replace view public.admin_profiles')
  const end = sql.indexOf('-- ====', start + 10)
  return sql.slice(start, end === -1 ? start + 4000 : end)
})()
const viewColProblems = adminViewCols.filter((c) => !new RegExp(`\\b${c}\\b`).test(viewBlock))
check('admin_profiles 视图包含管理后台所需全部列', viewColProblems.length === 0, viewColProblems.join(', '))
check('admin_profiles 视图用 where public.is_super_admin() 做行级过滤（仅 admin）', /where\s+public\.is_super_admin\(\)/i.test(viewBlock))
check('admin_profiles 只授权给 authenticated（非管理员查为空集）',
  /grant select on public\.admin_profiles to authenticated;/i.test(sql) &&
  !/grant select on public\.admin_profiles to anon/i.test(sql))

/* ------------------------------------------------------------------ */
/* 8. 契约文档对照（若已存在）                                          */
/* ------------------------------------------------------------------ */
if (fs.existsSync(CONTRACT_FILE)) {
  const contract = fs.readFileSync(CONTRACT_FILE, 'utf8')
  const userFacing = Object.entries(EXPECTED).filter(([, s]) => s.grant).map(([n]) => n)
  const missingInContract = userFacing.filter((n) => !new RegExp(`\\b${n}\\b`).test(contract))
  check('契约文档覆盖所有对前端暴露的 RPC', missingInContract.length === 0, missingInContract.join(', '))

  // 契约里以 public.xxx( 形式引用的函数必须真实存在
  const contractFnRefs = [...new Set([...contract.matchAll(/public\.([a-z_]{3,40})\s*\(/g)].map((m) => m[1]))]
  const badContractRefs = contractFnRefs.filter((n) => !fnByName.has(n))
  check('契约文档里以 public.xxx( 引用的函数都真实存在', badContractRefs.length === 0, badContractRefs.join(', '))

  // 每个 RPC 的返回列必须出现在它自己的小节里
  const sections = contract.split(/\n(?=### )/g)
  const sectionProblems = []
  for (const [name, spec] of Object.entries(EXPECTED)) {
    if (!spec.returns) continue
    const section = sections.find((s) => new RegExp(`^###\\s+.*\\b${name}\\b`, 'm').test(s))
    if (!section) { sectionProblems.push(`契约缺少「### ${name}」小节`); continue }
    const cols = spec.returns.map(([n]) => n).filter((n) => !new RegExp(`\\b${n}\\b`).test(section))
    if (cols.length) sectionProblems.push(`${name} 小节缺列: ${cols.join(', ')}`)
  }
  check('契约文档每个 RPC 小节都列全返回列名', sectionProblems.length === 0, sectionProblems.join('; '))

  check('契约文档写死了外键默认名（posts_author_id_fkey 等）',
    /posts_author_id_fkey/.test(contract) && /comments_author_id_fkey/.test(contract) &&
    /notifications_actor_id_fkey/.test(contract) && /favorites_post_id_fkey/.test(contract))
  check('契约文档说明了 admin_profiles 视图的用法', /admin_profiles/.test(contract))
} else {
  console.log(`SKIP  契约文档检查（尚未创建：${CONTRACT_FILE}）`)
}

/* ------------------------------------------------------------------ */
/* 汇总                                                               */
/* ------------------------------------------------------------------ */
console.log('\n──────────────────────────────────────────────')
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(` - ${f.name}${f.detail ? `: ${f.detail}` : ''}`)
  process.exitCode = 1
} else {
  console.log('init.sql 文本级自检全部通过')
}
