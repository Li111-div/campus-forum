import { useEffect, useState, type FormEvent } from 'react'
import { Eye, EyeOff, KeyRound, Save, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  PASSWORD_MIN,
  changePasswordWithVerify,
  passwordProblem,
} from '../lib/password'

const INPUT_CLASS =
  'mt-1 w-full rounded-xl border border-hairline bg-white px-3 py-2 pr-10 text-sm text-slate-800 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:ring-2 focus:ring-blue-100'
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'

/** 个人中心的「修改密码」弹窗：先校验当前密码，再改新密码。 */
export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (loading) return
    setError(null)
    if (!current) {
      setError('请输入当前密码')
      return
    }
    const problem = passwordProblem(next, confirm)
    if (problem) {
      setError(problem)
      return
    }
    if (current === next) {
      setError('新密码不能和当前密码相同')
      return
    }
    setLoading(true)
    try {
      await changePasswordWithVerify(current, next)
      toast.success('密码已修改，其它设备已登出')
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : '修改失败，请稍后重试'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="修改密码"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md rounded-t-[20px] bg-white p-6 shadow-float sm:rounded-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
              <KeyRound className="h-4 w-4 text-ink-muted" />
              修改密码
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              改完后其它设备会被登出，需要用新密码重新登录。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-xl p-1 text-ink-muted transition hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block text-xs font-medium text-slate-600">
            当前密码
            <div className="relative">
              <input
                id="current-password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                placeholder="验证身份用"
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={() => setShow((value) => !value)}
                aria-label={show ? '隐藏密码' : '显示密码'}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-ink-muted transition hover:bg-slate-100"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>

          <label className="block text-xs font-medium text-slate-600">
            新密码
            <input
              id="new-password"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              placeholder={`至少 ${PASSWORD_MIN} 位`}
              className={INPUT_CLASS}
            />
          </label>

          <label className="block text-xs font-medium text-slate-600">
            确认新密码
            <input
              id="confirm-password"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              placeholder="再输一次"
              className={INPUT_CLASS}
            />
          </label>

          {error ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-hairline pt-3">
            <button type="button" onClick={onClose} disabled={loading} className={SECONDARY_BUTTON}>
              取消
            </button>
            <button type="submit" disabled={loading || !current || !next || !confirm} className={PRIMARY_BUTTON}>
              <Save className="h-4 w-4" />
              {loading ? '提交中…' : '确认修改'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
