import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft, MessageSquare, Send, UserPlus } from 'lucide-react'
import {
  fetchConversations,
  fetchDMMessages,
  fetchProfile,
  fetchUserRelation,
  markConversationRead,
  sendDM,
  type ConversationItem,
  type DMMessage,
} from '../lib/api'
import { useAuth } from '../lib/auth'
import { Avatar, EmptyState, ErrorState, Spinner } from '../components/ui'

/* ------------------------------ 时间格式化 ------------------------------ */

const pad2 = (n: number) => String(n).padStart(2, '0')

function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function dayKeyOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function dayLabelOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (dayKeyOf(iso) === dayKeyOf(today.toISOString())) return '今天'
  if (dayKeyOf(iso) === dayKeyOf(yesterday.toISOString())) return '昨天'
  const sameYear = date.getFullYear() === today.getFullYear()
  return sameYear
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 会话列表用的紧凑时间：今天显示时分，昨天显示「昨天」，更早显示日期。 */
function listTimeOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  if (dayKeyOf(iso) === dayKeyOf(today.toISOString())) return clockOf(iso)
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (dayKeyOf(iso) === dayKeyOf(yesterday.toISOString())) return '昨天'
  const sameYear = date.getFullYear() === today.getFullYear()
  return sameYear
    ? `${date.getMonth() + 1}/${date.getDate()}`
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

function isSameGroup(prev: DMMessage, next: DMMessage): boolean {
  if (prev.sender_id !== next.sender_id) return false
  if (dayKeyOf(prev.created_at) !== dayKeyOf(next.created_at)) return false
  return new Date(next.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000
}

/* ------------------------------ 消息分组 ------------------------------ */

type ChatItem =
  | { kind: 'day'; key: string; label: string }
  | {
      kind: 'group'
      key: string
      mine: boolean
      messages: DMMessage[]
      /** 间隔超过 5 分钟才在组上方显示一次时间（微信就是这样，不每条都挂时间） */
      timeLabel?: string
    }

const TIME_GAP_MS = 5 * 60_000

function buildChatItems(messages: DMMessage[], myId: string | null): ChatItem[] {
  const items: ChatItem[] = []
  let currentDay = ''
  let previousAt: number | null = null
  let group: {
    kind: 'group'
    key: string
    mine: boolean
    messages: DMMessage[]
    timeLabel?: string
  } | null = null

  for (const message of messages) {
    const at = new Date(message.created_at).getTime()
    const day = dayKeyOf(message.created_at)
    let dayChanged = false

    if (day !== currentDay) {
      currentDay = day
      dayChanged = true
      group = null
      items.push({ kind: 'day', key: `day-${day}`, label: dayLabelOf(message.created_at) })
    }

    const mine = message.sender_id === myId
    const prev = group?.messages[group.messages.length - 1]
    if (group && prev && isSameGroup(prev, message)) {
      group.messages.push(message)
    } else {
      // 跨天时已经有日期分隔，就不再重复显示时间
      const gap = previousAt === null ? Number.POSITIVE_INFINITY : at - previousAt
      group = {
        kind: 'group',
        key: `g-${message.seq}`,
        mine,
        messages: [message],
        timeLabel: !dayChanged && gap > TIME_GAP_MS ? clockOf(message.created_at) : undefined,
      }
      items.push(group)
    }

    previousAt = at
  }

  return items
}

/* ------------------------------ 会话列表 ------------------------------ */

function ConversationList({
  items,
  activePeerId,
}: {
  items: ConversationItem[]
  activePeerId?: string
}) {
  if (items.length === 0) {
    return (
      <div className="px-3 py-8">
        <EmptyState
          bare
          title="还没有私信"
          description="加个好友就能开始聊天了。"
          icon={<MessageSquare className="h-7 w-7" />}
        />
      </div>
    )
  }

  return (
    <ul>
      {items.map((item) => {
        const active = item.peer_id === activePeerId
        return (
          <li key={item.conversation_id}>
            <Link
              to={`/messages/${item.peer_id}`}
              className={`relative flex items-center gap-2.5 px-3 py-3 transition ${
                active ? 'bg-blue-50' : 'hover:bg-slate-50'
              }`}
            >
              {active ? (
                <span className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-blue-500" />
              ) : null}
              <Avatar name={item.peer_name} avatar={item.peer_avatar} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`truncate text-sm ${
                      active ? 'font-semibold text-blue-700' : 'font-medium text-slate-800'
                    }`}
                  >
                    {item.peer_name}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-muted">
                    {listTimeOf(item.last_at)}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <p className="min-w-0 flex-1 truncate text-xs text-ink-muted">
                    {item.last_content ?? '还没有消息'}
                  </p>
                  {item.unread_count > 0 ? (
                    <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                      {item.unread_count > 99 ? '99+' : item.unread_count}
                    </span>
                  ) : null}
                </div>
              </div>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

/* ------------------------------ 聊天面板 ------------------------------ */

function ChatPanel({
  conversationId,
  peerId,
  peerName,
  peerAvatar,
  canSend,
}: {
  /** 还没有任何消息时是 null —— 首条消息由 send_dm 在数据库侧创建会话 */
  conversationId: string | null
  peerId: string
  peerName: string
  peerAvatar: string | null
  /** 只有双向好友才能发消息；删好友 / 被拉黑后历史仍可看，但不能发 */
  canSend: boolean
}) {
  const { userId, profile } = useAuth()
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const messagesQuery = useQuery({
    queryKey: ['dm-messages', conversationId ?? 'new-' + peerId],
    queryFn: () => fetchDMMessages(conversationId as string),
    enabled: Boolean(conversationId),
    // Realtime 负责即时到达；这里保留 30 秒兜底（断线重连后也能补上）
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const messages: DMMessage[] = messagesQuery.data ?? []
  const items = useMemo(() => buildChatItems(messages, userId), [messages, userId])

  // 打开会话 / 收到新消息后标记已读
  useEffect(() => {
    if (!conversationId || !messagesQuery.isSuccess) return
    if (!messages.some((m) => m.sender_id !== userId && !m.is_read)) return
    void markConversationRead(conversationId).then(() => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['social-badges'] })
    })
  }, [messages, messagesQuery.isSuccess, conversationId, userId, queryClient])

  // 滚到底部（直接操作滚动容器，避免 scrollIntoView 连带滚动整页）
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [items.length, conversationId])

  const send = useMutation({
    mutationFn: (content: string) => sendDM(peerId, content),
    onSuccess: () => {
      setText('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      void queryClient.invalidateQueries({ queryKey: ['conversations'] })
      void queryClient.invalidateQueries({ queryKey: ['dm-messages'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '发送失败，请稍后重试'),
  })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const content = text.trim()
    if (!content || send.isPending || !canSend) return
    send.mutate(content)
  }


  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f2f4f9]">
      {/* 头部 */}
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline bg-white/70 px-3 py-2.5">
        <Link
          to="/messages"
          className="rounded-xl p-1.5 text-ink-muted transition hover:bg-slate-100 md:hidden"
          aria-label="返回会话列表"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <Link to={`/u/${peerId}`} className="group flex min-w-0 items-center gap-2.5">
          <Avatar name={peerName} avatar={peerAvatar} size="sm" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-800 group-hover:text-blue-600">
              {peerName}
            </span>
            <span className="block text-[11px] text-ink-muted">
              {canSend ? '好友 · 私信' : '已不是好友'}
            </span>
          </span>
        </Link>
        <Link
          to={`/u/${peerId}`}
          className="ml-auto hidden shrink-0 rounded-xl px-2 py-1 text-xs text-ink-muted transition hover:bg-slate-100 hover:text-slate-600 sm:block"
        >
          查看主页
        </Link>
      </header>

      {/* 消息区 */}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-5 sm:px-5"
      >
        <div className="flex flex-col gap-3">
          {conversationId && messagesQuery.isPending ? (
            <Spinner label="正在加载消息…" />
          ) : null}
          {messagesQuery.isError ? (
            <ErrorState error={messagesQuery.error} retry={() => void messagesQuery.refetch()} />
          ) : null}

          {messages.length === 0 && !messagesQuery.isPending ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-slate-300 ring-1 ring-slate-200">
                <MessageSquare className="h-6 w-6" />
              </span>
              <p className="text-sm font-medium text-slate-600">还没有消息</p>
              <p className="max-w-xs text-xs leading-5 text-ink-muted">
                发第一条消息打个招呼吧，对方会在几秒内收到。
              </p>
            </div>
          ) : null}

          {items.map((item) => {
            if (item.kind === 'day') {
              return (
                <div key={item.key} className="flex justify-center py-1">
                  <span className="rounded-full bg-white/80 px-2.5 py-0.5 text-[11px] text-ink-muted ring-1 ring-slate-200/70">
                    {item.label}
                  </span>
                </div>
              )
            }

            const mine = item.mine

            return (
              <div key={item.key} className="flex flex-col gap-1.5">
                {item.timeLabel ? (
                  <div className="flex justify-center">
                    <span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] tabular-nums text-ink-muted">
                      {item.timeLabel}
                    </span>
                  </div>
                ) : null}
                <div className={`flex items-start gap-2.5 ${mine ? 'justify-end' : 'justify-start'}`}>
                {mine ? null : <Avatar name={peerName} avatar={peerAvatar} size="sm" />}

                  <div className={`flex min-w-0 flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
                    {item.messages.map((message, index) => {
                      const isFirst = index === 0
                      const isLast = index === item.messages.length - 1
                      return (
                        <div
                          key={message.seq}
                          className={`max-w-[min(76vw,32rem)] whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 ${
                            mine
                              ? `bg-blue-600 text-white ${isFirst ? 'rounded-tr-md' : ''} ${isLast ? 'rounded-br-md' : ''}`
                              : `bg-white text-slate-800 ${isFirst ? 'rounded-tl-md' : ''} ${isLast ? 'rounded-bl-md' : ''}`
                          } rounded-xl`}
                        >
                          {message.content}
                        </div>
                      )
                    })}
                  </div>

                  {mine ? (
                    <Avatar
                      name={profile?.display_name ?? '我'}
                      avatar={profile?.avatar}
                      size="sm"
                    />
                  ) : null}
                </div>
              </div>
            )
          })}

        </div>
      </div>

      {/* 输入区 */}
      {canSend ? null : (
        <p className="shrink-0 border-t border-amber-100 bg-amber-50 px-3 py-2 text-center text-xs text-amber-700">
          你们还不是好友，无法发送消息。历史消息仍可查看。
        </p>
      )}

      <form onSubmit={onSubmit} className="shrink-0 border-t border-hairline bg-[#f7f7f7] px-3 py-3">
        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(event) => {
                setText(event.target.value)
                const el = event.currentTarget
                el.style.height = 'auto'
                el.style.height = `${Math.min(el.scrollHeight, 132)}px`
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  onSubmit(event)
                }
              }}
              rows={1}
              maxLength={2000}
              disabled={!canSend}
              placeholder={
                canSend ? '发消息…' : '还不是好友，无法发送'
              }
              title={canSend ? 'Enter 发送，Shift+Enter 换行' : undefined}
              aria-label="私信输入框"
              className="max-h-[132px] w-full resize-none rounded-2xl border border-hairline bg-slate-50/70 px-3.5 py-2.5 pr-14 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100"
            />
            <span className="pointer-events-none absolute bottom-2 right-3 text-[10px] tabular-nums text-slate-300">
              {text.length}/2000
            </span>
          </div>
          <button
            type="submit"
            disabled={!canSend || send.isPending || !text.trim()}
            className="inline-flex h-[42px] shrink-0 items-center gap-1.5 rounded-2xl bg-blue-600 px-4 text-sm font-medium text-white shadow-card transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-4 w-4" />
            发送
          </button>
        </div>
      </form>
    </div>
  )
}


/* ------------------------------ 页面 ------------------------------ */

export default function MessagesPage() {
  const { peerId } = useParams<{ peerId?: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  // 进入页面就把未读角标刷新一次
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['social-badges'] })
  }, [queryClient])

  const conversations: ConversationItem[] = conversationsQuery.data ?? []
  const active = peerId ? conversations.find((c) => c.peer_id === peerId) : undefined

  // 会话可能还没建出来（好友之间第一次说话）：这时单独查关系和对方资料
  const relationQuery = useQuery({
    queryKey: ['user-relation', peerId],
    queryFn: () => fetchUserRelation(peerId as string),
    enabled: Boolean(peerId),
  })
  const peerProfileQuery = useQuery({
    queryKey: ['profile', peerId],
    queryFn: () => fetchProfile(peerId as string),
    enabled: Boolean(peerId) && !active,
  })

  // 桌面端：没带 peerId 且已有会话时自动进第一个（列表常驻，体验更连贯）
  // 移动端：保持会话列表可见，让用户自己选（否则永远看不到列表）
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 768px)').matches,
  )
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)')
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!isDesktop || peerId || conversations.length === 0) return
    navigate(`/messages/${conversations[0].peer_id}`, { replace: true })
  }, [isDesktop, peerId, conversations, navigate])

  if (conversationsQuery.isPending) return <Spinner label="正在加载会话…" />
  if (conversationsQuery.isError && !conversationsQuery.data) {
    return <ErrorState error={conversationsQuery.error} retry={() => void conversationsQuery.refetch()} />
  }

  const peerProfile = peerProfileQuery.data ?? null
  const isFriend = relationQuery.data === 'friend'
  // 有历史会话就展示聊天记录（可能已不是好友，输入会被禁用）；没会话则只有好友才能进来
  const chatReady = Boolean(active) || isFriend
  const notFriend =
    Boolean(peerId) && !active && relationQuery.isSuccess && !isFriend

  return (
    // 微信式布局：铺满整页，没有圆角卡片、没有边框阴影，左白右灰直接贴边
    <section className="h-full overflow-hidden">
      <div className="flex h-full min-h-0">
        {/* 会话列表：移动端选中会话后隐藏 */}
        <aside
          className={`w-full shrink-0 flex-col border-r border-hairline bg-white md:flex md:w-72 ${
            peerId ? 'hidden' : 'flex'
          }`}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3.5 py-3">
            <MessageSquare className="h-4 w-4 text-ink-muted" />
            <h1 className="text-sm font-semibold text-slate-800">私信</h1>
            <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
              {conversations.length}
            </span>
            <Link
              to="/friends"
              className="ml-auto inline-flex items-center gap-1 rounded-xl px-1.5 py-1 text-xs text-blue-600 transition hover:bg-blue-50"
            >
              <UserPlus className="h-3.5 w-3.5" />
              加好友
            </Link>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList items={conversations} activePeerId={peerId} />
          </div>
        </aside>

        {/* 聊天区 */}
        <div className={`min-w-0 flex-1 ${peerId ? 'block' : 'hidden md:block'}`}>
          {chatReady ? (
            <ChatPanel
              conversationId={active?.conversation_id ?? null}
              peerId={peerId as string}
              peerName={active?.peer_name ?? peerProfile?.display_name ?? '同学'}
              peerAvatar={active?.peer_avatar ?? peerProfile?.avatar ?? null}
              canSend={isFriend}
            />
          ) : notFriend ? (
            <div className="flex h-full items-center justify-center px-6">
              <EmptyState
                title="你们还不是好友"
                description="只有双向好友才能互发私信。先去好友页发起申请吧。"
                action={
                  <Link
                    to="/friends"
                    className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
                  >
                    去加好友
                  </Link>
                }
              />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-50 text-slate-300 ring-1 ring-slate-200">
                <MessageSquare className="h-6 w-6" />
              </span>
              <p className="text-sm font-medium text-slate-600">选择一个会话开始聊天</p>
              <p className="text-xs text-ink-muted">左侧列表里的好友都可以私聊</p>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
