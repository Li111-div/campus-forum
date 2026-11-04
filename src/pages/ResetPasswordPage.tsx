import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Eye, EyeOff, KeyRound, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '../lib/auth'
import {
  PASSWORD_MIN,
  applyRecoverySession,
  clearRecoveryUrl,
  passwordProblem,
  readRecoveryError,
  readRecoveryTokens,
  updatePassword,
} from '../lib/password'

const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-slate-50/70 px-3.5 py-2.5 pr-10 text-sm outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100'
const PRIMARY_BUTTON =
  'w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'

type Phase = 'checking' | 'ready' | 'invalid' | 'done'

export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const { signOut } = useAuth()
  const [phase, setPhase] = useState<Phase>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invalidReason, setInvalidReason] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // StrictMode 下 effect 会跑两次，用 ref 防止重复消费同一个一次性 token
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    // Supabase 有时会在地址栏回传 error=access_denied&error_code=otp_expired
    const urlError = readRecoveryError()
    if (urlError) {
      setInvalidReason(urlError)
      setPhase('invalid')
      return
    }
    const tokens = readRecoveryTokens()
    if (!tokens) {
      setInvalidReason('没有找到重置链接里的凭证，请重新发送找回密码邮件')
      setPhase('invalid')
      return
    }
    void applyRecoverySession(tokens)
      .then(() => {
        // token 用掉就立刻从地址栏清掉，避免刷新页面时报「链接已失效」
        clearRecoveryUrl()
        setPhase('ready')
      })
      .catch((err) => {
        setInvalidReason(err instanceof Error ? err.message : null)
        setPhase('invalid')
      })
  }, [])

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (loading) return
    setError(null)
    const problem = passwordProblem(password, confirm)
    if (problem) {
      setError(problem)
      return
    }
    setLoading(true)
    try {
      await updatePassword(password)
      setPhase('done')
      toast.success('密码已更新，请用新密码登录')
    } catch (err) {
      const message = err instanceof Error ? err.message : '重置失败，请重新发起找回密码'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  /* ---------- 校验中 ---------- */
  if (phase === 'checking') {
    return (
      <div className="mx-auto max-w-md py-10">
        <div className="card px-6 py-12 text-center shadow-card">
          <KeyRound className="mx-auto mb-3 h-9 w-9 animate-pulse text-blue-500" />
          <p className="text-sm text-ink-muted">正在校验重置链接…</p>
        </div>
      </div>
    )
  }

  /* ---------- 链接无效 / 过期 ---------- */
  if (phase === 'invalid') {
    return (
      <div className="mx-auto max-w-md py-6 sm:py-10">
        <div className="card px-6 py-12 text-center">
          <ShieldAlert className="mx-auto mb-3 h-9 w-9 text-amber-500" />
          <h1 className="text-xl font-bold tracking-tight text-ink">重置链接无效或已过期</h1>
          <p className="mt-2 text-sm leading-[1.7] text-ink-soft">
            {invalidReason ?? '重置链接只能用一次，而且有有效期。请重新发起找回密码，收到新邮件后再点开。'}
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <Link to="/forgot-password" className={PRIMARY_BUTTON}>
              重新发送重置邮件
            </Link>
            <Link
              to="/login"
              className="w-full rounded-xl border border-hairline bg-white py-2.5 text-center text-sm text-ink-soft transition hover:bg-slate-50"
            >
              返回登录
            </Link>
          </div>
        </div>
      </div>
    )
  }

  /* ---------- 重置成功 ---------- */
  if (phase === 'done') {
    return (
      <div className="mx-auto max-w-md py-6 sm:py-10">
        <div className="card px-6 py-12 text-center">
          <CheckCircle2 className="mx-auto mb-3 h-9 w-9 text-emerald-500" />
          <h1 className="text-xl font-bold tracking-tight text-ink">密码已更新</h1>
          <p className="mt-2 text-sm leading-[1.7] text-ink-soft">
            其它设备上的登录已经失效，请用新密码重新登录。
          </p>
          <button
            type="button"
            onClick={() => {
              void signOut().then(() => navigate('/login', { replace: true }))
            }}
            className={`mt-6 ${PRIMARY_BUTTON}`}
          >
            去登录
          </button>
        </div>
      </div>
    )
  }

  /* ---------- 设置新密码 ---------- */
  return (
    <div className="mx-auto max-w-md py-6 sm:py-10">
      <div className="card px-6 py-9">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-card">
            <KeyRound className="h-5 w-5" />
          </div>
          <h1 className="text-[22px] font-bold tracking-tight text-ink">设置新密码</h1>
          <p className="mt-1 text-xs text-ink-muted">设置后旧密码立即失效，其它设备会被登出</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-slate-600">
              新密码
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={`至少 ${PASSWORD_MIN} 位`}
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-muted transition hover:bg-slate-100"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="confirm" className="mb-1.5 block text-xs font-medium text-slate-600">
              确认新密码
            </label>
            <input
              id="confirm"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              placeholder="再输一次"
              className={INPUT_CLASS}
            />
          </div>

          {error ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={loading || !password || !confirm}
            className={PRIMARY_BUTTON}
          >
            {loading ? '提交中…' : '确认修改密码'}
          </button>
        </form>
      </div>

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
