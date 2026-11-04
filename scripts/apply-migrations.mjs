/**
 * 应用增量 SQL：supabase/migrations/*.sql（按文件名顺序）。
 * 用法：DB_PASSWORD=xxx SUPABASE_REF=xxx DB_HOST=xxx node scripts/apply-migrations.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'

const PASSWORD = process.env.DB_PASSWORD
const REF = process.env.SUPABASE_REF
const HOST = process.env.DB_HOST ?? 'aws-0-ap-northeast-1.pooler.supabase.com'
if (!PASSWORD || !REF) {
  console.error('需要 DB_PASSWORD 与 SUPABASE_REF 环境变量')
  process.exit(1)
}

const dir = resolve(process.cwd(), 'supabase/migrations')
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort()

if (files.length === 0) {
  console.log('没有找到迁移文件')
  process.exit(0)
}

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

try {
  await client.connect()
  for (const file of files) {
    const sql = readFileSync(resolve(dir, file), 'utf8')
    const started = Date.now()
    await client.query(sql)
    console.log(`✓ ${file}（${((Date.now() - started) / 1000).toFixed(2)}s，${sql.split('\n').length} 行）`)
  }
  console.log('全部迁移执行完成')
} catch (err) {
  console.error(`迁移失败: [${err.code ?? ''}] ${err.message}`)
  process.exitCode = 1
} finally {
  try {
    await client.end()
  } catch {
    /* ignore */
  }
}
