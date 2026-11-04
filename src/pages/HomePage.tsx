import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  Flame,
  MessageSquarePlus,
  Search,
  SearchX,
  Sparkles,
} from 'lucide-react'
import { fetchBoards, fetchPosts } from '../lib/api'
import { usePostVotes } from '../lib/usePostVotes'
import {
  TIME_PRESET_OPTIONS,
  describeTimeRange,
  parseDateInput,
  parseTimePreset,
  resolveTimeRange,
  type TimePreset,
} from '../lib/timeFilter'
import { PostCard } from '../components/PostCard'
import { EmptyState, ErrorState, Spinner } from '../components/ui'

function PostSkeleton({ single }: { single: boolean }) {
  return (
    <div className={`animate-pulse card ${single ? 'px-5 py-5' : 'px-3.5 py-3.5 sm:px-4 sm:py-4'}`}>
      <div className="h-3.5 w-14 rounded bg-slate-100" />
      <div className="mt-2.5 h-4 w-3/4 rounded bg-slate-100" />
      <div className="mt-2 h-3 w-full rounded bg-slate-50" />
      <div className="mt-1.5 h-3 w-2/3 rounded bg-slate-50" />
      <div className="mt-3 flex items-center gap-2">
        <div className="h-5 w-5 rounded-md bg-slate-100" />
        <div className="h-3 w-16 rounded bg-slate-50" />
      </div>
    </div>
  )
}

/**
 * 瀑布流的列数（按视口宽度）：
 *   < 640   1 列（一条帖子独占一行）
 *   ≥ 640   2 列
 *   ≥ 1024  3 列
 *   ≥ 1280  4 列
 *   ≥ 1536  5 列
 */
const COLUMN_BREAKPOINTS = [
  { min: 1536, columns: 5 },
  { min: 1280, columns: 4 },
  { min: 1024, columns: 3 },
  { min: 640, columns: 2 },
] as const

function readColumnCount() {
  if (typeof window === 'undefined') return 1
  for (const item of COLUMN_BREAKPOINTS) {
    if (window.matchMedia(`(min-width: ${item.min}px)`).matches) return item.columns
  }
  return 1
}

function useColumnCount() {
  const [count, setCount] = useState(readColumnCount)
  useEffect(() => {
    const queries = COLUMN_BREAKPOINTS.map((item) => window.matchMedia(`(min-width: ${item.min}px)`))
    const update = () => setCount(readColumnCount())
    for (const query of queries) query.addEventListener('change', update)
    update()
    return () => {
      for (const query of queries) query.removeEventListener('change', update)
    }
  }, [])
  return count
}

/** 卡片固定开销：内边距 + 板块胶囊 + 底部作者/互动行 */
const CARD_CHROME_HEIGHT = 96
const CARD_GAP = 16

/**
 * 估算一张卡片的高度（多列密集排版）。
 * 只用来做「哪一列更矮」的判断，不需要精确，够方向正确即可。
 */
function estimateCardHeight(post: { title: string; content: string }, columnWidth: number): number {
  const usable = Math.max(120, columnWidth - 30)
  const titlePerLine = Math.max(6, Math.floor(usable / 14))
  const bodyPerLine = Math.max(8, Math.floor(usable / 12))
  const titleLines = Math.min(2, Math.max(1, Math.ceil(post.title.length / titlePerLine)))
  const bodyChars = Math.min(post.content.replace(/\s+/g, '').length, 80)
  const bodyLines = bodyChars === 0 ? 0 : Math.min(2, Math.ceil(bodyChars / bodyPerLine))
  return CARD_CHROME_HEIGHT + titleLines * 22 + bodyLines * 20
}

/** 首屏加载 30 条，之后每次「加载更多」追加 20 条 */
const FIRST_PAGE_SIZE = 30
const NEXT_PAGE_SIZE = 20

export default function HomePage() {
  const [params, setParams] = useSearchParams()
  const board = params.get('board')
  const query = params.get('q') ?? ''
  const sort = params.get('sort') === 'hot' ? 'hot' : 'new'

  /* 时间筛选：range（预设）/ from + to（自定义日期）都放在 URL 里，方便分享与刷新保持 */
  const timePreset = parseTimePreset(params.get('range'))
  const customFrom = params.get('from') ?? ''
  const customTo = params.get('to') ?? ''
  const timeRange = useMemo(
    () => resolveTimeRange(timePreset, customFrom, customTo),
    [timePreset, customFrom, customTo],
  )
  const timeFiltering = timeRange !== null
  const timeLabel = describeTimeRange(timePreset, customFrom, customTo)

  // 自定义日期的输入先落在本地草稿里，点「应用」才写进 URL（避免每敲一位就重新请求）
  const [draftFrom, setDraftFrom] = useState(customFrom)
  const [draftTo, setDraftTo] = useState(customTo)
  useEffect(() => {
    setDraftFrom(customFrom)
    setDraftTo(customTo)
  }, [customFrom, customTo])

  // 移动端搜索框的草稿，跟随 URL 里的 q
  const [searchDraft, setSearchDraft] = useState(query)
  useEffect(() => {
    setSearchDraft(query)
  }, [query])

  const boardsQuery = useQuery({
    queryKey: ['boards'],
    queryFn: fetchBoards,
    staleTime: 5 * 60_000,
  })

  const postsQuery = useInfiniteQuery({
    queryKey: [
      'posts',
      {
        board,
        sort,
        query,
        since: timeRange?.since ?? null,
        until: timeRange?.until ?? null,
      },
    ],
    queryFn: ({ pageParam }) =>
      fetchPosts({
        board,
        sort,
        query,
        since: timeRange?.since,
        until: timeRange?.until,
        offset: pageParam.offset,
        limit: pageParam.limit,
      }),
    initialPageParam: { offset: 0, limit: FIRST_PAGE_SIZE },
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined
      return {
        offset: allPages.reduce((total, page) => total + page.items.length, 0),
        limit: NEXT_PAGE_SIZE,
      }
    },
  })

  const boards = boardsQuery.data ?? []
  const boardName = (slug: string) => boards.find((b) => b.slug === slug)?.name

  const posts = (() => {
    const seen = new Set<string>()
    const merged: NonNullable<typeof postsQuery.data>['pages'][number]['items'] = []
    for (const page of postsQuery.data?.pages ?? []) {
      for (const post of page.items) {
        if (!seen.has(post.id)) {
          seen.add(post.id)
          merged.push(post)
        }
      }
    }
    return merged
  })()

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const selectPreset = (preset: TimePreset) => {
    const next = new URLSearchParams(params)
    if (preset === 'all') next.delete('range')
    else next.set('range', preset)
    // 切到预设后，自定义日期不再有意义，顺手清掉
    if (preset !== 'custom') {
      next.delete('from')
      next.delete('to')
    }
    setParams(next, { replace: true })
  }

  const applyCustom = () => {
    let from = draftFrom.trim()
    let to = draftTo.trim()
    // 起止填反了自动对调
    const fromDate = parseDateInput(from)
    const toDate = parseDateInput(to)
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      const swap = from
      from = to
      to = swap
    }
    const next = new URLSearchParams(params)
    next.set('range', 'custom')
    if (from) next.set('from', from)
    else next.delete('from')
    if (to) next.set('to', to)
    else next.delete('to')
    setParams(next, { replace: true })
  }

  const clearFilters = () => {
    const next = new URLSearchParams(params)
    next.delete('q')
    next.delete('range')
    next.delete('from')
    next.delete('to')
    setParams(next, { replace: true })
  }

  const { votes, votesReady, toggleLike, pendingPostId } = usePostVotes(posts.map((post) => post.id))

  /**
   * 瀑布流分列：
   *   1. 先量出列表容器的实际宽度，推算出单列宽度；
   *   2. 按顺序遍历帖子，每条都放进「当前累计高度最矮」的那一列；
   *   3. 高度相同（或刚开始）时自然优先填左边的列，所以顺序仍然是逐行的。
   * 这样某一列内容偏少时会自动多分到帖子，各列高度基本拉平。
   */
  const columnCount = useColumnCount()
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridWidth, setGridWidth] = useState(0)
  useEffect(() => {
    const element = gridRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setGridWidth(element.clientWidth))
    observer.observe(element)
    setGridWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [columnCount])

  const columnWidth =
    gridWidth > 0 ? (gridWidth - CARD_GAP * (columnCount - 1)) / columnCount : 280

  // 实测高度回填：渲染一轮后量出真实卡片高度，下一轮分配就用实测值，列高差可以压到最小
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({})
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const next: Record<string, number> = {}
    let changed = false
    for (const element of grid.querySelectorAll<HTMLElement>('[data-post-card]')) {
      const id = element.dataset.postCard
      if (!id) continue
      const height = element.offsetHeight
      next[id] = height
      if (cardHeights[id] !== height) changed = true
    }
    if (changed) setCardHeights(next)
  }, [posts, columnCount, gridWidth, cardHeights])

  const postColumns = useMemo(() => {
    const buckets: (typeof posts)[] = Array.from({ length: columnCount }, () => [])
    const heights = new Array<number>(columnCount).fill(0)
    for (const post of posts) {
      let target = 0
      for (let i = 1; i < columnCount; i += 1) {
        if (heights[i] < heights[target]) target = i
      }
      buckets[target].push(post)
      const height = cardHeights[post.id] ?? estimateCardHeight(post, columnWidth)
      heights[target] += height + CARD_GAP
    }
    return buckets
  }, [posts, columnCount, columnWidth, cardHeights])

  /* 触底自动加载：滚动到哨兵附近就取下一页（首屏 30 条，之后每次 20 条） */
  const loadMoreRef = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = postsQuery
  useEffect(() => {
    const sentinel = loadMoreRef.current
    if (!sentinel || !hasNextPage || isFetchingNextPage) return
    // 页面滚动的容器是 <main id="app-scroll">，没取到就退回视口
    const root = document.getElementById('app-scroll')
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void fetchNextPage()
      },
      { root, rootMargin: '400px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, posts.length])

  const timeOptionClass = (active: boolean) =>
    `shrink-0 rounded-md px-2 py-1 text-xs transition ${
      active ? 'bg-slate-100 font-medium text-slate-800' : 'text-ink-muted hover:bg-slate-50 hover:text-slate-700'
    }`

  return (
    <div className="space-y-5">
      {/* 移动端搜索：顶部搜索框在 <768px 是隐藏的，这里补一个入口 */}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const q = searchDraft.trim()
          if (q) setParam('q', q)
          else setParam('q', null)
        }}
        className="md:hidden"
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="搜索帖子标题或内容…"
            aria-label="搜索帖子"
            className="w-full rounded-full border border-hairline bg-white py-2 pl-9 pr-4 text-sm outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </form>

      {/* 筛选区：白卡片，上面是带下划线的板块标签，下面是排序 + 时间 */}
      <div className="card px-5 py-4 sm:px-6">
        {/* 板块标签 */}
        <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-hairline [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            onClick={() => setParam('board', null)}
            className={`relative shrink-0 px-2.5 pb-2.5 pt-0.5 text-sm transition ${
              !board
                ? 'font-medium text-blue-600'
                : 'text-ink-soft hover:text-blue-600'
            }`}
          >
            全部
            {!board ? (
              <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-blue-600" />
            ) : null}
          </button>
          {boards.map((b) => {
            const active = board === b.slug
            return (
              <button
                key={b.slug}
                type="button"
                onClick={() => setParam('board', b.slug)}
                className={`relative shrink-0 px-2.5 pb-2.5 pt-0.5 text-sm transition ${
                  active ? 'font-medium text-blue-600' : 'text-ink-soft hover:text-blue-600'
                }`}
              >
                {b.name}
                {active ? (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-blue-600" />
                ) : null}
              </button>
            )
          })}
        </div>

        {/* 排序 + 时间 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-3">
          <div className="flex shrink-0 items-center gap-4">
            <button
              type="button"
              onClick={() => setParam('sort', null)}
              className={`inline-flex items-center gap-1 text-sm transition ${
                sort === 'new' ? 'font-medium text-blue-600' : 'text-ink-muted hover:text-slate-700'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              最新
            </button>
            <button
              type="button"
              onClick={() => setParam('sort', 'hot')}
              className={`inline-flex items-center gap-1 text-sm transition ${
                sort === 'hot' ? 'font-medium text-blue-600' : 'text-ink-muted hover:text-slate-700'
              }`}
            >
              <Flame className="h-3.5 w-3.5" />
              最热
            </button>
          </div>

          <div
            className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="time-filter"
          >
            <span className="shrink-0 pr-1 text-xs text-ink-muted">时间:</span>
            {TIME_PRESET_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={timePreset === option.key}
                onClick={() => selectPreset(option.key)}
                className={timeOptionClass(timePreset === option.key)}
              >
                {option.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={timePreset === 'custom'}
              onClick={() => selectPreset(timePreset === 'custom' ? 'all' : 'custom')}
              className={timeOptionClass(timePreset === 'custom')}
            >
              {timePreset === 'custom' && timeFiltering ? timeLabel : '自定义'}
            </button>
          </div>
        </div>

        {query ? (
          <div className="flex items-center gap-2 pt-2 text-xs text-ink-muted">
            <SearchX className="h-3.5 w-3.5" />
            搜索「<span className="max-w-[10rem] truncate font-medium text-slate-700">{query}</span>」
            <button
              type="button"
              onClick={() => setParam('q', null)}
              className="rounded-md bg-slate-100 px-2 py-0.5 text-ink-muted transition hover:bg-slate-200"
            >
              清除
            </button>
          </div>
        ) : null}
      </div>

      {/* 自定义日期面板：只在选了「自定义」时展开，占满一行 */}
      {timePreset === 'custom' ? (
        <div className="card flex flex-wrap items-center gap-2 px-4 py-3 text-xs text-ink-muted">
          <input
            type="date"
            aria-label="开始日期"
            value={draftFrom}
            max={draftTo || undefined}
            onChange={(event) => setDraftFrom(event.target.value)}
            className="rounded-xl border border-hairline bg-white px-2 py-1 text-slate-700 outline-none focus:border-blue-400"
          />
          <span>至</span>
          <input
            type="date"
            aria-label="结束日期"
            value={draftTo}
            min={draftFrom || undefined}
            onChange={(event) => setDraftTo(event.target.value)}
            className="rounded-xl border border-hairline bg-white px-2 py-1 text-slate-700 outline-none focus:border-blue-400"
          />
          <button
            type="button"
            onClick={applyCustom}
            className="rounded-xl bg-blue-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-blue-500"
          >
            应用
          </button>
          <button
            type="button"
            onClick={() => {
              setDraftFrom('')
              setDraftTo('')
              selectPreset('all')
            }}
            className="rounded-xl bg-white px-2.5 py-1 text-ink-muted ring-1 ring-slate-200 transition hover:bg-slate-50"
          >
            清除
          </button>
          <span aria-live="polite" className="text-[11px] text-ink-muted">
            {timeFiltering ? `当前：${timeLabel}` : '选好日期后点「应用」'}
          </span>
        </div>
      ) : null}

      {/* 列表 */}
      {postsQuery.isPending ? (
        <div ref={gridRef} className="flex items-start gap-3 sm:gap-4">
          {Array.from({ length: columnCount }).map((_, columnIndex) => (
            <div key={columnIndex} className="flex min-w-0 flex-1 flex-col gap-3 sm:gap-4">
              {Array.from({ length: 2 }).map((__, row) => (
                <PostSkeleton key={row} single={columnCount === 1} />
              ))}
            </div>
          ))}
        </div>
      ) : postsQuery.isError ? (
        <ErrorState error={postsQuery.error} retry={() => void postsQuery.refetch()} />
      ) : posts.length === 0 ? (
        <EmptyState
          title={
            query ? '没有找到相关帖子' : timeFiltering ? '这段时间还没有帖子' : '这个板块还没有帖子'
          }
          description={
            query
              ? timeFiltering
                ? `搜索「${query}」，时间范围 ${timeLabel}，都没有命中。换个关键词或时间试试。`
                : '换个关键词试试，或者清除搜索条件。'
              : timeFiltering
                ? `当前时间范围：${timeLabel}。换个范围，或者点「不限时间」看全部帖子。`
                : '来发第一帖，让同学们看到你的想法。'
          }
          action={
            query || timeFiltering ? (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3 py-1.5 text-sm font-medium text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50"
              >
                清除筛选条件
              </button>
            ) : (
              <Link
                to={board ? `/new?board=${board}` : '/new'}
                className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
              >
                <MessageSquarePlus className="h-4 w-4" />
                去发帖
              </Link>
            )
          }
        />
      ) : (
        <div ref={gridRef} className="flex items-start gap-3 sm:gap-4">
          {postColumns.map((bucket, columnIndex) => (
            <div key={columnIndex} className="flex min-w-0 flex-1 flex-col gap-3 sm:gap-4">
              {bucket.map((post) => (
                <div key={post.id} data-post-card={post.id}>
                  <PostCard
                    dense={columnCount > 1}
                    post={post}
                    boardName={boardName(post.board_slug)}
                    myVote={votes[post.id] ?? null}
                    onToggleLike={() => toggleLike(post.id)}
                    likePending={pendingPostId === post.id || !votesReady}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* 加载更多 + 触底自动加载 */}
      {posts.length > 0 ? (
        <div className="flex flex-col items-center gap-2 pt-1">
          {postsQuery.hasNextPage ? (
            <button
              type="button"
              onClick={() => void postsQuery.fetchNextPage()}
              disabled={postsQuery.isFetchingNextPage}
              className="rounded-xl border border-hairline bg-white px-5 py-2 text-sm text-ink-soft transition hover:bg-slate-50 disabled:opacity-60"
            >
              {postsQuery.isFetchingNextPage ? '加载中…' : '加载更多'}
            </button>
          ) : (
            <p className="py-2 text-xs text-ink-muted">已经到底了</p>
          )}
          {/* 触底哨兵：滚到附近就自动加载下一页 */}
          <div ref={loadMoreRef} className="h-1 w-full" aria-hidden />
        </div>
      ) : null}

      {boardsQuery.isPending ? <Spinner label="正在加载板块…" /> : null}
    </div>
  )
}
