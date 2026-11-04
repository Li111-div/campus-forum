import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, KeyRound, Mail, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { PASSWORD_MIN, requestPasswordReset } from '../lib/password'

const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-slate-50/70 px-3.5 py-2.5 text-sm outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100'
const PRIMARY_BUTTON =
  'w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (loading) return
    setError(null)
    if (!EMAIL_RE.test(email.trim())) {
      setError('请输入有效的邮箱地址')
      return
    }
    setLoading(true)
    try {
      await requestPasswordReset(email.trim())
      setSent(true)
      toast.success('重置邮件已发送')
    } catch (err) {
      const message = err instanceof Error ? err.message : '发送失败，请稍后重试'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto max-w-md py-6 sm:py-10">
      <div className="card px-6 py-9">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-card">
            <KeyRound className="h-5 w-5" />
          </div>
          <h1 className="text-[22px] font-bold tracking-tight text-ink">找回密码</h1>
          <p className="mt-1 text-xs text-ink-muted">
            输入注册时的邮箱，我们会发一封带重置链接的邮件给你
          </p>
        </div>

        {sent ? (
          <div className="space-y-5">
            <div className="rounded-xl bg-emerald-50 px-3.5 py-3 text-sm leading-6 text-emerald-700">
              <p className="font-medium">邮件已发出</p>
              <p className="mt-1 text-xs leading-5">
                如果 <span className="font-medium">{email.trim()}</span> 已经注册过，几分钟内会收到重置链接。
                没收到的话，请检查垃圾邮件，或过一分钟再试一次。
              </p>
            </div>
            <p className="text-xs leading-5 text-ink-muted">
              出于安全考虑，无论这个邮箱是否注册过，都会显示「已发送」——这样别人就无法用这个页面探测谁注册过。
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setSent(false)
                  setError(null)
                }}
                className="w-full rounded-xl border border-hairline bg-white py-2.5 text-sm text-ink-soft transition hover:bg-slate-50"
              >
                换个邮箱再试
              </button>
              <Link
                to="/login"
                className="w-full rounded-xl bg-blue-600 py-2.5 text-center text-sm font-semibold text-white shadow-card transition hover:bg-blue-500"
              >
                返回登录
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-5">
            <div>
              <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-slate-600">
                邮箱
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  className={`${INPUT_CLASS} pl-9`}
                />
              </div>
            </div>

            {error ? (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
            ) : null}

            <button type="submit" disabled={loading} className={PRIMARY_BUTTON}>
              {loading ? '发送中…' : '发送重置邮件'}
            </button>

            <p className="text-center text-xs text-ink-muted">
              想起来了？
              <Link to="/login" className="ml-1 font-medium text-blue-600 hover:underline">
                返回登录
              </Link>
            </p>
          </form>
        )}
      </div>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-ink-muted">
        <ShieldCheck className="h-3.5 w-3.5" />
        重置链接只能用一次，{PASSWORD_MIN} 位以上的新密码才能提交
      </p>

      <div className="mt-4 text-center">
        <Link
          to="/login"
          className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-slate-600"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          返回登录页
        </Link>
      </div>
    </div>
  )
}
