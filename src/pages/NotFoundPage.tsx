import { Link } from 'react-router-dom'
import { Compass, Home, PenSquare } from 'lucide-react'

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft transition hover:bg-slate-50'

export default function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 py-10 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-500">
        <Compass className="h-8 w-8" />
      </span>
      <p className="mt-4 text-5xl font-black tracking-tight text-slate-900">404</p>
      <h1 className="mt-2 text-lg font-semibold text-slate-800">页面走丢了</h1>
      <p className="mt-1 max-w-sm text-sm leading-[1.7] text-ink-soft">
        这个页面不存在，可能已经被删除，或者链接输错了。
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link to="/" className={PRIMARY_BUTTON}>
          <Home className="h-4 w-4" />
          返回首页
        </Link>
        <Link to="/new" className={SECONDARY_BUTTON}>
          <PenSquare className="h-4 w-4" />
          去发帖
        </Link>
      </div>
    </div>
  )
}
