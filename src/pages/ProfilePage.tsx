import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { AtSign, CalendarDays, KeyRound, MessageSquare, Pencil, Save, X } from 'lucide-react'
import { useAuth } from '../lib/auth'
import {
  fetchAuthorProfile,
  checkBannedWord,
  fetchBoards,
  fetchFollowers,
  fetchFollowing,
  fetchMyComments,
  fetchMyFavoritePosts,
  fetchMyPosts,
  fetchMyProfile,
  updateMyProfile,
} from '../lib/api'
import {
  AVATAR_BACKGROUNDS,
  AVATAR_EMOJI_GROUPS,
  encodeAvatar,
  parseAvatar,
} from '../lib/avatar'
import { excerpt, formatDateTime, formatTime } from '../lib/format'
import { usePostVotes } from '../lib/usePostVotes'
import type { MyProfile, UserRole } from '../types/db'
import { PostCard } from '../components/PostCard'
import { Avatar, Badge, EmptyState, ErrorState, Spinner } from '../components/ui'
import { ChangePasswordModal } from '../components/ChangePasswordModal'

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'

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

const TABS = [
  { key: 'posts', label: '我的帖子' },
  { key: 'comments', label: '我的评论' },
  { key: 'favorites', label: '我的收藏' },
  { key: 'following', label: '我的关注' },
  { key: 'followers', label: '我的粉丝' },
] as const

type TabKey = (typeof TABS)[number]['key']

function parseTab(value: string | null): TabKey {
  const found = TABS.find((tab) => tab.key === value)
  return found ? found.key : 'posts'
}

/** 板块名查询走全局缓存（Layout 已查过 ['boards']，这里基本是命中缓存）。 */
function useBoardNames() {
  const { data } = useQuery({ queryKey: ['boards'], queryFn: fetchBoards, staleTime: 5 * 60_000 })
  return (slug: string) => data?.find((board) => board.slug === slug)?.name ?? slug
}

function LoadMoreButton({
  loading,
  onClick,
}: {
  loading: boolean
  onClick: () => void
}) {
  return (
    <div className="flex justify-center pt-1">
      <button type="button" onClick={onClick} disabled={loading} className={SECONDARY_BUTTON}>
        {loading ? '加载中…' : '加载更多'}
      </button>
    </div>
  )
}

/* ------------------------------ 我的帖子 / 收藏 ------------------------------ */

function MyPostsList({ userId }: { userId: string }) {
  const boardName = useBoardNames()
  const query = useInfiniteQuery({
    queryKey: ['my-posts', userId],
    queryFn: ({ pageParam }) => fetchMyPosts(userId, pageParam, 10),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length * 10 : undefined,
  })

  const posts = query.data?.pages.flatMap((page) => page.items) ?? []
  const { votes, votesReady, toggleLike, pendingPostId } = usePostVotes(posts.map((post) => post.id))

  if (query.isPending) return <Spinner />
  // 静默刷新失败时保留已加载的数据，只有首次加载失败才整块换成错误页
  if (query.isError && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />

  if (posts.length === 0) {
    return (
      <EmptyState
        title="还没有发过帖子"
        description="去发第一帖，和同学聊聊吧。"
        action={
          <Link to="/new" className={PRIMARY_BUTTON}>
            去发帖
          </Link>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          boardName={boardName(post.board_slug)}
          myVote={votes[post.id] ?? null}
          onToggleLike={() => toggleLike(post.id)}
          likePending={pendingPostId === post.id || !votesReady}
        />
      ))}
      {query.hasNextPage ? (
        <LoadMoreButton
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        />
      ) : null}
    </div>
  )
}

function MyFavoritesList() {
  const boardName = useBoardNames()
  const query = useInfiniteQuery({
    queryKey: ['my-favorites'],
    queryFn: ({ pageParam }) => fetchMyFavoritePosts(pageParam, 10),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length * 10 : undefined,
  })

  const posts = query.data?.pages.flatMap((page) => page.items) ?? []
  const { votes, votesReady, toggleLike, pendingPostId } = usePostVotes(posts.map((post) => post.id))

  if (query.isPending) return <Spinner />
  // 静默刷新失败时保留已加载的数据，只有首次加载失败才整块换成错误页
  if (query.isError && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />

  if (posts.length === 0) {
    return <EmptyState title="还没有收藏帖子" description="看到有用的帖子，点一下收藏就会出现在这里。" />
  }

  return (
    <div className="space-y-4">
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          boardName={boardName(post.board_slug)}
          myVote={votes[post.id] ?? null}
          onToggleLike={() => toggleLike(post.id)}
          likePending={pendingPostId === post.id || !votesReady}
        />
      ))}
      {query.hasNextPage ? (
        <LoadMoreButton
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------ 我的评论 ------------------------------ */

function MyCommentsList({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: ['my-comments', userId],
    queryFn: () => fetchMyComments(userId),
  })

  if (query.isPending) return <Spinner />
  // 静默刷新失败时保留已加载的数据，只有首次加载失败才整块换成错误页
  if (query.isError && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />

  const comments = query.data ?? []
  if (comments.length === 0) {
    return <EmptyState title="还没有发表过评论" description="去帖子下面说两句，你的评论会出现在这里。" />
  }

  return (
    <div className="space-y-4">
      {comments.map((comment) => (
        <article key={comment.id} className="card px-4 py-3">
          <p className="text-sm leading-[1.7] text-ink-soft">{excerpt(comment.content, 160)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <MessageSquare className="h-3.5 w-3.5 shrink-0" />
            <span>{formatTime(comment.created_at)}</span>
            <span className="text-slate-300">·</span>
            {comment.post ? (
              <Link
                to={`/post/${comment.post_id}`}
                className="max-w-full truncate text-blue-600 hover:text-blue-500"
              >
                {comment.post.title}
              </Link>
            ) : (
              <span>原帖已删除</span>
            )}
          </div>
        </article>
      ))}
    </div>
  )
}

/* ------------------------------ 我的关注 / 粉丝 ------------------------------ */

function FollowList({ kind }: { kind: 'following' | 'followers' }) {
  const query = useInfiniteQuery({
    queryKey: [kind === 'following' ? 'my-following' : 'my-followers'],
    queryFn: ({ pageParam }) =>
      kind === 'following' ? fetchFollowing(20, pageParam) : fetchFollowers(20, pageParam),
    initialPageParam: 0,
    // RPC 上限 100 条/页；返回满 20 条就认为可能还有下一页
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === 20 ? allPages.length * 20 : undefined,
  })

  if (query.isPending) return <Spinner />
  // 静默刷新失败时保留已加载的数据，只有首次加载失败才整块换成错误页
  if (query.isError && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />

  const users = query.data?.pages.flatMap((page) => page) ?? []
  if (users.length === 0) {
    return (
      <EmptyState
        title={kind === 'following' ? '还没有关注任何人' : '还没有粉丝'}
        description={
          kind === 'following'
            ? '在作者主页点「关注」，TA 的新帖会出现在你的通知里。'
            : '多参与讨论，别人可能会关注你。'
        }
      />
    )
  }

  return (
    <div className="space-y-2">
      {users.map((user) => (
        <div
          key={user.user_id}
          className="flex items-start gap-3 card px-4 py-3"
        >
          <Link to={`/u/${user.user_id}`} className="shrink-0">
            <Avatar name={user.display_name} avatar={user.avatar} size="md" />
          </Link>
          <div className="min-w-0 flex-1">
            <Link
              to={`/u/${user.user_id}`}
              className="block truncate text-sm font-medium text-slate-800 hover:text-blue-600"
            >
              {user.display_name}
            </Link>
            {user.bio ? (
              <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-ink-muted">{user.bio}</p>
            ) : null}
            <p className="mt-1 text-[11px] text-ink-muted">
              {kind === 'following' ? '关注于 ' : '关注了你 '}
              {formatTime(user.followed_at)}
            </p>
          </div>
        </div>
      ))}
      {query.hasNextPage ? (
        <LoadMoreButton
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------ 资料卡 ------------------------------ */

function ProfileCard({
  profile,
  isBanned,
  followingCount,
  followerCount,
  onEdit,
  onChangePassword,
}: {
  profile: MyProfile
  isBanned: boolean
  followingCount: number | null
  followerCount: number | null
  onEdit: () => void
  onChangePassword: () => void
}) {
  return (
    <section className="card relative p-4 sm:p-6">
      {/* 移动端：头像与昵称同一行；桌面端：头像更大、按钮靠右 */}
      <div className="flex items-start gap-3 sm:gap-5">
        <span className="sm:hidden">
          <Avatar name={profile.display_name} avatar={profile.avatar} size="lg" />
        </span>
        <span className="hidden sm:inline-flex">
          <Avatar name={profile.display_name} avatar={profile.avatar} size="xl" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="text-lg font-bold tracking-tight text-ink sm:text-[22px]">
              {profile.display_name}
            </h1>
            <Badge tone={ROLE_TONE[profile.role]}>{ROLE_LABEL[profile.role]}</Badge>
            {isBanned ? <Badge tone="red">账号受限</Badge> : null}
          </div>

          <div className="mt-1 flex flex-col gap-0.5 text-xs text-ink-muted sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3">
            {profile.username ? (
              <span className="inline-flex items-center gap-1">
                <AtSign className="h-3.5 w-3.5" />
                {profile.username}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5" />
              加入于 {formatDateTime(profile.created_at)}
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
            <span>
              <span className="text-sm font-semibold text-slate-800">{followingCount ?? '—'}</span>{' '}
              关注
            </span>
            <span>
              <span className="text-sm font-semibold text-slate-800">{followerCount ?? '—'}</span>{' '}
              粉丝
            </span>
          </div>
        </div>
      </div>

      {/* 简介独占一行，读起来更舒服 */}
      <p className="mt-3 rounded-xl bg-slate-50/70 px-3 py-2 text-sm leading-6 text-ink-soft">
        {profile.bio || '这个人很神秘，还没有写简介。'}
      </p>

      {isBanned ? (
        <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">
          账号当前处于受限状态
          {profile.banned_reason ? `：${profile.banned_reason}` : ''}
          ，暂时无法编辑资料或发帖。
          {profile.banned_until ? `（到期时间：${formatDateTime(profile.banned_until)}）` : ''}
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-2 sm:absolute sm:right-6 sm:top-6 sm:mt-0 sm:flex-row">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onEdit}
            disabled={isBanned}
            title={isBanned ? '账号受限期间无法编辑资料' : '编辑资料'}
            className={`${PRIMARY_BUTTON} flex-1 justify-center sm:flex-none`}
          >
            <Pencil className="h-4 w-4" />
            编辑资料
          </button>
          <button
            type="button"
            onClick={onChangePassword}
            title="修改登录密码"
            className={`${SECONDARY_BUTTON} flex-1 justify-center sm:flex-none`}
          >
            <KeyRound className="h-4 w-4" />
            修改密码
          </button>
        </div>
      </div>
    </section>
  )
}

/* ------------------------------ 编辑资料弹窗 ------------------------------ */

function EditProfileModal({
  profile,
  onClose,
}: {
  profile: MyProfile
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const { refreshProfile } = useAuth()
  const [displayName, setDisplayName] = useState(profile.display_name)
  const initialAvatar = parseAvatar(profile.avatar)
  const [avatarEmoji, setAvatarEmoji] = useState(initialAvatar.emoji)
  const [avatarFrom, setAvatarFrom] = useState(initialAvatar.from)
  const [avatarTo, setAvatarTo] = useState(initialAvatar.to)
  const [bio, setBio] = useState(profile.bio)
  const [formError, setFormError] = useState<string | null>(null)
  // 昵称违禁词预检是异步的，期间要禁用保存按钮，否则连点两次会提交两遍
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const mutation = useMutation({
    mutationFn: (patch: { display_name: string; avatar: string; bio: string }) =>
      updateMyProfile(patch),
    onSuccess: async () => {
      toast.success('资料已更新')
      // refreshProfile() 内部会重新拉 my_profile，这里只需要失效其它受影响的缓存，
      // 不必再额外 invalidate ['my-profile']（否则保存一次要请求两遍 my_profile）
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['author', profile.id] }),
        queryClient.invalidateQueries({ queryKey: ['my-posts', profile.id] }),
        queryClient.invalidateQueries({ queryKey: ['posts'] }),
      ])
      await refreshProfile()
      onClose()
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '保存失败，请稍后重试')
    },
  })

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (checking || mutation.isPending) return
    const name = displayName.trim()
    const nextBio = bio.trim()

    if (name.length < 2 || name.length > 20) {
      setFormError('昵称需要 2–20 个字')
      return
    }
    if (nextBio.length > 200) {
      setFormError('简介不能超过 200 字')
      return
    }
    if (name !== profile.display_name) {
      setChecking(true)
      try {
        const hit = await checkBannedWord(name).catch(() => null)
        if (hit) {
          setFormError(`昵称包含违禁词「${hit}」，请换一个`)
          return
        }
      } finally {
        setChecking(false)
      }
    }

    setFormError(null)
    mutation.mutate({
      display_name: name,
      avatar: encodeAvatar({ emoji: avatarEmoji, from: avatarFrom, to: avatarTo }),
      bio: nextBio,
    })
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
        aria-label="编辑资料"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-[20px] bg-white p-6 shadow-float sm:rounded-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">编辑资料</h2>
            <p className="mt-0.5 text-xs text-ink-muted">昵称、头像和简介对所有人可见。</p>
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

        <form onSubmit={submit} className="mt-4 space-y-4">
          <label className="block text-xs font-medium text-slate-600">
            昵称
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={20}
              placeholder="2–20 个字"
              className="mt-1 w-full rounded-xl border border-hairline bg-white px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
            />
          </label>

          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-slate-600">头像</p>
              <span className="text-[11px] text-ink-muted">自选图标 + 自定义背景</span>
            </div>

            {/* 预览 + 自定义颜色 */}
            <div className="mt-2 flex items-center gap-3 rounded-xl bg-slate-50 p-2.5">
              <span
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-3xl leading-none text-white shadow-card"
                style={{ background: `linear-gradient(135deg, ${avatarFrom}, ${avatarTo})` }}
              >
                {avatarEmoji}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-700">预览</p>
                <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">
                  先点图标，再点背景；也可以用取色器自定义两个颜色
                </p>
                <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <span>背景色</span>
                  <input
                    type="color"
                    value={avatarFrom}
                    onChange={(event) => setAvatarFrom(event.target.value)}
                    aria-label="背景起始颜色"
                    className="h-6 w-8 cursor-pointer rounded border border-hairline bg-white p-0.5"
                  />
                  <span className="text-slate-300">→</span>
                  <input
                    type="color"
                    value={avatarTo}
                    onChange={(event) => setAvatarTo(event.target.value)}
                    aria-label="背景结束颜色"
                    className="h-6 w-8 cursor-pointer rounded border border-hairline bg-white p-0.5"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const bg =
                        AVATAR_BACKGROUNDS[Math.floor(Math.random() * AVATAR_BACKGROUNDS.length)]
                      setAvatarFrom(bg.from)
                      setAvatarTo(bg.to)
                    }}
                    className="ml-1 rounded-md border border-hairline bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
                  >
                    随机配色
                  </button>
                </div>
              </div>
            </div>

            {/* 背景预设 */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {AVATAR_BACKGROUNDS.map((bg) => {
                const active = avatarFrom === bg.from && avatarTo === bg.to
                return (
                  <button
                    key={bg.label}
                    type="button"
                    data-avatar-bg={bg.label}
                    onClick={() => {
                      setAvatarFrom(bg.from)
                      setAvatarTo(bg.to)
                    }}
                    aria-pressed={active}
                    aria-label={`背景：${bg.label}`}
                    title={bg.label}
                    style={{ background: `linear-gradient(135deg, ${bg.from}, ${bg.to})` }}
                    className={`h-6 w-6 rounded-full border border-white shadow-card transition ${
                      active ? 'ring-2 ring-blue-500 ring-offset-1' : 'opacity-85 hover:opacity-100'
                    }`}
                  />
                )
              })}
            </div>

            {/* 图标选择 */}
            <div className="mt-3 max-h-52 space-y-2 overflow-y-auto rounded-xl border border-slate-200 p-2">
              {AVATAR_EMOJI_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="text-[11px] font-medium text-ink-muted">{group.label}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {group.emojis.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        data-avatar-emoji={emoji}
                        onClick={() => setAvatarEmoji(emoji)}
                        aria-pressed={avatarEmoji === emoji}
                        aria-label={`图标：${emoji}`}
                        className={`flex h-8 w-8 items-center justify-center rounded-xl text-lg leading-none transition ${
                          avatarEmoji === emoji
                            ? 'bg-blue-50 ring-2 ring-blue-400'
                            : 'hover:bg-slate-100'
                        }`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <label className="block text-xs font-medium text-slate-600">
            简介
            <textarea
              value={bio}
              onChange={(event) => setBio(event.target.value)}
              maxLength={200}
              rows={4}
              placeholder="介绍一下自己吧（不超过 200 字）"
              className="mt-1 w-full resize-none rounded-xl border border-hairline bg-white px-3 py-2 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
            />
          </label>
          <p className="-mt-2 text-right text-[11px] text-ink-muted">{bio.length}/200</p>

          {formError ? <p className="text-xs text-red-600">{formError}</p> : null}

          <div className="flex justify-end gap-2 border-t border-hairline pt-3">
            <button
              type="button"
              onClick={onClose}
              disabled={mutation.isPending}
              className={SECONDARY_BUTTON}
            >
              取消
            </button>
            <button type="submit" disabled={mutation.isPending || checking} className={PRIMARY_BUTTON}>
              <Save className="h-4 w-4" />
              {mutation.isPending ? '保存中…' : checking ? '检查中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/* ------------------------------ 页面 ------------------------------ */

export default function ProfilePage() {
  const { userId, isBanned } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [editing, setEditing] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const tab = parseTab(searchParams.get('tab'))

  const profileQuery = useQuery({ queryKey: ['my-profile'], queryFn: fetchMyProfile })
  // 关注数 / 粉丝数用 author_profile 的准确计数（my_following 默认分页，长度不可靠）
  const statsQuery = useQuery({
    queryKey: ['author', userId ?? ''],
    queryFn: () => fetchAuthorProfile(userId ?? ''),
    enabled: Boolean(userId),
  })

  const profile = profileQuery.data

  const switchTab = (next: TabKey) => {
    if (next === tab) return
    setSearchParams(next === 'posts' ? {} : { tab: next }, { replace: true })
  }

  return (
    <div className="space-y-5">
      {profileQuery.isPending ? <Spinner /> : null}
      {profileQuery.error ? (
        <ErrorState error={profileQuery.error} retry={() => void profileQuery.refetch()} />
      ) : null}

      {profile ? (
        <ProfileCard
          profile={profile}
          isBanned={isBanned}
          followingCount={statsQuery.data?.following_count ?? null}
          followerCount={statsQuery.data?.follower_count ?? null}
          onEdit={() => setEditing(true)}
          onChangePassword={() => setChangingPassword(true)}
        />
      ) : null}

      <div className="card p-1">
        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => switchTab(item.key)}
              className={`flex-1 whitespace-nowrap rounded-xl px-2 py-2 text-xs transition sm:px-3 sm:text-sm ${
                tab === item.key
                  ? 'bg-blue-50 font-medium text-blue-600'
                  : 'text-ink-muted hover:bg-slate-50 hover:text-slate-700'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'posts' ? (
        userId ? (
          <MyPostsList userId={userId} />
        ) : (
          <Spinner label="正在读取登录状态…" />
        )
      ) : null}
      {tab === 'comments' ? (
        userId ? (
          <MyCommentsList userId={userId} />
        ) : (
          <Spinner label="正在读取登录状态…" />
        )
      ) : null}
      {tab === 'favorites' ? <MyFavoritesList /> : null}
      {tab === 'following' ? <FollowList kind="following" /> : null}
      {tab === 'followers' ? <FollowList kind="followers" /> : null}

      {editing && profile ? (
        <EditProfileModal profile={profile} onClose={() => setEditing(false)} />
      ) : null}

      {changingPassword ? (
        <ChangePasswordModal onClose={() => setChangingPassword(false)} />
      ) : null}
    </div>
  )
}
