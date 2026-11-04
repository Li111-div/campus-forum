/**
 * 数据导出 / 备份 验收脚本
 *
 * 覆盖：
 *   1. 能完整导出一个快照目录（JSON + CSV + manifest）
 *   2. manifest 里每张表的行数与线上库一致
 *   3. `--verify` 对完好备份返回 0
 *   4. 篡改任意一个文件后 `--verify` 必须失败（证明校验和真的在起作用）
 *   5. auth.users 默认不含密码哈希
 *
 * 用法：node scripts/e2e-backup.mjs
 * 环境变量：DB_PASSWORD / SUPABASE_REF / DB_HOST
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from 'pg'

const ROOT = process.cwd()
const WORK = resolve(ROOT, '.tmp/backup-acceptance')
const OUT = resolve(WORK, 'snapshot')

const results = []
function ok(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✓' : '✗'} ${name}${detail && !pass ? ` —— ${detail}` : ''}`)
}

function runExport(args) {
  const result = spawnSync(process.execPath, [resolve(ROOT, 'scripts/export-data.mjs'), ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  })
  return result.status ?? 1
}

async function withDb(fn) {
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
    return await fn(client)
  } finally {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  /* ---------- 1. 导出 ---------- */
  console.log('\n--- 导出快照 ---')
  const exportCode = runExport(['--format', 'both', '--out', OUT])
  ok('导出命令执行成功', exportCode === 0, `exit=${exportCode}`)
  ok('生成了 manifest.json', existsSync(resolve(OUT, 'manifest.json')))
  ok('生成了 posts 的 JSON 与 CSV', existsSync(resolve(OUT, 'public.posts.json')) && existsSync(resolve(OUT, 'public.posts.csv')))
  ok('生成了 auth.users 快照', existsSync(resolve(OUT, 'auth.users.json')))

  if (!existsSync(resolve(OUT, 'manifest.json'))) return finish()

  const manifest = JSON.parse(readFileSync(resolve(OUT, 'manifest.json'), 'utf8'))
  ok('manifest 记录了应用版本', Boolean(manifest.app?.version), JSON.stringify(manifest.app))
  ok('默认不导出密码哈希', manifest.withPasswordHashes === false)
  const authColumns = manifest.authUsers?.columns ?? []
  ok('auth.users 不含 encrypted_password', !authColumns.includes('encrypted_password'), JSON.stringify(authColumns))

  /* ---------- 2. 行数与线上库一致 ---------- */
  console.log('\n--- 行数比对 ---')
  const liveCounts = await withDb(async (client) => {
    const counts = {}
    for (const item of manifest.tables ?? []) {
      const { rows } = await client.query(`select count(*)::int n from public."${item.table}"`)
      counts[item.table] = rows[0].n
    }
    const auth = await client.query('select count(*)::int n from auth.users')
    counts['auth.users'] = auth.rows[0].n
    return counts
  })

  let mismatch = 0
  for (const item of manifest.tables ?? []) {
    if (liveCounts[item.table] !== item.rows) {
      mismatch += 1
      console.log(`  ! ${item.table}: manifest ${item.rows} / 库 ${liveCounts[item.table]}`)
    }
  }
  ok('18 张业务表行数与线上库一致', mismatch === 0, `${mismatch} 张不一致`)
  ok('auth.users 行数与线上库一致', liveCounts['auth.users'] === manifest.authUsers?.rows, `${manifest.authUsers?.rows} vs ${liveCounts['auth.users']}`)

  /* ---------- 3. 完成后校验应通过 ---------- */
  console.log('\n--- 校验完好备份 ---')
  const verifyOk = runExport(['--verify', OUT])
  ok('完好备份校验通过（exit 0）', verifyOk === 0, `exit=${verifyOk}`)

  /* ---------- 4. 篡改检测 ---------- */
  console.log('\n--- 篡改检测 ---')
  const target = resolve(OUT, manifest.tables?.[0]?.file ?? 'public.posts.json')
  appendFileSync(target, '\n[]\n', 'utf8')
  const verifyTampered = runExport(['--verify', OUT])
  ok('篡改文件后校验失败（exit ≠ 0）', verifyTampered !== 0, `exit=${verifyTampered}`)

  finish()
}

function finish() {
  const failed = results.filter((item) => !item.pass)
  console.log(`\n===== 备份功能验收 =====\n通过 ${results.length - failed.length} / ${results.length}`)
  if (failed.length) {
    for (const item of failed) console.log(`  ✗ ${item.name} ${item.detail}`)
    process.exitCode = 1
  }
  rmSync(WORK, { recursive: true, force: true })
}

await main()
