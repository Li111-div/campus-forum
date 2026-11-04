import type { ReactNode } from 'react'
import { Inbox, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { parseAvatar } from '../lib/avatar'

/* ------------------------------ 头像 ------------------------------ */

const SIZES = {
  xs: 'h-6 w-6 text-xs rounded-[8px]',
  sm: 'h-8 w-8 text-sm rounded-[10px]',
  md: 'h-10 w-10 text-base rounded-xl',
  lg: 'h-14 w-14 text-2xl rounded-2xl',
  xl: 'h-20 w-20 text-4xl rounded-[22px]',
} as const

export function Avatar({
  name,
  avatar,
  size = 'md',
}: {
  name: string
  avatar?: string | null
  size?: keyof typeof SIZES
}) {
  const style = parseAvatar(avatar)
  return (
    <span
      title={name}
      aria-label={name}
      style={{ background: `linear-gradient(135deg, ${style.from}, ${style.to})` }}
      className={`inline-flex shrink-0 items-center justify-center leading-none text-white ring-1 ring-black/5 select-none ${SIZES[size]}`}
    >
      {style.emoji}
    </span>
  )
}

/* ------------------------------ 加载 / 空 / 错误 ------------------------------ */

export function Spinner({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-sm text-ink-muted">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

export function EmptyState({
  title = '这里还什么都没有',
  description,
  action,
  icon,
  bare = false,
}: {
  title?: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
  /** 已经在外层卡片里时传 true，避免「卡片套卡片」 */
  bare?: boolean
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 text-center ${
        bare
          ? 'px-6 py-12'
          : 'rounded-card border border-dashed border-hairline-strong bg-white/60 px-8 py-16'
      }`}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-50 text-slate-300">
        {icon ?? <Inbox className="h-7 w-7" />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        {description ? (
          <p className="max-w-sm text-xs leading-6 text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export function ErrorState({
  error,
  retry,
}: {
  error: unknown
  retry?: () => void
}) {
  const message = error instanceof Error ? error.message : String(error ?? '未知错误')
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-red-100/80 bg-red-50/50 px-8 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-red-400 shadow-card">
        <TriangleAlert className="h-6 w-6" />
      </div>
      <p className="max-w-md text-sm leading-6 text-red-600">{message}</p>
      {retry ? (
        <button
          type="button"
          onClick={retry}
          className="inline-flex items-center gap-1.5 rounded-control bg-white px-3.5 py-2 text-xs font-medium text-ink-soft ring-1 ring-hairline transition hover:bg-slate-50 hover:ring-hairline-strong"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          重试
        </button>
      ) : null}
    </div>
  )
}

/* ------------------------------ 胶囊标签 ------------------------------ */

const TONES: Record<string, string> = {
  slate: 'bg-slate-100/80 text-ink-muted',
  blue: 'bg-blue-50 text-blue-600',
  red: 'bg-red-50 text-red-500',
  amber: 'bg-amber-50 text-amber-600',
  green: 'bg-emerald-50 text-emerald-600',
  violet: 'bg-violet-50 text-violet-600',
}

export function Badge({
  children,
  tone = 'slate',
}: {
  children: ReactNode
  tone?: 'slate' | 'blue' | 'red' | 'amber' | 'green' | 'violet'
}) {
  return <span className={`pill ${TONES[tone] ?? TONES.slate}`}>{children}</span>
}

/* ------------------------------ 卡片 ------------------------------ */

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return <div className={`card ${padded ? 'p-5 sm:p-6' : ''} ${className}`}>{children}</div>
}

/** 页面/区块标题：小标题 + 可选说明 + 右侧操作 */
export function SectionTitle({
  icon,
  title,
  hint,
  right,
}: {
  icon?: ReactNode
  title: ReactNode
  hint?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {icon ? <span className="text-ink-muted">{icon}</span> : null}
      <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
      {right ? <div className="ml-auto">{right}</div> : null}
    </div>
  )
}
