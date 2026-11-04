/**
 * 一次性探测：找到能连上本项目的 Postgres 入口（pooler 各区域 / 直连）。
 * 用法：DB_PASSWORD=xxx SUPABASE_REF=xxx node scripts/probe-db.mjs
 * 不打印密码，只打印失败原因。
 */
import { Client } from 'pg'

const PASSWORD = process.env.DB_PASSWORD
const REF = process.env.SUPABASE_REF
if (!PASSWORD || !REF) {
  console.error('需要 DB_PASSWORD 与 SUPABASE_REF 环境变量')
  process.exit(1)
}

const base = {
  password: PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 6000,
  statement_timeout: 8000,
}

const regions = [
  'ap-southeast-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'ap-southeast-2',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'ca-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'sa-east-1',
]

const candidates = [
  { name: 'direct', host: `db.${REF}.supabase.co`, port: 5432, user: 'postgres' },
  ...regions.flatMap((r) => [
    { name: `aws-0-${r}`, host: `aws-0-${r}.pooler.supabase.com`, port: 5432, user: `postgres.${REF}` },
    { name: `aws-1-${r}`, host: `aws-1-${r}.pooler.supabase.com`, port: 5432, user: `postgres.${REF}` },
  ]),
]

function shortError(err) {
  const msg = err?.message ?? String(err)
  const code = err?.code ? `[${err.code}] ` : ''
  return `${code}${msg}`.slice(0, 120)
}

let found = 0
for (const candidate of candidates) {
  const client = new Client({ ...base, ...candidate })
  try {
    await client.connect()
    const r = await client.query('select current_database() as db, current_user as usr, version() as v')
    console.log(`\n✅ 成功: ${candidate.name}`)
    console.log(`   host=${candidate.host} port=${candidate.port} user=${candidate.user}`)
    console.log(`   ${r.rows[0].v.split(',')[0]} / db=${r.rows[0].db} / user=${r.rows[0].usr}`)
    found += 1
    await client.end()
    break
  } catch (err) {
    console.log(`   ✗ ${candidate.name}: ${shortError(err)}`)
  } finally {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }
}

if (!found) {
  console.log('\n没有连上。如果所有 pooler 都是 ENOTFOUND，说明区域不在列表里；如果是 28P01，说明密码不对。')
  process.exitCode = 1
}
