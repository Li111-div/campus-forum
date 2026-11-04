/**
 * 帖子时间筛选：预设范围（今天 / 近 3 天 / 近 7 天 / 近 30 天）+ 自定义日期区间。
 *
 * 约定：
 * - 一律按浏览器本地时区的「自然日」计算边界，避免跨时区错位；
 * - 区间左闭右开：created_at >= since 且 created_at < until，与 SQL 一致；
 * - 未选择时间（all，或自定义但没填日期）返回 null，调用方不传过滤参数。
 */

export type TimePreset = 'all' | 'today' | '3d' | '7d' | '30d' | 'custom'

export interface TimeRange {
  /** 起始时间（含），ISO 字符串；null = 不设下限 */
  since: string | null
  /** 结束时间（不含），ISO 字符串；null = 不设上限 */
  until: string | null
}

const DAY = 86_400_000

const PRESET_KEYS = new Set<string>(['all', 'today', '3d', '7d', '30d', 'custom'])

/** 「今天 / 近 3 天 / …」包含今天在内共几个自然日。 */
const PRESET_DAYS: Partial<Record<TimePreset, number>> = {
  today: 1,
  '3d': 3,
  '7d': 7,
  '30d': 30,
}

export const TIME_PRESET_OPTIONS: ReadonlyArray<{ key: TimePreset; label: string }> = [
  { key: 'all', label: '不限时间' },
  { key: 'today', label: '今天' },
  { key: '3d', label: '近 3 天' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
]

/** 把 URL 参数里的 range 解析成合法预设（非法值回落到 all）。 */
export function parseTimePreset(value: string | null | undefined): TimePreset {
  const key = (value ?? '').trim()
  return PRESET_KEYS.has(key) ? (key as TimePreset) : 'all'
}

/** 本地时区当天 00:00。 */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 解析 <input type="date"> 的值（YYYY-MM-DD）为本地当天 00:00；非法返回 null。 */
export function parseDateInput(value: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  // 拒绝 2026-02-31 这类被 Date 自动进位的日期
  if (Number.isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

/** Date → YYYY-MM-DD（用于 <input type="date"> 的 value）。 */
export function formatDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 展示用短日期：同年 MM-DD，跨年 YYYY-MM-DD。 */
export function formatDayShort(date: Date, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const monthDay = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}-${monthDay}`
}

/**
 * 把「预设 + 自定义日期」解析成实际的时间区间。
 * 返回 null 表示不做时间过滤。
 */
export function resolveTimeRange(
  preset: TimePreset,
  from?: string | null,
  to?: string | null,
  now: Date = new Date(),
): TimeRange | null {
  if (preset === 'all') return null

  if (preset === 'custom') {
    let fromDate = parseDateInput(from)
    let toDate = parseDateInput(to)
    if (!fromDate && !toDate) return null
    // 起止填反了也能用：自动对调
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      const swap = fromDate
      fromDate = toDate
      toDate = swap
    }
    return {
      since: fromDate ? startOfDay(fromDate).toISOString() : null,
      until: toDate ? new Date(startOfDay(toDate).getTime() + DAY).toISOString() : null,
    }
  }

  const days = PRESET_DAYS[preset] ?? 1
  const since = new Date(startOfDay(now).getTime() - (days - 1) * DAY)
  return { since: since.toISOString(), until: null }
}

/** 人类可读的筛选描述，用于空状态提示与自定义按钮文案。 */
export function describeTimeRange(
  preset: TimePreset,
  from?: string | null,
  to?: string | null,
  now: Date = new Date(),
): string {
  if (preset === 'all') return '不限时间'
  if (preset === 'custom') {
    const fromDate = parseDateInput(from)
    const toDate = parseDateInput(to)
    if (fromDate && toDate) return `${formatDayShort(fromDate, now)} 至 ${formatDayShort(toDate, now)}`
    if (fromDate) return `${formatDayShort(fromDate, now)} 起`
    if (toDate) return `${formatDayShort(toDate, now)} 止`
    return '自定义'
  }
  return TIME_PRESET_OPTIONS.find((option) => option.key === preset)?.label ?? '不限时间'
}
