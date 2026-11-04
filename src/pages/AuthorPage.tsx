import { Link, useParams } from 'react-router-dom'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import { CalendarDays, FileText, MessageSquare, ShieldOff, UserCheck, UserMinus, UserPlus } from 'lucide-react'
import {
  fetchAuthorProfile,
  fetchBoards,
  fetchPostsByAuthor,
  fetchUserRelation,
  sendFriendRequest,
  toggleFollow,
} from '../lib/api'
import { formatDateTime } from '../lib/format'
import { usePostVotes } from '../lib/usePostVotes'
import type { AuthorProfile, Profile } from '../types/db'
import { PostCard } from '../components/PostCard'
import { Avatar, EmptyState, ErrorState, Spinner } from '../components/ui'

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60'

function useBoardNames() {
  const { data } = useQuery({ queryKey: ['boards'], queryFn: fetchBoards, staleTime: 5 * 60_000 })
  return (slug: string) => data?.find((board) => board.slug === slug)?.name ?? slug
}

/* ------------------------------ 资料头 ------------------------------ */

function AuthorHeader({ author }: { author: AuthorProfile }) {
  const queryClient = useQueryClient()

  const relationQuery = useQuery({
    queryKey: ['user-relation', author.user_id],
    queryFn: () => fetchUserRelation(author.user_id),
    enabled: !author.is_me,
  })
  const relation = relationQuery.data ?? 'none'

  const addFriend = useMutation({
    mutationFn: () => sendFriendRequest(author.user_id, ''),
    onSuccess: () => {
      toast.success('好友申请已发出')
      void queryClient.invalidateQueries({ queryKey: ['user-relation', author.user_id] })
      void queryClient.invalidateQueries({ queryKey: ['friend-requests'] })
      void queryClient.invalidateQueries({ queryKey: ['social-badges'] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试'),
  })

  const follow = useMutation({
    mutationFn: () => toggleFollow(author.user_id),
    onSuccess: async (result) => {
      toast.success(result.following ? '已关注该同学' : '已取消关注')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['author', author.user_id] }),
        queryClient.invalidateQueries({ queryKey: ['my-following'] }),
      ])
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '操作失败，请稍后重试')
    },
  })

  return (
    <section className="card p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Avatar name={author.display_name} avatar={author.avatar} size="xl" />

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[22px] font-bold tracking-tight text-ink">{author.display_name}</h1>
          <p className="mt-1 inline-flex items-center gap-1 text-xs text-ink-muted">
            <CalendarDays className="h-3.5 w-3.5" />
            加入于 {formatDateTime(author.created_at)}
          </p>
          <p className="mt-2 text-sm leading-[1.7] text-ink-soft">
            {author.bio || '这个人很神秘，还没有写简介。'}
          </p>

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-ink-muted">
            <span>
              <span className="text-sm font-semibold text-slate-800">{author.post_count}</span> 帖子
            </span>
            <span>
              <span className="text-sm font-semibold text-slate-800">{author.follower_count}</span>{' '}
              粉丝
            </span>
            <span>
              <span className="text-sm font-semibold text-slate-800">{author.following_count}</span>{' '}
              关注
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {author.is_me ? (
            <Link to="/me" className={SECONDARY_BUTTON}>
              编辑资料
            </Link>
          ) : (
            <>
              {relation === 'friend' ? (
                <Link to={`/messages/${author.user_id}`} className={SECONDARY_BUTTON}>
                  <MessageSquare className="h-4 w-4" />
                  发私信
                </Link>
              ) : relation === 'blocked' || relation === 'blockedBy' ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-slate-50/70 px-3 py-1.5 text-sm text-ink-muted"
                  title="当前无法添加对方为好友"
                >
                  <ShieldOff className="h-4 w-4" />
                  无法添加
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => addFriend.mutate()}
                  disabled={addFriend.isPending || relation === 'half'}
                  title={relation === 'half' ? '对方已把你删除，需等对方重新添加' : '加好友'}
                  className={SECONDARY_BUTTON}
                >
                  {addFriend.isPending ? (
                    <UserCheck className="h-4 w-4" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                  {addFriend.isPending ? '发送中…' : '加好友'}
                </button>
              )}
            </>
          )}
          {author.is_me ? null : (
            <button
              type="button"
              onClick={() => follow.mutate()}
              disabled={follow.isPending}
              className={author.is_following ? SECONDARY_BUTTON : PRIMARY_BUTTON}
            >
              {author.is_following ? (
                <>
                  <UserMinus className="h-4 w-4" />
                  {follow.isPending ? '处理中…' : '已关注'}
                </>
              ) : (
                <>
                  <UserPlus className="h-4 w-4" />
                  {follow.isPending ? '处理中…' : '关注'}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

/* ------------------------------ TA 的帖子 ------------------------------ */

function AuthorPosts({ userId, author }: { userId: string; author: AuthorProfile }) {
  const boardName = useBoardNames()
  const query = useInfiniteQuery({
    queryKey: ['author-posts', userId],
    queryFn: ({ pageParam }) => fetchPostsByAuthor(userId, pageParam, 10),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.length * 10 : undefined,
  })

  const authorProfile: Profile = {
    id: author.user_id,
    display_name: author.display_name,
    avatar: author.avatar,
    bio: author.bio,
    created_at: author.created_at,
  }

  const posts = query.data?.pages.flatMap((page) => page.items) ?? []
  const { votes, votesReady, toggleLike, pendingPostId } = usePostVotes(posts.map((post) => post.id))

  if (query.isPending) return <Spinner />
  // 静默刷新失败时保留已加载的列表，只有首次加载失败才显示错误页
  if (query.isError && !query.data)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />

  if (posts.length === 0) {
    return <EmptyState title="TA 还没有发过帖子" description="等 TA 的第一帖吧。" />
  }

  return (
    <div className="space-y-4">
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={{ ...post, author: authorProfile }}
          boardName={boardName(post.board_slug)}
          myVote={votes[post.id] ?? null}
          onToggleLike={() => toggleLike(post.id)}
          likePending={pendingPostId === post.id || !votesReady}
        />
      ))}
      {query.hasNextPage ? (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className={SECONDARY_BUTTON}
          >
            {query.isFetchingNextPage ? '加载中…' : '加载更多'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------ 页面 ------------------------------ */

export default function AuthorPage() {
  const params = useParams<{ userId: string }>()
  const userId = params.userId ?? ''

  const authorQuery = useQuery({
    queryKey: ['author', userId],
    queryFn: () => fetchAuthorProfile(userId),
    enabled: Boolean(userId),
  })

  if (!userId) {
    return (
      <EmptyState
        title="用户不存在"
        description="链接可能不完整，请从帖子里的作者昵称进入。"
        action={
          <Link to="/" className={SECONDARY_BUTTON}>
            返回首页
          </Link>
        }
      />
    )
  }

  if (authorQuery.isPending) return <Spinner label="正在读取作者资料…" />
  if (authorQuery.error) {
    return <ErrorState error={authorQuery.error} retry={() => void authorQuery.refetch()} />
  }

  const author = authorQuery.data
  if (!author) {
    return (
      <EmptyState
        title="用户不存在"
        description="这个账号可能已经注销。"
        action={
          <Link to="/" className={SECONDARY_BUTTON}>
            返回首页
          </Link>
        }
      />
    )
  }

  return (
    <div className="space-y-5">
      <AuthorHeader author={author} />

      <div className="flex items-center gap-2 px-1">
        <FileText className="h-4 w-4 text-ink-muted" />
        <h2 className="text-sm font-semibold text-slate-700">TA 的帖子</h2>
        <span className="text-xs text-ink-muted">（{author.post_count}）</span>
      </div>

      <AuthorPosts userId={userId} author={author} />
    </div>
  )
}
