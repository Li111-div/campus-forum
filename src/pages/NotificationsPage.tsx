import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Bell,
  CheckCircle2,
  CornerDownRight,
  Megaphone,
  MessageSquare,
  ThumbsUp,
  type LucideIcon,
} from 'lucide-react'
import { fetchNotifications, markAllNotificationsRead } from '../lib/api'
import { formatTime } from '../lib/format'
import type { Notification, NotificationType } from '../types/db'
import { Avatar, Badge, EmptyState, ErrorState, Spinner } from '../components/ui'

const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'

interface TypeMeta {
  label: string
  icon: LucideIcon
  iconClass: string
}

const TYPE_META: Record<NotificationType, TypeMeta> = {
  comment: {
    label: '有人评论了你的帖子',
    icon: MessageSquare,
    iconClass: 'bg-blue-50 text-blue-500',
  },
  reply: {
    label: '有人回复了你',
    icon: CornerDownRight,
    iconClass: 'bg-sky-50 text-sky-500',
  },
  like: {
    label: '有人赞了你',
    icon: ThumbsUp,
    iconClass: 'bg-rose-50 text-rose-500',
  },
  system: {
    label: '系统通知',
    icon: Megaphone,
    iconClass: 'bg-amber-50 text-amber-500',
  },
  follow_post: {
    label: '你关注的人发了新帖',
    icon: Bell,
    iconClass: 'bg-violet-50 text-violet-500',
  },
}

export default function NotificationsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: fetchNotifications,
    // Realtime 会即时推送新通知；这里保留 30 秒兜底轮询
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const markAll = useMutation({
    mutationFn: (_options?: { silent?: boolean }) => markAllNotificationsRead(),
    onSuccess: (_data, variables) => {
      if (!variables?.silent) toast.success('已全部标记为已读')
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
      void queryClient.invalidateQueries({ queryKey: ['unread-count'] })
    },
    onError: (err, variables) => {
      if (!variables?.silent) {
        toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试')
      }
    },
  })

  const items = query.data ?? []
  const unread = items.filter((item) => !item.is_read).length

  /**
   * 打开通知页后自动把「进入时的未读」标记为已读，顶部铃铛和侧栏红点立即消失。
   * 只在首次加载后执行一次：否则停留期间新到达的通知会被下一轮轮询静默置读，
   * 用户永远看不到「有新通知」的提示。
   */
  const autoReadDone = useRef(false)
  useEffect(() => {
    if (autoReadDone.current) return
    if (query.isPending || markAll.isPending) return
    autoReadDone.current = true
    if (!items.some((item) => !item.is_read)) return
    markAll.mutate({ silent: true })
    // markAll 是稳定引用；这里只依赖「首屏数据是否已到」
  }, [items, query.isPending, markAll])

  const openNotification = (item: Notification) => {
    if (item.post_id) navigate(`/post/${item.post_id}`)
  }

  return (
    <div className="space-y-5">
      <header className="card flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight text-ink">
            <Bell className="h-5 w-5 text-blue-500" />
            通知
            {unread > 0 ? <Badge tone="blue">{unread} 条未读</Badge> : null}
          </h1>
          <p className="mt-0.5 text-xs text-ink-muted">
            评论、回复和你关注的人的新帖都会出现在这里。
          </p>
        </div>
        <button
          type="button"
          onClick={() => markAll.mutate()}
          disabled={unread === 0 || markAll.isPending}
          className={SECONDARY_BUTTON}
        >
          <CheckCircle2 className="h-4 w-4" />
          {markAll.isPending ? '处理中…' : '全部已读'}
        </button>
      </header>

      {query.isPending ? <Spinner /> : null}
      {query.error ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}

      {!query.isPending && !query.error && items.length === 0 ? (
        <EmptyState
          title="还没有通知"
          description="有人评论、回复你的帖子，或你关注的人发新帖时，会在这里提醒你。"
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item) => {
            const meta = TYPE_META[item.type]
            const Icon = meta.icon
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => openNotification(item)}
                  className={`flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                    item.is_read
                      ? 'border-slate-200 bg-white hover:bg-slate-50'
                      : 'border-blue-100 bg-blue-50/40 hover:bg-blue-50'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${meta.iconClass}`}
                  >
                    <Icon className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm leading-5 text-slate-700">
                        {item.actor ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Avatar
                              name={item.actor.display_name}
                              avatar={item.actor.avatar}
                              size="xs"
                            />
                            <span className="font-medium text-slate-900">
                              {item.actor.display_name}
                            </span>
                          </span>
                        ) : null}
                        <span className={item.actor ? 'ml-1' : ''}>{meta.label}</span>
                      </p>
                      {!item.is_read ? (
                        <span
                          className="h-2 w-2 shrink-0 rounded-full bg-blue-500"
                          aria-label="未读"
                        />
                      ) : null}
                    </div>

                    {item.post ? (
                      <p className="mt-1 truncate text-xs text-ink-muted">
                        帖子：{item.post.title}
                      </p>
                    ) : null}

                    <p className="mt-1 text-[11px] text-ink-muted">
                      {formatTime(item.created_at)}
                      {item.post_id ? ' · 点击查看帖子' : ''}
                    </p>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
