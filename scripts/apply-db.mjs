/**
 * 用数据库密码直连 Supabase Postgres，执行 supabase/init.sql 并做结构自检。
 *
 * 用法（密码只从环境变量读，不落盘）：
 *   DB_PASSWORD=xxx SUPABASE_REF=xxx node scripts/apply-db.mjs
 * 可选：DB_HOST 覆盖 pooler 主机（默认 aws-0-ap-northeast-1.pooler.supabase.com）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'

const REF = process.env.SUPABASE_REF
const PASSWORD = process.env.DB_PASSWORD
const HOST = process.env.DB_HOST ?? 'aws-0-ap-northeast-1.pooler.supabase.com'

if (!REF || !PASSWORD) {
  console.error('需要 SUPABASE_REF 与 DB_PASSWORD 环境变量')
  process.exit(1)
}

const sqlPath = resolve(process.cwd(), 'supabase/init.sql')
const sql = readFileSync(sqlPath, 'utf8')
console.log(`读取 ${sqlPath}: ${sql.split('\n').length} 行 / ${(sql.length / 1024).toFixed(1)} KB`)

const client = new Client({
  host: HOST,
  port: 5432,
  user: `postgres.${REF}`,
  password: PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  statement_timeout: 120000,
})

function lineOf(text, position) {
  if (!position) return null
  return text.slice(0, position - 1).split('\n').length
}

try {
  await client.connect()
  console.log(`已连接 ${HOST}（项目 ${REF}）`)

  const before = await client.query(
    `select count(*)::int as n from pg_tables where schemaname = 'public'`,
  )
  console.log(`执行前 public 表数量: ${before.rows[0].n}`)

  const started = Date.now()
  await client.query(sql)
  console.log(`init.sql 执行完成，用时 ${((Date.now() - started) / 1000).toFixed(2)}s`)

  /* ---------------- 结构自检 ---------------- */
  const tables = await client.query(`
    select tablename, rowsecurity from pg_tables where schemaname = 'public' order by tablename
  `)
  const expected = [
    'app_config',
    'boards',
    'comments',
    'favorites',
    'follows',
    'notifications',
    'post_votes',
    'posts',
    'profiles',
    'reports',
    'user_handles',
  ]
  const have = tables.rows.map((r) => r.tablename)
  const missing = expected.filter((t) => !have.includes(t))
  const rlsOff = tables.rows.filter((r) => !r.rowsecurity).map((r) => r.tablename)

  const boards = await client.query('select count(*)::int as n from public.boards')
  const config = await client.query('select count(*)::int as n from public.app_config')
  const funcs = await client.query(`
    select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
  `)
  const policies = await client.query(`
    select count(*)::int as n from pg_policies where schemaname = 'public'
  `)
  const view = await client.query(`
    select count(*)::int as n from information_schema.views
    where table_schema = 'public' and table_name = 'admin_profiles'
  `)
  const enumLabels = await client.query(`
    select enumlabel from pg_enum where enumtypid = 'public.notification_type'::regtype order by enumsortorder
  `)
  const fks = await client.query(`
    select conname from pg_constraint
    where conrelid = 'public.posts'::regclass and contype = 'f'
  `)

  const checks = [
    ['11 张表齐全', missing.length === 0, missing.length ? `缺: ${missing.join(', ')}` : ''],
    ['全部表开启 RLS', rlsOff.length === 0, rlsOff.length ? `未开启: ${rlsOff.join(', ')}` : ''],
    ['板块种子 5 条', boards.rows[0].n === 5, `实际 ${boards.rows[0].n}`],
    ['app_config 种子 5 条', config.rows[0].n === 5, `实际 ${config.rows[0].n}`],
    ['函数已创建', funcs.rows[0].n >= 30, `实际 ${funcs.rows[0].n}`],
    ['RLS 策略已创建', policies.rows[0].n >= 19, `实际 ${policies.rows[0].n}`],
    ['admin_profiles 视图存在', view.rows[0].n === 1, `实际 ${view.rows[0].n}`],
    [
      'notification_type 含 follow_post',
      enumLabels.rows.some((r) => r.enumlabel === 'follow_post'),
      enumLabels.rows.map((r) => r.enumlabel).join(','),
    ],
    [
      'posts 外键默认名存在',
      ['posts_author_id_fkey', 'posts_board_slug_fkey'].every((n) => fks.rows.some((r) => r.conname === n)),
      fks.rows.map((r) => r.conname).join(','),
    ],
  ]

  console.log('\n===== 结构自检 =====')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail && !ok ? ` —— ${detail}` : ''}`)
    if (!ok) failed += 1
  }
  console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`)
  if (failed > 0) process.exitCode = 1
} catch (err) {
  const line = lineOf(sql, err.position)
  console.error(`\n执行失败: [${err.code ?? ''}] ${err.message}`)
  if (line) {
    const lines = sql.split('\n')
    console.error(`大致在第 ${line} 行：`)
    for (let i = Math.max(0, line - 3); i < Math.min(lines.length, line + 2); i += 1) {
      console.error(`  ${i + 1}: ${lines[i]}`)
    }
  }
  process.exitCode = 1
} finally {
  try {
    await client.end()
  } catch {
    /* ignore */
  }
}
