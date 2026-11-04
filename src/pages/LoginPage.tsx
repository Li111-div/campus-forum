import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { LogIn, Mail, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'

const inputCls =
  'w-full rounded-xl border border-hairline bg-slate-50/70 px-3.5 py-2.5 text-sm outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100'

function friendlyAuthError(message: string): string {
  if (/invalid login credentials/i.test(message)) return '邮箱或密码不正确'
  if (/email not confirmed/i.test(message)) return '邮箱还没确认，请先到邮箱里点确认链接'
  if (/too many requests|rate limit/i.test(message)) return '尝试太频繁，请稍后再试'
  if (/invalid email/i.test(message)) return '邮箱格式不正确'
  return message
}

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { session } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from ?? '/'

  useEffect(() => {
    if (session) navigate(from, { replace: true })
  }, [session, from, navigate])

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!email.trim() || !password) {
      setError('请填写邮箱和密码')
      return
    }
    setLoading(true)
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    setLoading(false)
    if (authError) {
      setError(friendlyAuthError(authError.message))
      return
    }
    toast.success('登录成功')
    navigate(from, { replace: true })
  }

  return (
    <div className="mx-auto max-w-md py-6 sm:py-10">
      <div className="card px-6 py-9">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-card">
            <LogIn className="h-5 w-5" />
          </div>
          <h1 className="text-[22px] font-bold tracking-tight text-ink">登录校园论坛</h1>
          <p className="mt-1 text-xs text-ink-muted">用注册时的邮箱和密码登录</p>
        </div>

        {/* noValidate：用我们自己的中文提示，而不是浏览器的英文原生气泡 */}
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
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={`${inputCls} pl-9`}
              />
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="password" className="block text-xs font-medium text-slate-600">
                密码
              </label>
              <Link
                to="/forgot-password"
                className="text-xs text-blue-600 transition hover:text-blue-500 hover:underline"
              >
                忘记密码？
              </Link>
            </div>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              className={inputCls}
            />
          </div>

          {error ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-ink-muted">
          还没有账号？
          <Link to="/register" className="ml-1 font-medium text-blue-600 hover:underline">
            注册一个
          </Link>
        </p>

        <p className="mt-2 text-center text-xs text-ink-muted">
          忘记密码了？
          <Link to="/forgot-password" className="ml-1 font-medium text-blue-600 hover:underline">
            用邮箱重置
          </Link>
        </p>
      </div>

      <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-ink-muted">
        <ShieldCheck className="h-3.5 w-3.5" />
        密码由 Supabase Auth 加密保存，论坛系统本身不接触明文密码
      </p>
    </div>
  )
}
