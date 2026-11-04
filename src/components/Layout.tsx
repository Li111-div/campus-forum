import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  ChevronDown,
  Heart,
  Home,
  MessageSquare,
  Users,
  Lightbulb,
  LogOut,
  PenSquare,
  Search,
  Shield,
  User,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../lib/auth'
import { useRealtimeBridge } from '../lib/realtime'
import { fetchBoards, fetchSocialBadges, fetchUnreadCount } from '../lib/api'
import { getBoardMeta } from '../lib/constants'
import { Avatar } from './ui'

function BoardSidebar({
  unread,
  social,
  realtimeConnected,
}: {
  unread: number
  social: { pending: number; unreadDms: number }
  realtimeConnected: boolean
}) {
  const { data: boards } = useQuery({ queryKey: ['boards'], queryFn: fetchBoards, staleTime: 5 * 60_000 })
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  // 板块筛选只属于首页；离开首页时不应保留任何板块高亮
  const onHome = location.pathname === '/'
  const activeBoard = onHome ? params.get('board') : null

  /** 切板块时保留搜索词 / 排序 / 时间筛选，避免点一下侧栏就把筛选条件全清掉。 */
  const boardLink = (slug: string | null) => {
    const next = new URLSearchParams(location.search)
    if (slug) next.set('board', slug)
    else next.delete('board')
    const search = next.toString()
    return search ? `/?${search}` : '/'
  }

  const myLinks: Array<{ to: string; icon: LucideIcon; label: string; badge?: number }> = [
    { to: '/me', icon: User, label: '个人中心' },
    { to: '/notifications', icon: Bell, label: '通知', badge: unread },
    { to: '/friends', icon: Users, label: '好友', badge: social.pending },
    { to: '/messages', icon: MessageSquare, label: '私信', badge: social.unreadDms },
    { to: '/feedback', icon: Lightbulb, label: '意见反馈' },
    { to: '/rules', icon: Shield, label: '社区规则' },
  ]

  return (
    <div className="space-y-7">
      <nav>
        <p className="px-3 text-[11px] font-semibold tracking-[0.08em] text-ink-muted">板块</p>
        <ul className="mt-2 space-y-1">
          <li>
            <Link
              to={boardLink(null)}
              className={`flex items-center gap-2.5 rounded-control px-3 py-2 text-sm transition duration-150 ${
                onHome && !activeBoard
                  ? 'nav-item-active bg-blue-50 font-medium text-blue-600'
                  : 'text-ink-soft hover:bg-slate-50 hover:text-blue-600'
              }`}
            >
              <Home className="h-4 w-4" />
              全部
            </Link>
          </li>
          {(boards ?? []).map((board) => {
            const meta = getBoardMeta(board.slug)
            const active = activeBoard === board.slug
            return (
              <li key={board.slug}>
                <Link
                  to={boardLink(board.slug)}
                  className={`flex items-center gap-2.5 rounded-control px-3 py-2 text-sm transition duration-150 ${
                    active
                      ? `${meta.chip} nav-item-active font-medium`
                      : 'text-ink-soft hover:bg-slate-50 hover:text-blue-600'
                  }`}
                >
                  <meta.icon className={`h-4 w-4 ${active ? '' : meta.iconColor}`} />
                  <span className="flex-1">{board.name}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <nav>
        <p className="px-3 text-[11px] font-semibold tracking-[0.08em] text-ink-muted">我的</p>
        <ul className="mt-2 space-y-1">
          {myLinks.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-control px-3 py-2 text-sm transition duration-150 ${
                    isActive
                      ? 'nav-item-active bg-blue-50 font-medium text-blue-600'
                      : 'text-ink-soft hover:bg-slate-50 hover:text-blue-600'
                  }`
                }
              >
                <item.icon className="h-4 w-4" />
                <span className="flex-1">{item.label}</span>
                {item.badge && item.badge > 0 ? (
                  <span
                    aria-label={`${item.badge} 条未读通知`}
                    className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white"
                  >
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex items-center gap-1.5 px-3 text-[11px] text-ink-muted">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            realtimeConnected ? 'bg-emerald-500' : 'bg-slate-300'
          }`}
          aria-hidden
        />
        {realtimeConnected ? '实时推送已连接' : '未连接（改用轮询）'}
      </div>
    </div>
  )
}

function UserMenu() {
  const { profile, signOut, isAdmin } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!profile) {
    return (
      <div className="flex items-center gap-2">
        <Link
          to="/login"
          className="rounded-xl px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
        >
          登录
        </Link>
        <Link
          to="/register"
          className="rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-card hover:bg-blue-500"
        >
          注册
        </Link>
      </div>
    )
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full py-1 pl-1 pr-2 transition hover:bg-slate-100"
      >
        <Avatar name={profile.display_name} avatar={profile.avatar} size="sm" />
        <span className="hidden max-w-[7rem] truncate text-sm font-medium text-slate-700 sm:block">
          {profile.display_name}
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-ink-muted" />
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-52 overflow-hidden rounded-card border border-hairline bg-white py-1.5 shadow-float">
          <div className="border-b border-hairline px-3 py-2">
            <p className="truncate text-sm font-medium text-slate-800">{profile.display_name}</p>
            <p className="truncate text-[11px] text-ink-muted">
              {profile.username ? `@${profile.username}` : profile.role === 'admin' ? '管理员' : '普通用户'}
            </p>
          </div>
          {[
            { to: '/me', icon: User, label: '个人中心' },
            { to: '/me?tab=favorites', icon: Heart, label: '我的收藏' },
            { to: '/notifications', icon: Bell, label: '通知' },
            { to: '/friends', icon: Users, label: '好友' },
            { to: '/messages', icon: MessageSquare, label: '私信' },
            { to: '/feedback', icon: Lightbulb, label: '意见反馈' },
          ].map((item) => (
            <button
              key={item.to}
              type="button"
              onClick={() => {
                setOpen(false)
                navigate(item.to)
              }}
              className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm text-ink-soft transition hover:bg-slate-50 hover:text-blue-600"
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </button>
          ))}
          {isAdmin ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                navigate('/admin')
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink-soft hover:bg-slate-50"
            >
              <Shield className="h-4 w-4" />
              管理后台
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void signOut()
            }}
            className="flex w-full items-center gap-2 border-t border-hairline px-3 py-2 text-left text-sm text-ink-soft hover:bg-slate-50"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      ) : null}
    </div>
  )
}

export function Layout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { userId, profile, isBanned, profileError } = useAuth()
  // 实时推送：通知与私信直接失效缓存，轮询只做兜底
  const { connected: realtimeConnected } = useRealtimeBridge(userId)
  // 搜索框跟随 URL 里的 q：否则在首页点「清除」或从别处跳转后，输入框还留着旧词，回车又搜旧词
  const urlQuery = new URLSearchParams(location.search).get('q') ?? ''
  const [keyword, setKeyword] = useState(urlQuery)
  useEffect(() => {
    setKeyword(urlQuery)
  }, [urlQuery])
  const { data: social = { pending: 0, unreadDms: 0 } } = useQuery({
    queryKey: ['social-badges', userId],
    queryFn: fetchSocialBadges,
    enabled: Boolean(userId),
    refetchInterval: realtimeConnected ? 60_000 : 8_000,
    refetchIntervalInBackground: false,
    select: (data) => ({ pending: data.pending_requests, unreadDms: data.unread_dms }),
  })
  const { data: unread = 0 } = useQuery({
    queryKey: ['unread-count', userId],
    queryFn: fetchUnreadCount,
    enabled: Boolean(userId),
    // Realtime 通了就 60 秒兜底；没通就退回 8 秒轮询
    refetchInterval: realtimeConnected ? 60_000 : 8_000,
    refetchIntervalInBackground: false,
  })

  useEffect(() => {
    // 内容区自成一个滚动容器，切路由时把它滚回顶部
    window.scrollTo({ top: 0 })
    document.getElementById('app-scroll')?.scrollTo({ top: 0 })
  }, [location.pathname, location.search])

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault()
    const q = keyword.trim()
    navigate(q ? `/?q=${encodeURIComponent(q)}` : '/')
  }

  const isAuthPage =
    location.pathname === '/login' ||
    location.pathname === '/register' ||
    location.pathname === '/forgot-password' ||
    location.pathname === '/reset-password'
  // 私信页像微信那样整页铺满：隐藏论坛侧边栏 / 页脚，去掉容器内边距
  const isFullBleed = location.pathname.startsWith('/messages')
  const loggedIn = Boolean(profile)

  const mobileNav = [
    { to: '/', icon: Home, label: '首页', end: true },
    { to: '/new', icon: PenSquare, label: '发帖' },
    { to: '/messages', icon: MessageSquare, label: '私信', badge: social.unreadDms },
    { to: '/notifications', icon: Bell, label: '通知', badge: unread },
    { to: '/me', icon: User, label: '我的' },
  ]

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-white">
      <header className="z-30 shrink-0 bg-white">
        <div className="flex h-14 w-full items-center gap-3 px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-600 text-white shadow-card">
              <MessageSquare className="h-4 w-4" />
            </span>
            <span className="text-[17px] font-bold tracking-tight text-slate-900">校园论坛</span>
            <span className="hidden rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted sm:inline">
              树洞
            </span>
          </Link>

          {loggedIn ? (
            <form onSubmit={submitSearch} className="mx-auto hidden w-full max-w-md md:block">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索帖子标题或内容…"
                  className="w-full rounded-full border border-transparent bg-slate-100/70 py-2 pl-9 pr-4 text-sm text-ink outline-none transition placeholder:text-ink-muted hover:bg-slate-100 focus:border-blue-200 focus:bg-white focus:ring-2 focus:ring-blue-100"
                />
              </div>
            </form>
          ) : null}

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {loggedIn ? (
              <>
                <Link
                  to="/new"
                  className="hidden items-center gap-1.5 rounded-control bg-blue-600 px-3.5 py-2 text-sm font-medium text-white shadow-card transition hover:-translate-y-px hover:bg-blue-500 hover:shadow-lift sm:flex"
                >
                  <PenSquare className="h-4 w-4" />
                  发帖
                </Link>
                <Link
                  to="/notifications"
                  className="relative hidden rounded-control p-2 text-ink-soft transition hover:bg-slate-100 hover:text-blue-600 sm:block"
                  aria-label="通知"
                >
                  <Bell className="h-5 w-5" />
                  {unread > 0 ? (
                    <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </Link>
              </>
            ) : null}
            <UserMenu />
          </div>
        </div>
      </header>

      {isBanned && profile ? (
        <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-center text-xs text-red-600">
          {profile.banned_reason ? `账号已被限制：${profile.banned_reason}` : '账号已被限制发言'}
          {profile.banned_until ? `（到期时间：${profile.banned_until}）` : ''}
        </div>
      ) : null}

      {profileError && !profile ? (
        <div className="border-b border-amber-100 bg-amber-50 px-4 py-2 text-center text-xs text-amber-700">
          个人资料加载失败：{profileError}（请确认已执行数据库初始化 SQL）
        </div>
      ) : null}

      {/* 白色外壳：顶栏与左侧导航同为白底，中间没有分割线 */}
      <div className="flex min-h-0 w-full flex-1 bg-white">
        {isAuthPage ? null : (
          <aside className="hidden w-56 shrink-0 overflow-y-auto bg-white lg:block">
            <div className="px-3 py-5">
              <BoardSidebar unread={unread} social={social} realtimeConnected={realtimeConnected} />
            </div>
          </aside>
        )}
        {isFullBleed ? (
          <main className="min-h-0 flex-1 overflow-hidden pb-14 lg:pb-0">
            <Outlet />
          </main>
        ) : (
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <main
              id="app-scroll"
              className={`min-h-0 min-w-0 w-full flex-1 overflow-y-auto bg-canvas px-5 pb-20 pt-5 lg:px-7 lg:pb-6 ${
                isAuthPage ? '' : 'lg:rounded-tl-[22px]'
              }`}
            >
              <div className="mx-auto w-full max-w-[76rem]">
                <Outlet />
              </div>
            </main>
            {/* 阴影层：独立覆盖在内容之上（含卡片），固定不随滚动移动；登录页不显示 */}
            {isAuthPage ? null : (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 z-20 hidden lg:block lg:rounded-tl-[22px] lg:shadow-[inset_0_18px_34px_-16px_rgba(15,23,42,0.10),inset_20px_0_34px_-18px_rgba(15,23,42,0.075)]"
              />
            )}
          </div>
        )}
      </div>

      {/* 移动端底部导航 */}
      {isAuthPage ? null : (
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-white/90 backdrop-blur-xl lg:hidden">
          <div className="mx-auto flex max-w-md items-center justify-around px-2 py-1">
            {mobileNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-1.5 text-[11px] transition ${
                    isActive ? 'text-blue-600' : 'text-ink-muted'
                  }`
                }
              >
                <item.icon className="h-5 w-5" />
                {item.label}
                {item.badge && item.badge > 0 ? (
                  <span className="absolute right-1 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                ) : null}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  )
}
