import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Ban,
  CheckCircle2,
  FileText,
  Flag,
  Inbox,
  Lock,
  LockOpen,
  Pin,
  PinOff,
  Plus,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../lib/auth'
import {
  adminAddBannedWord,
  adminDeleteBannedWord,
  adminDeletePost,
  adminLockPost,
  adminResolveFeedback,
  adminResolveReport,
  adminSetActive,
  adminSetPinned,
  fetchAdminBannedWords,
  fetchAdminFeedback,
  fetchAdminPosts,
  fetchAdminUsers,
  fetchReports,
  type AdminFeedbackItem,
  type AdminUserRow,
  type FeedbackStatus,
} from '../lib/api'
import { formatDateTime } from '../lib/format'
import type { Post, Report, ReportStatus, ReportTarget, UserRole } from '../types/db'
import { Avatar, Badge, EmptyState, ErrorState, Spinner } from '../components/ui'

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'
const DANGER_OUTLINE_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60'
const DANGER_SOLID_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60'
const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-white px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:ring-2 focus:ring-blue-100'

const ROLE_LABEL: Record<UserRole, string> = {
  admin: '管理员',
  moderator: '版主',
  user: '普通用户',
}
const ROLE_TONE: Record<UserRole, 'red' | 'violet' | 'slate'> = {
  admin: 'red',
  moderator: 'violet',
  user: 'slate',
}

const TARGET_LABEL: Record<ReportTarget, string> = {
  post: '帖子',
  comment: '评论',
  user: '用户',
}
const TARGET_TONE: Record<ReportTarget, 'blue' | 'violet' | 'amber'> = {
  post: 'blue',
  comment: 'violet',
  user: 'amber',
}

const STATUS_LABEL: Record<ReportStatus, string> = {
  pending: '待处理',
  resolved: '已处理',
  rejected: '已驳回',
}
const STATUS_TONE: Record<ReportStatus, 'amber' | 'green' | 'slate'> = {
  pending: 'amber',
  resolved: 'green',
  rejected: 'slate',
}

type AdminTab = 'reports' | 'posts' | 'users' | 'words' | 'feedback'

const ADMIN_TABS: Array<{ key: AdminTab; label: string; icon: LucideIcon }> = [
  { key: 'reports', label: '举报处理', icon: Flag },
  { key: 'posts', label: '帖子管理', icon: FileText },
  { key: 'users', label: '用户管理', icon: UserRound },
  { key: 'words', label: '违禁词', icon: ShieldAlert },
  { key: 'feedback', label: '反馈', icon: Inbox },
]

const REPORT_FILTERS: Array<{ key: ReportStatus | 'all'; label: string }> = [
  { key: 'pending', label: '待处理' },
  { key: 'resolved', label: '已处理' },
  { key: 'rejected', label: '已驳回' },
  { key: 'all', label: '全部' },
]

/* ------------------------------ 举报处理 ------------------------------ */

function ReportTargetLink({ report }: { report: Report }) {
  if (report.target_type === 'post') {
    return (
      <Link to={`/post/${report.target_id}`} className="text-blue-600 hover:text-blue-500">
        查看被举报帖子
        {report.target_post?.title ? `：${report.target_post.title}` : ''}
      </Link>
    )
  }
  if (report.target_type === 'user') {
    return (
      <Link to={`/u/${report.target_id}`} className="text-blue-600 hover:text-blue-500">
        查看被举报用户
        {report.target_profile?.display_name ? `：${report.target_profile.display_name}` : ''}
      </Link>
    )
  }

  const comment = report.target_comment
  if (!comment) {
    return (
      <span className="text-ink-muted">
        被举报评论 #{report.target_id.slice(0, 8)}（该评论可能已不存在）
      </span>
    )
  }
  return (
    <div className="space-y-1">
      <Link
        to={{ pathname: `/post/${comment.post_id}`, search: `?comment=${comment.id}` }}
        className="text-blue-600 hover:text-blue-500"
      >
        查看被举报评论（跳转到所在帖子）
      </Link>
      <p className="line-clamp-2 text-[11px] text-ink-muted">评论内容：{comment.content}</p>
      {comment.is_deleted ? <p className="text-[11px] text-red-500">该评论已被删除</p> : null}
    </div>
  )
}

function ReportsPanel() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<ReportStatus | 'all'>('pending')

  const query = useQuery({
    queryKey: ['reports', status],
    queryFn: () => fetchReports(status === 'all' ? undefined : status),
  })

  const resolve = useMutation({
    mutationFn: (vars: { id: string; status: 'resolved' | 'rejected' }) =>
      adminResolveReport(vars.id, vars.status),
    onSuccess: (_result, vars) => {
      toast.success(vars.status === 'resolved' ? '举报已处理' : '举报已驳回')
      void queryClient.invalidateQueries({ queryKey: ['reports'] })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '处理失败，请稍后重试')
    },
  })

  const reports = query.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {REPORT_FILTERS.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => setStatus(filter.key)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                status === filter.key
                  ? 'border-blue-200 bg-blue-50 font-medium text-blue-600'
                  : 'border-slate-200 bg-white text-ink-muted hover:bg-slate-50'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-muted">
          共 {reports.length} 条
          {status === 'pending' && reports.length > 0 ? '（优先处理）' : ''}
        </p>
      </div>

      {query.isPending ? <Spinner /> : null}
      {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}

      {!query.isPending && !query.error && reports.length === 0 ? (
        <EmptyState
          title="没有相关举报"
          description="切换筛选条件看看，或者这里目前确实没有待处理内容。"
        />
      ) : null}

      {reports.length > 0 ? (
        <ul className="space-y-4">
          {reports.map((report) => {
            const busy = resolve.isPending && resolve.variables?.id === report.id
            return (
              <li key={report.id} className="card p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TARGET_TONE[report.target_type]}>
                    {TARGET_LABEL[report.target_type]}
                  </Badge>
                  <Badge tone={STATUS_TONE[report.status]}>{STATUS_LABEL[report.status]}</Badge>
                  <span className="text-xs text-ink-muted">{formatDateTime(report.created_at)}</span>
                  <span className="ml-auto text-[11px] text-slate-300">
                    #{report.id.slice(0, 8)}
                  </span>
                </div>

                <p className="mt-2 text-sm font-medium text-slate-800">举报原因：{report.reason}</p>
                {report.detail ? (
                  <p className="mt-1 text-sm leading-[1.7] text-ink-soft">{report.detail}</p>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <span>举报人：{report.reporter?.display_name ?? '未知用户'}</span>
                  <span className="text-slate-300">·</span>
                  <ReportTargetLink report={report} />
                </div>

                {report.status === 'pending' ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => resolve.mutate({ id: report.id, status: 'resolved' })}
                      className={PRIMARY_BUTTON}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      已处理
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => resolve.mutate({ id: report.id, status: 'rejected' })}
                      className={DANGER_OUTLINE_BUTTON}
                    >
                      <XCircle className="h-4 w-4" />
                      驳回
                    </button>
                    {busy ? <span className="text-xs text-ink-muted">处理中…</span> : null}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-ink-muted">
                    处理时间：{report.handled_at ? formatDateTime(report.handled_at) : '—'}
                    {report.resolution_note ? ` · 备注：${report.resolution_note}` : ''}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/* ------------------------------ 帖子管理 ------------------------------ */

function PostsPanel() {
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['admin-posts', keyword],
    queryFn: () => fetchAdminPosts(keyword || undefined),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-posts'] })
    void queryClient.invalidateQueries({ queryKey: ['posts'] })
    void queryClient.invalidateQueries({ queryKey: ['post'] })
    // 作者页 / 个人中心 / 收藏列表也要跟着刷新，否则删帖后 30s 内还能看到这条帖子
    void queryClient.invalidateQueries({ queryKey: ['author-posts'] })
    void queryClient.invalidateQueries({ queryKey: ['my-posts'] })
    void queryClient.invalidateQueries({ queryKey: ['my-favorites'] })
    void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
    void queryClient.invalidateQueries({ queryKey: ['author'] })
  }

  const pin = useMutation({
    mutationFn: (post: Post) => adminSetPinned(post.id, !post.is_pinned),
    onSuccess: (_result, post) => {
      toast.success(post.is_pinned ? '已取消置顶' : '已置顶该帖')
      invalidate()
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试')
    },
  })

  const lock = useMutation({
    mutationFn: (post: Post) => adminLockPost(post.id, !post.is_locked),
    onSuccess: (_result, post) => {
      toast.success(post.is_locked ? '已解锁该帖' : '已锁定该帖')
      invalidate()
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试')
    },
  })

  const remove = useMutation({
    mutationFn: (post: Post) => adminDeletePost(post.id),
    onSuccess: () => {
      toast.success('帖子已删除')
      setConfirmId(null)
      invalidate()
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '删除失败，请稍后重试')
    },
  })

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setKeyword(input.trim())
  }

  const posts = query.data ?? []
  const busy = pin.isPending || lock.isPending || remove.isPending

  return (
    <div className="space-y-4">
      <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="搜索帖子标题…"
            className={`${INPUT_CLASS} pl-9`}
          />
        </div>
        <button type="submit" className={SECONDARY_BUTTON}>
          搜索
        </button>
        {keyword ? (
          <button
            type="button"
            onClick={() => {
              setInput('')
              setKeyword('')
            }}
            className={SECONDARY_BUTTON}
          >
            清空
          </button>
        ) : null}
      </form>

      <p className="text-xs text-ink-muted">
        共 {posts.length} 篇{keyword ? `（关键词：${keyword}）` : ''}，已删除的帖子会置灰且不能重复操作。
      </p>

      {query.isPending ? <Spinner /> : null}
      {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}

      {!query.isPending && !query.error && posts.length === 0 ? (
        <EmptyState title="没有找到帖子" description="换个关键词试试，或清空搜索条件。" />
      ) : null}

      {posts.length > 0 ? (
        <ul className="space-y-2">
          {posts.map((post) => (
            <li
              key={post.id}
              className={`rounded-2xl border p-4 ${
                post.is_deleted
                  ? 'border-slate-200 bg-slate-50/80 opacity-70'
                  : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                {post.is_pinned ? (
                  <Badge tone="red">
                    <Pin className="h-3 w-3" />
                    置顶
                  </Badge>
                ) : null}
                {post.is_locked ? (
                  <Badge tone="amber">
                    <Lock className="h-3 w-3" />
                    已锁帖
                  </Badge>
                ) : null}
                {post.is_deleted ? <Badge tone="slate">已删除</Badge> : null}
                <Badge tone="blue">{post.board_slug}</Badge>
                <span className="text-xs text-ink-muted">{formatDateTime(post.created_at)}</span>
              </div>

              <h3 className="mt-2 text-sm font-semibold text-slate-800">
                {post.is_deleted ? (
                  <span className="text-ink-muted line-through">{post.title}</span>
                ) : (
                  <Link to={`/post/${post.id}`} className="hover:text-blue-600">
                    {post.title}
                  </Link>
                )}
              </h3>

              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                <span>作者：{post.author?.display_name ?? '未知用户'}</span>
                <span className="text-slate-300">·</span>
                <span>
                  赞 {post.like_count} · 评论 {post.comment_count} · 收藏 {post.favorite_count}
                </span>
              </div>

              {!post.is_deleted ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => pin.mutate(post)}
                    className={SECONDARY_BUTTON}
                  >
                    {post.is_pinned ? (
                      <PinOff className="h-4 w-4" />
                    ) : (
                      <Pin className="h-4 w-4" />
                    )}
                    {post.is_pinned ? '取消置顶' : '置顶'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => lock.mutate(post)}
                    className={SECONDARY_BUTTON}
                  >
                    {post.is_locked ? (
                      <LockOpen className="h-4 w-4" />
                    ) : (
                      <Lock className="h-4 w-4" />
                    )}
                    {post.is_locked ? '解锁' : '锁帖'}
                  </button>

                  {confirmId === post.id ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="text-xs text-red-600">确认删除这篇帖子？</span>
                      <button
                        type="button"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(post)}
                        className={DANGER_SOLID_BUTTON}
                      >
                        <Trash2 className="h-4 w-4" />
                        {remove.isPending ? '删除中…' : '确认删除'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmId(null)}
                        className={SECONDARY_BUTTON}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmId(post.id)}
                      className={DANGER_OUTLINE_BUTTON}
                    >
                      <Trash2 className="h-4 w-4" />
                      删除
                    </button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/* ------------------------------ 用户管理（仅管理员） ------------------------------ */

function UsersPanel() {
  const queryClient = useQueryClient()
  const [input, setInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [banTarget, setBanTarget] = useState<AdminUserRow | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['admin-users', keyword],
    queryFn: () => fetchAdminUsers(keyword || undefined),
  })

  const setActive = useMutation({
    mutationFn: (vars: { user: AdminUserRow; active: boolean; reason?: string }) =>
      adminSetActive(vars.user.id, vars.active, vars.reason),
    onSuccess: (_result, vars) => {
      toast.success(
        vars.active ? `已解封 ${vars.user.display_name}` : `已封禁 ${vars.user.display_name}`,
      )
      setBanTarget(null)
      setReason('')
      setReasonError(null)
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      // 被封的可能是自己（版主互封）或正在看的作者页，相关缓存一并失效
      void queryClient.invalidateQueries({ queryKey: ['author'] })
      void queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试')
    },
  })

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setKeyword(input.trim())
  }

  const confirmBan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!banTarget) return
    const text = reason.trim()
    if (text.length < 2) {
      setReasonError('请填写封禁原因（至少 2 个字）')
      return
    }
    setReasonError(null)
    setActive.mutate({ user: banTarget, active: false, reason: text })
  }

  const users = query.data ?? []

  return (
    <div className="space-y-4">
      <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="搜索昵称…"
            className={`${INPUT_CLASS} pl-9`}
          />
        </div>
        <button type="submit" className={SECONDARY_BUTTON}>
          搜索
        </button>
        {keyword ? (
          <button
            type="button"
            onClick={() => {
              setInput('')
              setKeyword('')
            }}
            className={SECONDARY_BUTTON}
          >
            清空
          </button>
        ) : null}
      </form>

      <p className="text-xs text-ink-muted">
        共 {users.length} 位用户{keyword ? `（关键词：${keyword}）` : ''}。封禁必须填写原因。
      </p>

      {query.isPending ? <Spinner /> : null}
      {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}

      {!query.isPending && !query.error && users.length === 0 ? (
        <EmptyState title="没有找到用户" description="换个关键词试试。" />
      ) : null}

      {users.length > 0 ? (
        <ul className="space-y-2">
          {users.map((user) => (
            <li
              key={user.id}
              className={`card p-5 ${
                user.is_active ? '' : 'opacity-80'
              }`}
            >
              <div className="flex flex-wrap items-start gap-3">
                <Avatar name={user.display_name} avatar={user.avatar} size="md" />

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/u/${user.id}`}
                      className="truncate text-sm font-medium text-slate-800 hover:text-blue-600"
                    >
                      {user.display_name}
                    </Link>
                    <Badge tone={ROLE_TONE[user.role]}>{ROLE_LABEL[user.role]}</Badge>
                    {user.is_active ? (
                      <Badge tone="green">正常</Badge>
                    ) : (
                      <Badge tone="red">已封禁</Badge>
                    )}
                  </div>

                  <p className="mt-1 text-xs text-ink-muted">
                    {user.username ? `@${user.username} · ` : ''}
                    注册于 {formatDateTime(user.created_at)}
                  </p>

                  {user.bio ? (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-muted">{user.bio}</p>
                  ) : null}

                  <p className="mt-1 text-xs text-ink-muted">
                    帖子 {user.post_count} · 评论 {user.comment_count} · 粉丝 {user.follower_count}
                  </p>

                  {!user.is_active ? (
                    <p className="mt-1 text-xs leading-5 text-red-600">
                      封禁原因：{user.banned_reason ?? '未填写'}
                      {user.banned_until ? `（至 ${formatDateTime(user.banned_until)}）` : ''}
                    </p>
                  ) : null}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {user.is_active ? (
                    <button
                      type="button"
                      onClick={() => {
                        setBanTarget(user)
                        setReason('')
                        setReasonError(null)
                      }}
                      className={DANGER_OUTLINE_BUTTON}
                    >
                      <Ban className="h-4 w-4" />
                      封禁
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={setActive.isPending}
                      onClick={() => setActive.mutate({ user, active: true })}
                      className={SECONDARY_BUTTON}
                    >
                      <ShieldCheck className="h-4 w-4" />
                      解封
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {banTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4"
          role="presentation"
          onClick={() => setBanTarget(null)}
        >
          <form
            onSubmit={confirmBan}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-t-[20px] bg-white p-6 shadow-float sm:rounded-card"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">封禁用户</h2>
                <p className="mt-1 text-xs leading-5 text-ink-muted">
                  封禁「{banTarget.display_name}」后，该账号将无法发帖、评论和互动。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setBanTarget(null)}
                aria-label="关闭"
                className="rounded-xl p-1 text-ink-muted transition hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="mt-4 block text-xs font-medium text-slate-600">
              封禁原因
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                maxLength={100}
                placeholder="例如：发布广告引流内容"
                className="mt-1 w-full resize-none rounded-xl border border-hairline bg-white px-3 py-2 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
              />
            </label>
            {reasonError ? <p className="mt-1 text-xs text-red-600">{reasonError}</p> : null}

            <div className="mt-4 flex justify-end gap-2 border-t border-hairline pt-3">
              <button
                type="button"
                onClick={() => setBanTarget(null)}
                disabled={setActive.isPending}
                className={SECONDARY_BUTTON}
              >
                取消
              </button>
              <button type="submit" disabled={setActive.isPending} className={DANGER_SOLID_BUTTON}>
                <Ban className="h-4 w-4" />
                {setActive.isPending ? '处理中…' : '确认封禁'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------ 违禁词 ------------------------------ */

function WordsPanel() {
  const queryClient = useQueryClient()
  const [word, setWord] = useState('')
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const wordsQuery = useQuery({
    queryKey: ['admin-banned-words'],
    queryFn: fetchAdminBannedWords,
  })
  const words = wordsQuery.data ?? []

  const addMutation = useMutation({
    mutationFn: () => adminAddBannedWord(word.trim(), note.trim() || undefined),
    onSuccess: () => {
      toast.success('违禁词已添加')
      setWord('')
      setNote('')
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['admin-banned-words'] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : '添加失败，请稍后重试'
      setFormError(message)
      toast.error(message)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => adminDeleteBannedWord(id),
    onSuccess: () => {
      toast.success('违禁词已删除')
      void queryClient.invalidateQueries({ queryKey: ['admin-banned-words'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '删除失败，请稍后重试'),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!word.trim()) {
      setFormError('请先输入要拦截的词')
      return
    }
    addMutation.mutate()
  }

  return (
    <div className="space-y-5">
      <section className="card p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">违禁词检测</h2>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          命中规则：文本里只要包含词库中的词就会被拒绝（忽略大小写与空白）。发帖标题/正文、评论、昵称、用户名都会校验。
        </p>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={word}
            onChange={(event) => setWord(event.target.value)}
            maxLength={32}
            placeholder="要拦截的词，例如：代开发票"
            aria-label="违禁词"
            className={`${INPUT_CLASS} sm:max-w-xs`}
          />
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={60}
            placeholder="备注（可选）"
            aria-label="违禁词备注"
            className={`${INPUT_CLASS} sm:max-w-xs`}
          />
          <button type="submit" disabled={addMutation.isPending} className={PRIMARY_BUTTON}>
            <Plus className="h-4 w-4" />
            {addMutation.isPending ? '添加中…' : '添加'}
          </button>
        </form>

        {formError ? (
          <p className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{formError}</p>
        ) : null}
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">
          词库
          <span className="ml-2 text-xs font-normal text-ink-muted">{words.length} 个</span>
        </h2>

        {wordsQuery.isPending ? <Spinner label="正在加载违禁词…" /> : null}
        {wordsQuery.isError ? (
          <ErrorState error={wordsQuery.error} retry={() => void wordsQuery.refetch()} />
        ) : null}
        {wordsQuery.isSuccess && words.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">词库是空的，在上面添加一个试试。</p>
        ) : null}

        <ul className="mt-3 divide-y divide-hairline">
          {words.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <code className="rounded bg-slate-100 px-2 py-0.5 text-sm text-slate-700">{item.word}</code>
              {item.note ? <span className="text-xs text-ink-muted">{item.note}</span> : null}
              <span className="ml-auto text-[11px] text-slate-300">{formatDateTime(item.created_at)}</span>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`删除违禁词「${item.word}」？`)) deleteMutation.mutate(item.id)
                }}
                disabled={deleteMutation.isPending}
                className={DANGER_OUTLINE_BUTTON}
              >
                <Trash2 className="h-4 w-4" />
                删除
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
/* ------------------------------ 反馈 ------------------------------ */

const FEEDBACK_FILTERS: Array<{ key: 'all' | FeedbackStatus; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'resolved', label: '已处理' },
]

function FeedbackPanel() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<'all' | FeedbackStatus>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['admin-feedback', filter],
    queryFn: () => fetchAdminFeedback(filter === 'all' ? null : filter),
  })
  const items: AdminFeedbackItem[] = query.data ?? []

  const resolveMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeedbackStatus }) =>
      adminResolveFeedback(id, status),
    onSuccess: (_data, vars) => {
      toast.success(vars.status === 'resolved' ? '已标记为已处理' : '已重新打开')
      void queryClient.invalidateQueries({ queryKey: ['admin-feedback'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试'),
  })

  return (
    <section className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-slate-900">意见反馈</h2>
        <span className="text-xs text-ink-muted">{items.length} 条</span>
        <div className="ml-auto flex items-center gap-1 rounded-xl bg-slate-100 p-1">
          {FEEDBACK_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilter(item.key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                filter === item.key
                  ? 'bg-white text-slate-800 shadow-card'
                  : 'text-ink-muted hover:text-slate-700'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        用户在「意见反馈」页提交的建议 / 问题。点内容可展开全文，处理完可标记状态。
      </p>

      {query.isPending ? <Spinner label="正在加载反馈…" /> : null}
      {query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}
      {query.isSuccess && items.length === 0 ? (
        <p className="mt-4 text-sm text-ink-muted">这个筛选下还没有反馈。</p>
      ) : null}

      <ul className="mt-3 divide-y divide-hairline">
        {items.map((item) => (
          <li key={item.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Avatar name={item.display_name} size="xs" />
              <span className="text-sm font-medium text-slate-700">{item.display_name}</span>
              <Badge tone="blue">{item.category}</Badge>
              {item.status === 'resolved' ? (
                <Badge tone="green">已处理</Badge>
              ) : (
                <Badge tone="amber">待处理</Badge>
              )}
              <span className="ml-auto text-xs text-ink-muted">{formatDateTime(item.created_at)}</span>
            </div>
            <p
              onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              className={`mt-1 cursor-pointer whitespace-pre-wrap break-words text-sm leading-[1.7] text-ink-soft ${
                expandedId === item.id ? '' : 'line-clamp-2'
              }`}
            >
              {item.content}
            </p>
            {item.contact ? (
              <p className="mt-1 text-xs text-ink-muted">联系方式：{item.contact}</p>
            ) : null}
            <div className="mt-2 flex items-center gap-2">
              {item.status === 'resolved' ? (
                <>
                  <span className="text-[11px] text-ink-muted">
                    处理于 {item.handled_at ? formatDateTime(item.handled_at) : '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => resolveMutation.mutate({ id: item.id, status: 'pending' })}
                    disabled={resolveMutation.isPending}
                    className="ml-auto inline-flex items-center gap-1 rounded-xl border border-hairline bg-white px-2.5 py-1 text-xs text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                  >
                    重新打开
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => resolveMutation.mutate({ id: item.id, status: 'resolved' })}
                  disabled={resolveMutation.isPending}
                  className="ml-auto inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-60"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  标记已处理
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/* ------------------------------ 页面 ------------------------------ */

export default function AdminPage() {
  const { profile } = useAuth()
  const [tab, setTab] = useState<AdminTab>('reports')
  const canManageUsers = profile?.role === 'admin'

  return (
    <div className="space-y-5">
      <section className="card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <Shield className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight text-ink">
              管理后台
              <span className="ml-2 text-xs font-normal text-ink-muted">
                {profile?.role === 'admin' ? '管理员' : '版主'}
              </span>
            </h1>
            <p className="mt-0.5 text-xs leading-5 text-ink-muted">
              处理举报、管理帖子与用户。所有操作都会立即生效，请谨慎使用。
            </p>
          </div>
        </div>

        <div className="no-scrollbar mt-4 flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1">
          {ADMIN_TABS.map((tabItem) => (
            <button
              key={tabItem.key}
              type="button"
              onClick={() => setTab(tabItem.key)}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm transition ${
                tab === tabItem.key
                  ? 'bg-white font-medium text-slate-800 shadow-card'
                  : 'text-ink-muted hover:text-slate-700'
              }`}
            >
              <tabItem.icon className="h-4 w-4" />
              {tabItem.label}
            </button>
          ))}
        </div>
      </section>

      {tab === 'reports' ? <ReportsPanel /> : null}
      {tab === 'posts' ? <PostsPanel /> : null}
      {tab === 'users' ? (
        canManageUsers ? (
          <UsersPanel />
        ) : (
          <div className="rounded-card border border-amber-100 bg-amber-50/70 p-5 text-sm leading-6 text-amber-700">
            用户管理仅管理员可用。版主可以处理举报、置顶、锁帖与删帖。
          </div>
        )
      ) : null}
      {tab === 'words' ? (
        canManageUsers ? (
          <WordsPanel />
        ) : (
          <div className="rounded-card border border-amber-100 bg-amber-50/70 p-5 text-sm leading-6 text-amber-700">
            违禁词管理仅管理员可用。
          </div>
        )
      ) : null}
      {tab === 'feedback' ? (
        canManageUsers ? (
          <FeedbackPanel />
        ) : (
          <div className="rounded-card border border-amber-100 bg-amber-50/70 p-5 text-sm leading-6 text-amber-700">
            意见反馈仅管理员可见。
          </div>
        )
      ) : null}
    </div>
  )
}
