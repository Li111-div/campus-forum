import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Check,
  MessageSquare,
  Search,
  ShieldOff,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react'
import {
  fetchFriendRequests,
  fetchFriends,
  removeFriend,
  respondFriendRequest,
  searchUsers,
  sendFriendRequest,
  setFriendBlock,
  type FriendItem,
  type FriendRequestItem,
  type SocialRelation,
} from '../lib/api'
import { formatTime } from '../lib/format'
import { Avatar, Badge, EmptyState, ErrorState, Spinner } from '../components/ui'

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'
const DANGER_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-1.5 text-xs text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60'
const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-white px-3.5 py-2.5 text-sm outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:ring-2 focus:ring-blue-100'

type TabKey = 'friends' | 'requests' | 'find'

const RELATION_LABEL: Partial<Record<SocialRelation, string>> = {
  friend: '已是好友',
  half: '对方已把你删除',
  blocked: '已拉黑',
  blockedBy: '无法添加',
  none: '',
  self: '这是你自己',
}

/* ------------------------------ 我的好友 ------------------------------ */

function FriendsTab() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ['friends'], queryFn: fetchFriends })
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['friends'] })
    void queryClient.invalidateQueries({ queryKey: ['social-badges'] })
  }

  const remove = useMutation({
    mutationFn: (friendId: string) => removeFriend(friendId),
    onSuccess: () => {
      toast.success('已删除好友')
      refresh()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试'),
    onSettled: () => setBusyId(null),
  })

  const block = useMutation({
    mutationFn: (friendId: string) => setFriendBlock(friendId, true),
    onSuccess: () => {
      toast.success('已拉黑，对方无法再给你发消息')
      refresh()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试'),
    onSettled: () => setBusyId(null),
  })

  if (query.isPending) return <Spinner label="正在加载好友…" />
  if (query.isError && !query.data) {
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  }

  const friends: FriendItem[] = query.data ?? []
  if (friends.length === 0) {
    return (
      <EmptyState
        bare
        title="还没有好友"
        description="去「找人」里搜一下同学的昵称，加上好友就能私聊了。"
        icon={<Users className="h-7 w-7" />}
      />
    )
  }

  return (
    <ul className="divide-y divide-hairline">
      {friends.map((friend) => (
        <li key={friend.friend_id} className="flex flex-wrap items-center gap-3 py-3">
          <Link to={`/u/${friend.friend_id}`} className="shrink-0">
            <Avatar name={friend.display_name} avatar={friend.avatar} size="md" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={`/u/${friend.friend_id}`}
                className="truncate text-sm font-medium text-slate-800 hover:text-blue-600"
              >
                {friend.display_name}
              </Link>
              {friend.relation !== 'friend' ? (
                <Badge tone="amber">{RELATION_LABEL[friend.relation] ?? friend.relation}</Badge>
              ) : null}
            </div>
            {friend.bio ? (
              <p className="mt-0.5 line-clamp-1 text-xs text-ink-muted">{friend.bio}</p>
            ) : null}
            <p className="mt-0.5 text-[11px] text-ink-muted">
              {friend.since ? `成为好友于 ${formatTime(friend.since)}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Link to={`/messages/${friend.friend_id}`} className={PRIMARY_BUTTON}>
              <MessageSquare className="h-3.5 w-3.5" />
              私信
            </Link>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`确定删除好友「${friend.display_name}」吗？`)) {
                  setBusyId(friend.friend_id)
                  remove.mutate(friend.friend_id)
                }
              }}
              disabled={busyId === friend.friend_id}
              className={SECONDARY_BUTTON}
            >
              <UserMinus className="h-3.5 w-3.5" />
              删除
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`拉黑「${friend.display_name}」后，对方无法再给你发消息，确定吗？`)) {
                  setBusyId(friend.friend_id)
                  block.mutate(friend.friend_id)
                }
              }}
              disabled={busyId === friend.friend_id}
              className={DANGER_BUTTON}
            >
              <ShieldOff className="h-3.5 w-3.5" />
              拉黑
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------ 好友申请 ------------------------------ */

function RequestRow({ item }: { item: FriendRequestItem }) {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const respond = useMutation({
    mutationFn: (accept: boolean) => respondFriendRequest(item.request_id, accept),
    onSuccess: (_d, accept) => {
      toast.success(accept ? '已同意，你们现在是好友了' : '已拒绝该申请')
      void queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['friends'] })
      void queryClient.invalidateQueries({ queryKey: ['social-badges'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试'),
    onSettled: () => setBusy(false),
  })

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <Link to={`/u/${item.peer_id}`} className="shrink-0">
        <Avatar name={item.peer_name} avatar={item.peer_avatar} size="md" />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/u/${item.peer_id}`}
            className="truncate text-sm font-medium text-slate-800 hover:text-blue-600"
          >
            {item.peer_name}
          </Link>
          {item.direction === 'outgoing' ? <Badge tone="slate">我发出的</Badge> : null}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">
          {item.message ? `留言：${item.message}` : '（没有留言）'}
        </p>
        <p className="mt-0.5 text-[11px] text-ink-muted">{formatTime(item.created_at)}</p>
      </div>
      {item.direction === 'incoming' ? (
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setBusy(true)
              respond.mutate(true)
            }}
            disabled={busy}
            className={PRIMARY_BUTTON}
          >
            <Check className="h-3.5 w-3.5" />
            同意
          </button>
          <button
            type="button"
            onClick={() => {
              setBusy(true)
              respond.mutate(false)
            }}
            disabled={busy}
            className={SECONDARY_BUTTON}
          >
            <X className="h-3.5 w-3.5" />
            拒绝
          </button>
        </div>
      ) : (
        <span className="shrink-0 text-xs text-ink-muted">等待对方同意…</span>
      )}
    </li>
  )
}

function RequestsTab() {
  const query = useQuery({ queryKey: ['friend-requests'], queryFn: fetchFriendRequests })

  if (query.isPending) return <Spinner label="正在加载申请…" />
  if (query.isError && !query.data) {
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  }

  const items: FriendRequestItem[] = query.data ?? []
  if (items.length === 0) {
    return (
      <EmptyState
        bare
        title="没有待处理的申请"
        description="别人加你为好友时会出现在这里。"
        icon={<UserPlus className="h-7 w-7" />}
      />
    )
  }

  return (
    <ul className="divide-y divide-hairline">
      {items.map((item) => (
        <RequestRow key={item.request_id} item={item} />
      ))}
    </ul>
  )
}

/* ------------------------------ 找人 ------------------------------ */

function FindTab() {
  const queryClient = useQueryClient()
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  const query = useQuery({
    queryKey: ['user-search', submitted],
    queryFn: () => searchUsers(submitted),
    enabled: submitted.length >= 2,
  })

  const add = useMutation({
    mutationFn: (userId: string) => sendFriendRequest(userId, ''),
    onSuccess: () => {
      toast.success('好友申请已发出')
      void queryClient.invalidateQueries({ queryKey: ['user-search'] })
      void queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试'),
  })

  const results = query.data ?? []
  const tooShort = submitted.length > 0 && submitted.length < 2

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSubmitted(keyword.trim())
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="输入昵称搜索同学（至少 2 个字）"
            aria-label="搜索用户"
            className={`${INPUT_CLASS} pl-9`}
          />
        </div>
        <button type="submit" className={PRIMARY_BUTTON}>
          搜索
        </button>
      </form>

      {tooShort ? <p className="text-xs text-amber-600">至少输入 2 个字才能搜索</p> : null}

      {query.isFetching ? <Spinner label="正在搜索…" /> : null}
      {query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : null}

      {!query.isFetching && !query.isError && submitted.length >= 2 && results.length === 0 ? (
        <EmptyState bare title="没有找到匹配的同学" description="换个昵称关键词试试。" />
      ) : null}

      {results.length > 0 ? (
        <ul className="divide-y divide-hairline">
          {results.map((user) => (
            <li key={user.user_id} className="flex flex-wrap items-center gap-3 py-3">
              <Link to={`/u/${user.user_id}`} className="shrink-0">
                <Avatar name={user.display_name} avatar={user.avatar} size="md" />
              </Link>
              <div className="min-w-0 flex-1">
                <Link
                  to={`/u/${user.user_id}`}
                  className="truncate text-sm font-medium text-slate-800 hover:text-blue-600"
                >
                  {user.display_name}
                </Link>
                {RELATION_LABEL[user.relation] ? (
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    {RELATION_LABEL[user.relation]}
                  </p>
                ) : null}
              </div>
              <div className="shrink-0">
                {user.relation === 'self' ? (
                  <span className="text-xs text-ink-muted">你自己</span>
                ) : user.relation === 'friend' ? (
                  <Link to={`/messages/${user.user_id}`} className={SECONDARY_BUTTON}>
                    <MessageSquare className="h-3.5 w-3.5" />
                    发私信
                  </Link>
                ) : user.relation === 'none' || user.relation === 'half' ? (
                  <button
                    type="button"
                    onClick={() => add.mutate(user.user_id)}
                    disabled={add.isPending && add.variables === user.user_id}
                    className={PRIMARY_BUTTON}
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                    加好友
                  </button>
                ) : (
                  <span className="text-xs text-ink-muted">无法添加</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/* ------------------------------ 页面 ------------------------------ */

export default function FriendsPage() {
  const [tab, setTab] = useState<TabKey>('friends')
  const requestsQuery = useQuery({ queryKey: ['friend-requests'], queryFn: fetchFriendRequests })
  const pendingCount = (requestsQuery.data ?? []).filter((r) => r.direction === 'incoming').length

  const tabs: Array<{ key: TabKey; label: string; badge?: number }> = [
    { key: 'friends', label: '我的好友' },
    { key: 'requests', label: '好友申请', badge: pendingCount },
    { key: 'find', label: '找人' },
  ]

  return (
    <div className="space-y-5">
      <section className="card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-500">
            <Users className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold tracking-tight text-ink">好友</h1>
            <p className="mt-1 text-sm leading-[1.7] text-ink-soft">
              搜同学昵称加好友，成为好友后就能互发私信；拉黑后对方无法再给你发消息。
            </p>
          </div>
        </div>

        <div className="no-scrollbar mt-4 flex gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={`inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm transition ${
                tab === item.key
                  ? 'bg-white font-medium text-slate-800 shadow-card'
                  : 'text-ink-muted hover:text-slate-700'
              }`}
            >
              {item.label}
              {item.badge && item.badge > 0 ? (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </section>

      <section className="card px-4 py-2 sm:px-6">
        {tab === 'friends' ? <FriendsTab /> : null}
        {tab === 'requests' ? <RequestsTab /> : null}
        {tab === 'find' ? (
          <div className="py-3">
            <FindTab />
          </div>
        ) : null}
      </section>

      <p className="flex items-center justify-center gap-1.5 text-[11px] text-ink-muted">
        <Trash2 className="h-3 w-3" />
        删除好友只影响你自己的列表，对方仍会看到你；拉黑会同时解除好友关系。
      </p>
    </div>
  )
}
