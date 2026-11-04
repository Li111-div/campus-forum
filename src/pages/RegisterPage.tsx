import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Mail, ShieldCheck, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '../lib/supabase'
import { checkBannedWord } from '../lib/api'
import { useAuth } from '../lib/auth'

const inputCls =
  'w-full rounded-xl border border-hairline bg-slate-50/70 px-3.5 py-2.5 text-sm outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100'

function friendlySignUpError(message: string): string {
  if (/user already registered|already been registered/i.test(message)) return '这个邮箱已经注册过了，直接登录即可'
  if (/password should be at least/i.test(message)) return '密码至少 6 位'
  if (/invalid email/i.test(message)) return '邮箱格式不正确'
  if (/rate limit|too many/i.test(message)) return '注册太频繁，请稍后再试'
  return message
}

export default function RegisterPage() {
  const navigate = useNavigate()
  const { session } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needConfirm, setNeedConfirm] = useState(false)

  useEffect(() => {
    if (session) navigate('/', { replace: true })
  }, [session, navigate])

  const validate = (): string | null => {
    const name = displayName.trim()
    if (name.length < 2 || name.length > 20) return '昵称需要 2–20 个字符'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return '请输入有效的邮箱地址'
    if (password.length < 6) return '密码至少 6 位'
    if (password !== confirm) return '两次输入的密码不一致'
    return null
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }

    setLoading(true)
    // 昵称先预检违禁词：命中就直接给中文提示，避免注册失败只看到通用错误
    const hit = await checkBannedWord(displayName.trim()).catch(() => null)
    if (hit) {
      setLoading(false)
      setError(`昵称包含违禁词「${hit}」，请换一个`)
      return
    }

    const { data, error: authError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { display_name: displayName.trim() } },
    })
    setLoading(false)

    if (authError) {
      setError(friendlySignUpError(authError.message))
      return
    }

    if (data.session) {
      toast.success('注册成功，欢迎加入校园论坛')
      navigate('/', { replace: true })
    } else {
      // 项目默认关闭邮箱确认；如果后台开启了确认，这里会提示
      setNeedConfirm(true)
      toast.success('注册成功，请到邮箱确认后再登录')
    }
  }

  if (needConfirm) {
    return (
      <div className="mx-auto max-w-md py-10">
        <div className="card px-6 py-12 text-center">
          <Mail className="mx-auto mb-3 h-9 w-9 text-blue-500" />
          <h1 className="text-xl font-bold tracking-tight text-ink">去邮箱确认一下</h1>
          <p className="mt-2 text-sm leading-[1.7] text-ink-soft">
            我们给 <span className="font-medium text-slate-700">{email}</span> 发了一封确认邮件，
            点开链接后就可以登录了。
          </p>
          <Link
            to="/login"
            className="mt-6 inline-block rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
          >
            去登录
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md py-6 sm:py-10">
      <div className="card px-6 py-9">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-card">
            <UserPlus className="h-5 w-5" />
          </div>
          <h1 className="text-[22px] font-bold tracking-tight text-ink">注册校园论坛</h1>
          <p className="mt-1 text-xs text-ink-muted">只需邮箱、昵称和密码</p>
        </div>

        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <label htmlFor="displayName" className="mb-1.5 block text-xs font-medium text-slate-600">
              昵称
            </label>
            <input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="2–20 个字符，会公开显示"
              maxLength={20}
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-slate-600">
              邮箱
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={inputCls}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-slate-600">
                密码
              </label>
              <input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 6 位"
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="confirm" className="mb-1.5 block text-xs font-medium text-slate-600">
                确认密码
              </label>
              <input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再输一次"
                className={inputCls}
              />
            </div>
          </div>

          {error ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? '注册中…' : '注册'}
          </button>

          <p className="text-center text-[11px] leading-5 text-ink-muted">
            注册即表示同意遵守
            <Link to="/rules" className="mx-0.5 text-blue-600 hover:underline">
              社区规则
            </Link>
            ；请勿发布广告、人身攻击与违法内容。
          </p>
        </form>

        <p className="mt-5 text-center text-xs text-ink-muted">
          已有账号？
          <Link to="/login" className="ml-1 font-medium text-blue-600 hover:underline">
            直接登录
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
