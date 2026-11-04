import { Lock, MessageSquare, Pin, ThumbsUp } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Post } from '../types/db'
import { excerpt, formatCount, formatTime } from '../lib/format'
import { getBoardMeta } from '../lib/constants'
import { Avatar, Badge } from './ui'
import { safeImageUrl } from '../lib/image'

export function PostCard({
  post,
  boardName,
  highlight,
  compact = false,
  myVote = null,
  onToggleLike,
  likePending = false,
  dense = false,
}: {
  post: Post
  boardName?: string
  highlight?: string
  compact?: boolean
  /** 当前用户对这帖的投票：1 赞 / -1 踩 / null 未投 */
  myVote?: number | null
  /** 传了才显示可点击的点赞按钮（列表页用） */
  onToggleLike?: () => void
  likePending?: boolean
  /** 多列卡片网格里用更紧凑的排版 */
  dense?: boolean
}) {
  const meta = getBoardMeta(post.board_slug)
  const cover = safeImageUrl(post.images?.[0])

  return (
    <article
      className={`card group relative flex min-w-0 flex-col overflow-hidden transition duration-200 hover:-translate-y-0.5 hover:border-hairline-strong hover:shadow-lift ${
        dense ? 'px-3.5 py-3.5 sm:px-4 sm:py-4' : compact ? 'px-5 py-4' : 'px-5 py-5 sm:px-6 sm:py-5'
      }`}
    >
      {/* 顶部：板块胶囊 + 状态 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`pill ${meta.chip} ${dense ? 'px-2 py-0.5 !text-[10px]' : ''}`}>
          <meta.icon className="h-3 w-3" />
          {boardName ?? post.board_slug}
        </span>
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
      </div>

      {/* 标题 */}
      <h2
        className={`font-semibold tracking-tight text-ink ${
          dense
            ? 'mt-2 text-[13.5px] leading-5 sm:text-sm sm:leading-6'
            : compact
              ? 'mt-2.5 text-[15px] leading-6'
              : 'mt-2.5 text-[17px] leading-7'
        }`}
      >
        <Link
          to={`/post/${post.id}`}
          className="line-clamp-2 transition-colors group-hover:text-blue-600"
        >
          {post.title}
        </Link>
      </h2>

      {cover ? (
        <div className="mt-2 overflow-hidden rounded-xl border border-hairline bg-slate-50">
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="h-24 w-full object-cover sm:h-28"
          />
        </div>
      ) : null}

      {/* 摘要 */}
      {!compact ? (
        <p
          className={`mt-1.5 line-clamp-2 text-ink-soft ${
            dense ? 'text-[11.5px] leading-5 sm:text-xs sm:leading-5' : 'text-sm leading-[1.7]'
          }`}
        >
          {excerpt(post.content, dense ? 80 : 160)}
        </p>
      ) : null}

      {/* 底部：作者/时间 + 互动 */}
      <div
        className={`flex items-center justify-between gap-2 ${
          dense ? 'mt-auto flex-nowrap pt-3' : 'mt-4 flex-wrap'
        }`}
      >
        <Link
          to={`/u/${post.author_id}`}
          className={`flex min-w-0 items-center text-ink-muted transition-colors hover:text-blue-600 ${
            dense ? 'gap-1.5' : 'gap-2 text-xs'
          }`}
        >
          <Avatar
            name={post.author?.display_name ?? '匿名'}
            avatar={post.author?.avatar}
            size="xs"
          />
          <span className={`truncate font-medium text-ink-soft ${dense ? 'hidden sm:inline' : ''}`}>
            {post.author?.display_name ?? '已注销用户'}
          </span>
          <span className={`text-slate-300 ${dense ? 'hidden sm:inline' : ''}`}>·</span>
          <time className={`shrink-0 ${dense ? 'text-[10px] sm:text-[11px]' : ''}`}>
            {formatTime(post.created_at)}
          </time>
        </Link>

        <div
          className={`flex shrink-0 items-center gap-0.5 text-ink-muted ${
            dense ? 'text-[10px] sm:text-[11px]' : 'text-xs'
          }`}
        >
          {onToggleLike ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onToggleLike()
              }}
              disabled={likePending}
              aria-label={myVote === 1 ? '取消点赞' : '点赞'}
              title={myVote === 1 ? '取消点赞' : '点赞'}
              className={`inline-flex items-center gap-1 rounded-full transition disabled:opacity-50 ${dense ? 'px-1.5 py-1' : 'px-2.5 py-1.5'} ${
                myVote === 1
                  ? 'bg-blue-50 font-medium text-blue-600'
                  : 'hover:bg-slate-50 hover:text-blue-600'
              }`}
            >
              <ThumbsUp className={`h-3.5 w-3.5 ${myVote === 1 ? 'fill-blue-400' : ''}`} />
              {formatCount(post.like_count)}
            </button>
          ) : (
            <span
              className={`inline-flex items-center gap-1 px-1 ${
                post.like_count > 0 ? 'text-blue-500' : ''
              }`}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
              {formatCount(post.like_count)}
            </span>
          )}
          <Link
            to={`/post/${post.id}`}
            className={`inline-flex items-center gap-1 rounded-full transition hover:bg-slate-50 hover:text-blue-600 ${dense ? 'px-1.5 py-1' : 'px-2.5 py-1.5'}`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {formatCount(post.comment_count)}
          </Link>
        </div>
      </div>

      {highlight ? (
        <div className="mt-3 rounded-control bg-amber-50/70 px-3 py-1.5 text-[11px] text-amber-700">
          命中「{highlight}」
        </div>
      ) : null}
    </article>
  )
}
