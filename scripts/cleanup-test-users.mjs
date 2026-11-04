/**
 * 清理验收脚本创建的两个临时账号（campus.forum.verify.* 开头的邮箱）。
 * 用法：DB_PASSWORD=xxx SUPABASE_REF=xxx DB_HOST=xxx node scripts/cleanup-test-users.mjs
 */
import { Client } from 'pg'

const PASSWORD = process.env.DB_PASSWORD
const REF = process.env.SUPABASE_REF
const HOST = process.env.DB_HOST ?? 'aws-0-ap-northeast-1.pooler.supabase.com'
if (!PASSWORD || !REF) {
  console.error('需要 DB_PASSWORD 与 SUPABASE_REF 环境变量')
  process.exit(1)
}

const client = new Client({
  host: HOST,
  port: 5432,
  user: `postgres.${REF}`,
  password: PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
})

try {
  await client.connect()
  const all = await client.query('select id, email, created_at from auth.users order by created_at')
  console.log(`当前账号数: ${all.rowCount}`)
  for (const u of all.rows) console.log(`  ${u.email}  ${u.created_at.toISOString()}`)

  const del = await client.query(
    `delete from auth.users where email ilike 'campus.forum.verify.%' or email ilike 'campus.forum.e2e.%' or email ilike 'campus.forum.probe.%' or email ilike 'verify.%@%'
     returning email`,
  )
  console.log(`\n已删除测试账号 ${del.rowCount} 个${del.rowCount ? `: ${del.rows.map((r) => r.email).join(', ')}` : ''}`)
} catch (err) {
  console.error('失败:', err.message)
  process.exitCode = 1
} finally {
  try {
    await client.end()
  } catch {
    /* ignore */
  }
}
