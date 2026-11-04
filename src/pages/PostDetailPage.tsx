import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Bookmark,
  Flag,
  Link2,
  Lock,
  MessageSquare,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '../lib/auth'
import { useCommentLikes } from '../lib/useCommentLikes'
import {
  checkBannedWord,
  createComment,
  createReport,
  fetchBoards,
  fetchComments,
  fetchIsFavorite,
  fetchMyVote,
  fetchPost,
  softDeleteComment,
  softDeletePost,
  toggleFavorite,
  votePost,
} from '../lib/api'
import { getBoardMeta, REPORT_REASONS } from '../lib/constants'
import { formatDateTime, formatTime } from '../lib/format'
import type { Comment, Post, ReportTarget } from '../types/db'
import { Avatar, Badge, EmptyState, ErrorState, Spinner } from '../components/ui'
import { safeImageList } from '../lib/image'

function errMessage(err: unknown, fallback = '操作失败，请稍后重试'): string {
  return err instanceof Error ? err.message : fallback
}

export default function PostDetailPage() {
  const { id } = useParams<{ id: string }>()
  const postId = id ?? ''
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { userId, isAdmin, isBanned } = useAuth()

  const [commentText, setCommentText] = useState('')
  const [replyToId, setReplyToId] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [checking, setChecking] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState<string>(REPORT_REASONS[0])
  const [reportDetail, setReportDetail] = useState('')
  const [reportTarget, setReportTarget] = useState<{ type: ReportTarget; id: string } | null>(null)
  const [searchParams] = useSearchParams()
  const focusCommentId = searchParams.get('comment')

  const postQuery = useQuery({
    queryKey: ['post', postId],
    queryFn: () => fetchPost(postId),
    enabled: Boolean(postId),
  })
  const commentsQuery = useQuery({
    queryKey: ['comments', postId],
    queryFn: () => fetchComments(postId),
    enabled: Boolean(postId),
  })
  const voteQuery = useQuery({
    queryKey: ['my-vote', postId, userId],
    queryFn: () => fetchMyVote(postId, userId ?? ''),
    enabled: Boolean(userId && postId),
  })
  const favoriteQuery = useQuery({
    queryKey: ['is-favorite', postId, userId],
    queryFn: () => fetchIsFavorite(postId, userId ?? ''),
    enabled: Boolean(userId && postId),
  })
  const boardsQuery = useQuery({
    queryKey: ['boards'],
    queryFn: fetchBoards,
    staleTime: 5 * 60_000,
  })

  const post = postQuery.data ?? null
  // 图片地址统一过一遍协议白名单（历史脏数据也不会被渲染成可点击链接）
  const safeImages = safeImageList(post?.images)
  const comments = commentsQuery.data ?? []
  const myVote = voteQuery.data ?? null
  const isFavorited = favoriteQuery.data ?? false
  const boardName = (boardsQuery.data ?? []).find((b) => b.slug === post?.board_slug)?.name
  const canModerate = Boolean(post && (isAdmin || post.author_id === userId))
  // renderCommentRow 在 post 的空值检查之前定义，这里提前取一个安全布尔值
  const postLocked = Boolean(post?.is_locked)

  // 评论点赞：批量查「我赞过哪些」，点击时调 RPC
  const {
    likes: commentLikes,
    likesReady: commentLikesReady,
    toggleLike: toggleCommentLike,
    pendingCommentId: pendingCommentLikeId,
  } = useCommentLikes(postId, comments.map((comment) => comment.id))

  // 从管理后台「查看被举报评论」跳进来时：滚动到该评论（样式上会一直高亮，方便定位）
  useEffect(() => {
    if (!focusCommentId || commentsQuery.isPending) return
    const target = comments.find((comment) => comment.id === focusCommentId)
    const element = document.getElementById(`comment-${focusCommentId}`)
    if (!target || !element) {
      const timer = setTimeout(() => {
        toast.info('被举报的评论可能已被删除或不可见')
      }, 600)
      return () => clearTimeout(timer)
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return undefined
  }, [focusCommentId, comments, commentsQuery.isPending])

  const voteMutation = useMutation({
    mutationFn: (value: number) => votePost(postId, value),
    onSuccess: (result) => {
      queryClient.setQueryData<Post | null>(['post', postId], (old) =>
        old ? { ...old, like_count: result.like_count, dislike_count: result.dislike_count } : old,
      )
      queryClient.setQueryData(['my-vote', postId, userId], result.my_vote)
      // 列表页的投票状态是另一套缓存（['my-votes', userId, ids]），一并失效，
      // 避免「详情页点赞 → 返回列表 → 再点一次」被当成取消赞。
      void queryClient.invalidateQueries({ queryKey: ['my-votes'] })
      void queryClient.invalidateQueries({ queryKey: ['posts'] })
    },
    onError: (err) => toast.error(errMessage(err)),
  })

  const favoriteMutation = useMutation({
    mutationFn: () => toggleFavorite(postId),
    onSuccess: (result) => {
      queryClient.setQueryData<Post | null>(['post', postId], (old) =>
        old ? { ...old, favorite_count: result.favorite_count } : old,
      )
      queryClient.setQueryData(['is-favorite', postId, userId], result.favorited)
      void queryClient.invalidateQueries({ queryKey: ['my-favorites'] })
      toast.success(result.favorited ? '已收藏' : '已取消收藏')
    },
    onError: (err) => toast.error(errMessage(err)),
  })

  const commentMutation = useMutation({
    mutationFn: (payload: { content: string; parentId?: string | null }) =>
      createComment(postId, payload.content, payload.parentId ?? null),
    onSuccess: (created) => {
      setCommentText('')
      setReplyText('')
      setReplyToId(null)
      toast.success(created.parent_id ? '回复成功' : '评论成功')
      void queryClient.invalidateQueries({ queryKey: ['comments', postId] })
      void queryClient.invalidateQueries({ queryKey: ['post', postId] })
      void queryClient.invalidateQueries({ queryKey: ['posts'] })
    },
    onError: (err) => toast.error(errMessage(err)),
  })

  const deleteCommentMutation = useMutation({
    mutationFn: (commentId: string) => softDeleteComment(commentId),
    onSuccess: () => {
      toast.success('评论已删除')
      void queryClient.invalidateQueries({ queryKey: ['comments', postId] })
      void queryClient.invalidateQueries({ queryKey: ['post', postId] })
      void queryClient.invalidateQueries({ queryKey: ['posts'] })
    },
    onError: (err) => toast.error(errMessage(err)),
  })

  const deletePostMutation = useMutation({
    mutationFn: () => softDeletePost(postId),
    onSuccess: () => {
      toast.success('帖子已删除')
      queryClient.removeQueries({ queryKey: ['post', postId] })
      void queryClient.invalidateQueries({ queryKey: ['posts'] })
      void queryClient.invalidateQueries({ queryKey: ['my-posts'] })
      void queryClient.invalidateQueries({ queryKey: ['author-posts'] })
      void queryClient.invalidateQueries({ queryKey: ['my-favorites'] })
      navigate('/', { replace: true })
    },
    onError: (err) => toast.error(errMessage(err)),
  })

  const reportMutation = useMutation({
    mutationFn: () =>
      createReport({
        target_type: reportTarget?.type ?? 'post',
        target_id: reportTarget?.id ?? postId,
        reason: reportReason,
        detail: reportDetail.trim(),
      }),
    onSuccess: () => {
      setReportOpen(false)
      setReportDetail('')
      setReportTarget(null)
      toast.success('举报已提交，管理员会尽快处理')
    },
    onError: (err) => toast.error(errMessage(err)),
  })

  const submitComment = async (event: FormEvent) => {
    event.preventDefault()
    if (checking || commentMutation.isPending) return
    const text = commentText.trim()
    if (!text) return
    setChecking(true)
    try {
      // 违禁词预检：命中就直接提示，不必等服务器拒绝
      const hit = await checkBannedWord(text).catch(() => null)
      if (hit) {
        toast.error(`评论内容包含违禁词「${hit}」，请修改后再提交`)
        return
      }
      commentMutation.mutate({ content: text })
    } finally {
      setChecking(false)
    }
  }

  const submitReply = async (comment: Comment) => {
    if (checking || commentMutation.isPending) return
    const text = replyText.trim()
    if (!text) return
    setChecking(true)
    try {
      const hit = await checkBannedWord(text).catch(() => null)
      if (hit) {
        toast.error(`评论内容包含违禁词「${hit}」，请修改后再提交`)
        return
      }
      commentMutation.mutate({ content: text, parentId: comment.id })
    } finally {
      setChecking(false)
    }
  }

  const handleVote = (value: 1 | -1) => {
    if (!userId) {
      toast.info('登录后才能点赞或点踩')
      navigate('/login', { state: { from: `/post/${postId}` } })
      return
    }
    // 投票状态还没加载完就点，会把「已点赞」误判成「未点赞」而取消掉，等加载完再允许
    if (voteQuery.isPending) return
    const next = myVote === value ? 0 : value
    voteMutation.mutate(next)
  }

  const handleFavorite = () => {
    if (!userId) {
      toast.info('登录后才能收藏')
      navigate('/login', { state: { from: `/post/${postId}` } })
      return
    }
    favoriteMutation.mutate()
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      toast.success('链接已复制')
    } catch {
      toast.error('复制失败，请手动复制地址栏链接')
    }
  }

  const openReport = (type: ReportTarget, targetId: string) => {
    if (!userId) {
      toast.info('登录后才能举报')
      navigate('/login', { state: { from: `/post/${postId}` } })
      return
    }
    setReportTarget({ type, id: targetId })
    setReportOpen(true)
  }

  /* ---------- 评论树：顶层评论 + 一层回复（回复的回复按根评论归并） ---------- */
  const postAuthorId = post?.author_id ?? ''
  const commentById = new Map(comments.map((comment) => [comment.id, comment]))

  const rootOfComment = (comment: Comment): Comment => {
    let current = comment
    // 用 visited 防环，而不是固定 10 层：层数超过 10 的回复否则会被挂到中间节点上永远不显示
    const visited = new Set<string>([current.id])
    while (current.parent_id) {
      const parent = commentById.get(current.parent_id)
      if (!parent || visited.has(parent.id)) break
      visited.add(parent.id)
      current = parent
    }
    return current
  }

  const topComments = comments.filter(
    (comment) => !comment.parent_id || !commentById.has(comment.parent_id),
  )
  const repliesByRoot = new Map<string, Comment[]>()
  for (const comment of comments) {
    if (!comment.parent_id || !commentById.has(comment.parent_id)) continue
    const root = rootOfComment(comment)
    const list = repliesByRoot.get(root.id)
    if (list) list.push(comment)
    else repliesByRoot.set(root.id, [comment])
  }

  const renderCommentRow = (comment: Comment, isReply: boolean) => {
    const parent = comment.parent_id ? commentById.get(comment.parent_id) : undefined
    const replyToName = isReply ? parent?.author?.display_name : undefined
    const isReplying = replyToId === comment.id

    return (
      <div
        key={comment.id}
        id={`comment-${comment.id}`}
        className={`scroll-mt-24 rounded-control px-3 py-3 transition ${
          isReply ? 'mt-2 border-l-2 border-hairline-strong pl-3' : ''
        } ${
          focusCommentId === comment.id
            ? 'bg-amber-50/80 ring-1 ring-amber-200'
            : 'hover:bg-slate-50/70'
        }`}
      >
        <div className="flex gap-3">
          <Link to={`/u/${comment.author_id}`}>
            <Avatar
              name={comment.author?.display_name ?? '匿名'}
              avatar={comment.author?.avatar}
              size={isReply ? 'xs' : 'sm'}
            />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={`/u/${comment.author_id}`}
                className="text-xs font-medium text-ink transition-colors hover:text-blue-600"
              >
                {comment.author?.display_name ?? '已注销用户'}
              </Link>
              <time className="text-[11px] text-ink-muted">{formatTime(comment.created_at)}</time>
              {comment.author_id === postAuthorId ? <Badge tone="blue">楼主</Badge> : null}
              {replyToName ? (
                <span className="text-[11px] text-ink-muted">回复 @{replyToName}</span>
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  data-testid="comment-like"
                  aria-label={`给 ${comment.author?.display_name ?? '这条'} 的评论点赞`}
                  aria-pressed={Boolean(commentLikes[comment.id])}
                  onClick={() => toggleCommentLike(comment.id)}
                  disabled={!commentLikesReady || pendingCommentLikeId === comment.id}
                  className={`inline-flex items-center gap-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    commentLikes[comment.id] ? 'text-blue-600' : 'text-ink-muted hover:text-blue-500'
                  }`}
                >
                  <ThumbsUp className={`h-3.5 w-3.5 ${commentLikes[comment.id] ? 'fill-blue-100' : ''}`} />
                  {comment.like_count > 0 ? comment.like_count : '赞'}
                </button>
                {postLocked || isBanned ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      if (isReplying) {
                        setReplyToId(null)
                        setReplyText('')
                      } else {
                        setReplyToId(comment.id)
                        setReplyText('')
                      }
                    }}
                    className="text-[11px] text-ink-muted hover:text-blue-500"
                  >
                    回复
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openReport('comment', comment.id)}
                  className="text-[11px] text-ink-muted hover:text-red-500"
                >
                  举报
                </button>
                {comment.author_id === userId || isAdmin ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm('删除这条评论？')) {
                        deleteCommentMutation.mutate(comment.id)
                      }
                    }}
                    className="text-[11px] text-ink-muted hover:text-red-500"
                  >
                    删除
                  </button>
                ) : null}
              </div>
            </div>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-[1.7] text-ink-soft">
              {comment.content}
            </p>

            {isReplying ? (
              <div className="mt-2 rounded-xl border border-hairline bg-slate-50/70 p-2.5">
                <textarea
                  value={replyText}
                  onChange={(event) => setReplyText(event.target.value)}
                  rows={2}
                  maxLength={1000}
                  autoFocus
                  placeholder={`回复 @${comment.author?.display_name ?? '该用户'}…`}
                  className="w-full resize-y rounded-xl border border-hairline bg-white px-2.5 py-2 text-sm leading-6 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                />
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-ink-muted">{replyText.length}/1000</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setReplyToId(null)
                        setReplyText('')
                      }}
                      className="rounded-xl border border-hairline bg-white px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => void submitReply(comment)}
                      disabled={commentMutation.isPending || checking || !replyText.trim()}
                      className="rounded-xl bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {commentMutation.isPending ? '发送中…' : '发送回复'}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  if (!postId) {
    return <EmptyState title="帖子不存在" description="链接可能已经失效。" />
  }

  if (postQuery.isPending) {
    return (
      <div className="space-y-5">
        <Spinner label="正在加载帖子…" />
      </div>
    )
  }

  if (postQuery.isError) {
    return <ErrorState error={postQuery.error} retry={() => void postQuery.refetch()} />
  }

  if (!post) {
    return (
      <div className="space-y-5">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-slate-700">
          <ArrowLeft className="h-4 w-4" />
          返回首页
        </Link>
        <EmptyState title="帖子不存在或已被删除" description="可能被作者或管理员删除，也可能链接有误。" />
      </div>
    )
  }

  const meta = getBoardMeta(post.board_slug)
  const locked = post.is_locked

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-slate-700">
        <ArrowLeft className="h-4 w-4" />
        返回首页
      </Link>

      {/* 帖子主体 */}
      <article className="card p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${meta.chip}`}>
            <meta.icon className="h-3.5 w-3.5" />
            {boardName ?? post.board_slug}
          </span>
          {post.is_pinned ? <Badge tone="red">置顶</Badge> : null}
          {locked ? (
            <Badge tone="amber">
              <Lock className="h-3 w-3" />
              已锁帖
            </Badge>
          ) : null}
        </div>

        <h1 className="mt-3 text-xl font-bold leading-snug text-slate-900 sm:text-2xl">{post.title}</h1>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Link
            to={`/u/${post.author_id}`}
            className="flex items-center gap-2 text-sm text-ink-muted hover:text-slate-700"
          >
            <Avatar name={post.author?.display_name ?? '匿名'} avatar={post.author?.avatar} size="sm" />
            <span className="font-medium text-slate-700">{post.author?.display_name ?? '已注销用户'}</span>
            <span className="text-slate-300">·</span>
            <time>{formatDateTime(post.created_at)}</time>
          </Link>
          <span className="text-xs text-ink-muted">浏览时请遵守社区规则</span>
        </div>

        <div className="mt-5 border-t border-hairline pt-5">
          <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.85] text-ink-soft">
            {post.content}
          </p>
          {safeImages.length > 0 ? (
            <div
              className={`mt-4 grid gap-2 ${
                safeImages.length === 1 ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-3'
              }`}
            >
              {safeImages.map((src) => (
                <a
                  key={src}
                  href={src}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="group block overflow-hidden rounded-xl border border-hairline bg-slate-50"
                  title="点击查看原图"
                >
                  <img
                    src={src}
                    alt="帖子图片"
                    loading="lazy"
                    className={`w-full object-cover transition duration-200 group-hover:scale-[1.02] ${
                      safeImages.length === 1 ? 'max-h-[520px] object-contain' : 'h-32 sm:h-36'
                    }`}
                  />
                </a>
              ))}
            </div>
          ) : null}
        </div>

        {/* 操作栏 */}
        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          <button
            type="button"
            onClick={() => handleVote(1)}
            disabled={voteMutation.isPending || voteQuery.isPending}
            title={voteQuery.isPending ? '正在读取你的投票状态…' : undefined}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
              myVote === 1
                ? 'border-blue-200 bg-blue-50 text-blue-600'
                : 'border-hairline bg-white text-ink-soft hover:bg-slate-50 hover:text-blue-600'
            }`}
          >
            <ThumbsUp className="h-4 w-4" />
            赞 {post.like_count > 0 ? post.like_count : ''}
          </button>
          <button
            type="button"
            onClick={() => handleVote(-1)}
            disabled={voteMutation.isPending || voteQuery.isPending}
            title={voteQuery.isPending ? '正在读取你的投票状态…' : undefined}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
              myVote === -1
                ? 'border-red-200 bg-red-50 text-red-500'
                : 'border-hairline bg-white text-ink-soft hover:bg-slate-50 hover:text-blue-600'
            }`}
          >
            <ThumbsDown className="h-4 w-4" />
            踩 {post.dislike_count > 0 ? post.dislike_count : ''}
          </button>
          <button
            type="button"
            onClick={handleFavorite}
            disabled={favoriteMutation.isPending}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
              isFavorited
                ? 'border-amber-200 bg-amber-50 text-amber-600'
                : 'border-hairline bg-white text-ink-soft hover:bg-slate-50 hover:text-blue-600'
            }`}
          >
            <Bookmark className={`h-4 w-4 ${isFavorited ? 'fill-amber-400' : ''}`} />
            {isFavorited ? '已收藏' : '收藏'}
          </button>
          <button
            type="button"
            onClick={() => void copyLink()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft hover:bg-slate-50"
          >
            <Link2 className="h-4 w-4" />
            复制链接
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => openReport('post', post.id)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-muted hover:bg-slate-50"
            >
              <Flag className="h-4 w-4" />
              举报
            </button>
            {canModerate ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('确定删除这条帖子吗？删除后不可恢复。')) {
                    deletePostMutation.mutate()
                  }
                }}
                disabled={deletePostMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                删除
              </button>
            ) : null}
          </div>
        </div>
      </article>

      {/* 评论区 */}
      <section className="card p-5 sm:p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <MessageSquare className="h-4 w-4 text-ink-muted" />
          评论
          <span className="text-sm font-normal text-ink-muted">{post.comment_count}</span>
        </h2>

        {locked ? (
          <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700">
            该帖子已被锁定，暂时不能评论。
          </p>
        ) : userId ? (
          isBanned ? (
            <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">
              当前账号被限制发言，暂时不能评论。
            </p>
          ) : (
            <form onSubmit={submitComment} className="mt-4">
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="友善发言，说说你的看法…"
                className="w-full resize-y rounded-xl border border-hairline bg-slate-50/70 px-3.5 py-2.5 text-sm leading-6 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-ink-muted">{commentText.length}/1000</span>
                <button
                  type="submit"
                  disabled={commentMutation.isPending || checking || !commentText.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Send className="h-3.5 w-3.5" />
                  {commentMutation.isPending ? '发送中…' : '发表评论'}
                </button>
              </div>
            </form>
          )
        ) : (
          <p className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-xs text-ink-muted">
            <Link to="/login" className="font-medium text-blue-600 hover:underline">
              登录
            </Link>
            后可以参与评论。
          </p>
        )}

        <div className="mt-5 space-y-4 border-t border-hairline pt-4">
          {commentsQuery.isPending ? (
            <Spinner label="正在加载评论…" />
          ) : commentsQuery.isError ? (
            <ErrorState error={commentsQuery.error} retry={() => void commentsQuery.refetch()} />
          ) : comments.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-muted">还没有评论，来抢沙发吧。</p>
          ) : (
            topComments.map((root) => (
              <div key={root.id}>
                {renderCommentRow(root, false)}
                {(repliesByRoot.get(root.id) ?? []).map((reply) => renderCommentRow(reply, true))}
              </div>
            ))
          )}
        </div>
      </section>

      {/* 举报弹窗 */}
      {reportOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4">
          <div className="w-full max-w-md rounded-t-[20px] bg-white p-6 shadow-float sm:rounded-card">
            <h3 className="text-base font-semibold text-slate-900">
              举报{reportTarget?.type === 'comment' ? '评论' : '帖子'}
            </h3>
            <p className="mt-1 text-xs text-ink-muted">请选择原因，管理员会核实处理。</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {REPORT_REASONS.map((reason) => (
                <button
                  key={reason}
                  type="button"
                  onClick={() => setReportReason(reason)}
                  className={`rounded-xl border px-2.5 py-1.5 text-xs transition ${
                    reportReason === reason
                      ? 'border-red-200 bg-red-50 font-medium text-red-600'
                      : 'border-hairline bg-white text-ink-soft hover:bg-slate-50 hover:text-blue-600'
                  }`}
                >
                  {reason}
                </button>
              ))}
            </div>
            <textarea
              value={reportDetail}
              onChange={(e) => setReportDetail(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="补充说明（选填，最多 500 字）"
              className="mt-3 w-full resize-none rounded-xl border border-hairline bg-slate-50/70 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setReportOpen(false)
                  setReportTarget(null)
                }}
                className="rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => reportMutation.mutate()}
                disabled={reportMutation.isPending}
                className="rounded-xl bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-60"
              >
                {reportMutation.isPending ? '提交中…' : '提交举报'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
