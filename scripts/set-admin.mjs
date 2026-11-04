/**
 * 按邮箱把账号设为管理员（一次性运维脚本）。
 * 用法：ADMIN_EMAIL=xxx DB_PASSWORD=xxx SUPABASE_REF=xxx DB_HOST=xxx node scripts/set-admin.mjs
 */
import { Client } from 'pg'

const EMAIL = process.env.ADMIN_EMAIL
const PASSWORD = process.env.DB_PASSWORD
const REF = process.env.SUPABASE_REF
const HOST = process.env.DB_HOST ?? 'aws-0-ap-northeast-1.pooler.supabase.com'

if (!EMAIL || !PASSWORD || !REF) {
  console.error('需要 ADMIN_EMAIL / DB_PASSWORD / SUPABASE_REF 环境变量')
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
  const r = await client.query(
    `update public.profiles p
        set role = 'admin'
       from auth.users u
      where u.id = p.id and lower(u.email) = lower($1)
      returning p.id, p.display_name, p.role`,
    [EMAIL],
  )
  if (r.rowCount === 0) {
    console.log(`没有找到邮箱为 ${EMAIL} 的用户（请先在网站上注册）`)
    process.exitCode = 1
  } else {
    console.log(`已设为管理员: ${r.rows[0].display_name} (${EMAIL}) role=${r.rows[0].role}`)
  }
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
