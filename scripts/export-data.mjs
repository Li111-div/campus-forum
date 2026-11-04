/**
 * 数据导出与备份（二期第 3 步）
 *
 * 作用：把 public schema 下所有业务表 + auth.users 的基础信息导成一个「快照目录」，
 *       并生成带行数与 SHA-256 的 manifest.json；支持事后 `--verify` 校验备份是否完整。
 *
 * 用法：
 *   node scripts/export-data.mjs                     # 导出 JSON（默认 ./backups/<时间戳>）
 *   node scripts/export-data.mjs --format csv        # 顺带导出 CSV（Excel 可开）
 *   node scripts/export-data.mjs --format both
 *   node scripts/export-data.mjs --out D:\bak\2026   # 指定输出目录
 *   node scripts/export-data.mjs --with-password-hashes   # 连密码哈希一起导（敏感！）
 *   node scripts/export-data.mjs --verify backups/xxx     # 校验一个已有备份
 *
 * 环境变量（与其它 db 脚本一致）：
 *   DB_PASSWORD  SUPABASE_REF  DB_HOST（默认 aws-0-ap-northeast-1.pooler.supabase.com）
 *
 * 注意：
 *   - 这是「逻辑备份」，不是 pg_dump 的物理备份；适合小体量论坛做快照与迁移。
 *   - 默认**不导出密码哈希**：没有哈希就无法还原登录凭据，需要完整还原时加 --with-password-hashes，
 *     并且务必把备份文件当成机密保存（里面有邮箱和哈希）。
 *   - 恢复是手工操作（或在新库跑 init.sql 后按 manifest 顺序导入），本脚本不提供自动 restore。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Client } from 'pg'

const PASSWORD = process.env.DB_PASSWORD
const REF = process.env.SUPABASE_REF
const HOST = process.env.DB_HOST ?? 'aws-0-ap-northeast-1.pooler.supabase.com'
const CHUNK = 2000

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(`--${name}`)
const flagValue = (name, fallback = null) => {
  const idx = args.indexOf(`--${name}`)
  if (idx < 0) return fallback
  const value = args[idx + 1]
  return value && !value.startsWith('--') ? value : fallback
}

const FORMAT = flagValue('format', 'json')
const OUT_ARG = flagValue('out')
const VERIFY_DIR = flagValue('verify')
const WITH_HASHES = hasFlag('with-password-hashes')

function die(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/** 把一行里的特殊值转成可 CSV 的字符串（数组/对象压成 JSON）。 */
function cell(value) {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function toCsv(rows, columns) {
  const escape = (text) => {
    const value = String(text ?? '')
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  }
  const lines = [columns.map(escape).join(',')]
  for (const row of rows) lines.push(columns.map((col) => escape(cell(row[col]))).join(','))
  return `${lines.join('\r\n')}\r\n`
}

/** 分块读取整表，避免一次性把大表拉进内存。 */
async function readTable(client, table) {
  const rows = []
  let offset = 0
  for (;;) {
    const { rows: chunk } = await client.query(
      `select * from public.${quoteIdent(table)} order by 1 limit $1 offset $2`,
      [CHUNK, offset],
    )
    rows.push(...chunk)
    if (chunk.length < CHUNK) break
    offset += CHUNK
  }
  return rows
}

async function connect() {
  if (!PASSWORD || !REF) die('缺少 DB_PASSWORD / SUPABASE_REF 环境变量')
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
  await client.connect()
  return client
}

/* ------------------------------------------------------------------ */
/* 校验模式                                                            */
/* ------------------------------------------------------------------ */

function verifyBackup(dir) {
  const absolute = resolve(dir)
  if (!existsSync(absolute)) die(`备份目录不存在：${absolute}`)

  const manifestPath = resolve(absolute, 'manifest.json')
  if (!existsSync(manifestPath)) die(`不是有效备份（缺少 manifest.json）：${absolute}`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const problems = []
  let checkedFiles = 0
  let checkedRows = 0

  const entries = [...(manifest.tables ?? [])]
  if (manifest.authUsers) entries.push(manifest.authUsers)

  for (const entry of entries) {
    const filePath = resolve(absolute, entry.file)
    if (!existsSync(filePath)) {
      problems.push(`缺少文件 ${entry.file}`)
      continue
    }
    const raw = readFileSync(filePath, 'utf8')
    const fileHash = sha256(raw)
    if (entry.sha256 && fileHash !== entry.sha256) {
      problems.push(`${entry.file} 校验和不一致（期望 ${entry.sha256.slice(0, 12)}… 实际 ${fileHash.slice(0, 12)}…）`)
    }
    if (entry.format === 'json' || entry.file.endsWith('.json')) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && typeof entry.rows === 'number' && parsed.length !== entry.rows) {
          problems.push(`${entry.file} 行数不一致（manifest ${entry.rows}，文件 ${parsed.length}）`)
        }
        checkedRows += Array.isArray(parsed) ? parsed.length : 0
      } catch {
        problems.push(`${entry.file} 不是合法 JSON`)
      }
    }
    checkedFiles += 1
  }

  console.log('===== 备份校验 =====')
  console.log(`目录      : ${absolute}`)
  console.log(`生成时间  : ${manifest.generatedAt}`)
  console.log(`文件数    : ${checkedFiles} / ${entries.length}`)
  console.log(`总行数    : ${checkedRows}`)
  console.log(`格式      : ${manifest.format}`)
  console.log(`含密码哈希: ${manifest.withPasswordHashes ? '是（敏感）' : '否'}`)

  if (problems.length) {
    console.log(`\n✗ 校验失败 ${problems.length} 项：`)
    for (const problem of problems) console.log(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log('\n✓ 备份完整：所有文件存在、校验和与行数都一致')
}

/* ------------------------------------------------------------------ */
/* 导出模式                                                            */
/* ------------------------------------------------------------------ */

async function exportData() {
  const client = await connect()
  try {
    const serverVersion = (await client.query('select version() as v')).rows[0].v
    const tables = (
      await client.query(
        `select tablename from pg_tables where schemaname = 'public' order by tablename`,
      )
    ).rows.map((row) => row.tablename)

    const outDir = resolve(
      OUT_ARG ?? `backups/${stamp()}`,
    )
    mkdirSync(outDir, { recursive: true })

    const wantJson = FORMAT === 'json' || FORMAT === 'both'
    const wantCsv = FORMAT === 'csv' || FORMAT === 'both'
    if (!wantJson && !wantCsv) die(`--format 只能是 json / csv / both，收到：${FORMAT}`)

    console.log('===== 开始导出 =====')
    console.log(`目标目录  : ${outDir}`)
    console.log(`格式      : ${FORMAT}`)
    console.log(`表数量    : ${tables.length}`)
    console.log(`密码哈希  : ${WITH_HASHES ? '包含（敏感！）' : '不包含'}\n`)

    const manifestTables = []
    let totalRows = 0

    for (const table of tables) {
      const rows = await readTable(client, table)
      totalRows += rows.length
      const columns = rows.length > 0 ? Object.keys(rows[0]) : []
      const written = []

      if (wantJson) {
        const fileName = `public.${table}.json`
        const content = `${JSON.stringify(rows, null, 2)}\n`
        writeFileSync(resolve(outDir, fileName), content, 'utf8')
        written.push({
          format: 'json',
          file: fileName,
          rows: rows.length,
          bytes: Buffer.byteLength(content),
          sha256: sha256(content),
        })
      }
      if (wantCsv) {
        const fileName = `public.${table}.csv`
        const content = toCsv(rows, columns)
        writeFileSync(resolve(outDir, fileName), content, 'utf8')
        written.push({
          format: 'csv',
          file: fileName,
          rows: rows.length,
          bytes: Buffer.byteLength(content),
          sha256: sha256(content),
        })
      }

      // manifest 只记一份（以 JSON 为主；只导 CSV 时记 CSV）
      const primary = written.find((item) => item.format === 'json') ?? written[0]
      manifestTables.push({
        table,
        rows: rows.length,
        columns,
        file: primary.file,
        sha256: primary.sha256,
        format: primary.format,
        files: written,
      })

      console.log(`✓ ${table.padEnd(20)} ${String(rows.length).padStart(6)} 行`)
    }

    /* ---------- auth.users（基础账号信息） ---------- */
    let authEntry = null
    const authColumns = [
      'id',
      'email',
      'created_at',
      'updated_at',
      'confirmed_at',
      'last_sign_in_at',
      'raw_user_meta_data',
    ]
    if (WITH_HASHES) authColumns.push('encrypted_password')

    const authRows = (
      await client.query(`select ${authColumns.map(quoteIdent).join(', ')} from auth.users order by created_at`)
    ).rows

    if (wantJson) {
      const fileName = 'auth.users.json'
      const content = `${JSON.stringify(authRows, null, 2)}\n`
      writeFileSync(resolve(outDir, fileName), content, 'utf8')
      authEntry = {
        table: 'auth.users',
        rows: authRows.length,
        columns: authColumns,
        file: fileName,
        sha256: sha256(content),
        format: 'json',
        withPasswordHashes: WITH_HASHES,
      }
    }
    if (wantCsv) {
      const fileName = 'auth.users.csv'
      const content = toCsv(authRows, authColumns)
      writeFileSync(resolve(outDir, fileName), content, 'utf8')
      if (!authEntry) {
        authEntry = {
          table: 'auth.users',
          rows: authRows.length,
          columns: authColumns,
          file: fileName,
          sha256: sha256(content),
          format: 'csv',
          withPasswordHashes: WITH_HASHES,
        }
      }
    }
    console.log(`✓ ${'auth.users'.padEnd(20)} ${String(authRows.length).padStart(6)} 行（基础字段${WITH_HASHES ? ' + 密码哈希' : ''}）`)

    /* ---------- manifest ---------- */
    const appPkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    const manifest = {
      generatedAt: new Date().toISOString(),
      app: { name: appPkg.name, version: appPkg.version },
      database: { host: HOST, database: 'postgres', serverVersion },
      format: FORMAT,
      withPasswordHashes: WITH_HASHES,
      totals: { publicTables: tables.length, publicRows: totalRows, authUsers: authRows.length },
      tables: manifestTables,
      authUsers: authEntry,
      note: WITH_HASHES
        ? '导出包含密码哈希，请把本目录当作机密保存。'
        : '未导出密码哈希；如需完整还原登录凭据，请加 --with-password-hashes 重新导出。',
    }
    writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const readme = [
      'campus-forum 数据备份',
      '',
      `生成时间：${manifest.generatedAt}`,
      `应用版本：${appPkg.name}@${appPkg.version}`,
      `格式：${FORMAT}`,
      '',
      '内容：',
      ...manifestTables.map((item) => `  ${item.file.padEnd(34)} ${String(item.rows).padStart(6)} 行`),
      ...(authEntry ? [`  ${authEntry.file.padEnd(34)} ${String(authEntry.rows).padStart(6)} 行`] : []),
      '',
      '校验：node scripts/export-data.mjs --verify <本目录>',
      '还原：在新库执行 supabase/init.sql 后，按「被引用表在前」的顺序导入 JSON（profiles → boards → posts → comments → …）。',
      '',
    ].join('\n')
    writeFileSync(resolve(outDir, 'README.txt'), readme, 'utf8')

    console.log('\n===== 导出完成 =====')
    console.log(`目录      : ${outDir}`)
    console.log(`业务表    : ${tables.length} 张，共 ${totalRows} 行`)
    console.log(`账号      : ${authRows.length} 条`)
    console.log(`清单      : manifest.json（含每文件 sha256）`)
    console.log(`\n校验：node scripts/export-data.mjs --verify ${OUT_ARG ?? 'backups/<时间戳>'}`)
  } finally {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */

if (VERIFY_DIR) {
  verifyBackup(VERIFY_DIR)
} else {
  await exportData()
}
