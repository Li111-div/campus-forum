import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ImagePlus, Loader2, Lock, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '../lib/auth'
import { checkBannedWord, createPost, fetchBoards } from '../lib/api'
import { getBoardMeta } from '../lib/constants'
import { ErrorState, Spinner } from '../components/ui'
import { IMAGE_MAX_COUNT, type UploadedImage, uploadImage, validateImageFile } from '../lib/image'

const TITLE_MAX = 80
const CONTENT_MAX = 5000

export default function NewPostPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { profile, isBanned } = useAuth()
  const queryClient = useQueryClient()

  const boardsQuery = useQuery({
    queryKey: ['boards'],
    queryFn: fetchBoards,
    staleTime: 5 * 60_000,
  })
  const boards = boardsQuery.data ?? []

  const [boardSlug, setBoardSlug] = useState(params.get('board') ?? '')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(0)
  // 正在上传的张数（ref 同步更新，避免连选时超量）
  const uploadingRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 违禁词预检是异步的，期间按钮必须禁用，否则连点两下会发出两条一样的帖子
  const [checking, setChecking] = useState(false)

  const activeBoardSlug = boardSlug || boards[0]?.slug || ''
  const activeBoard = boards.find((b) => b.slug === activeBoardSlug)

  const mutation = useMutation({
    mutationFn: () =>
      createPost({
        board_slug: activeBoardSlug,
        title: title.trim(),
        content: content.trim(),
        images: images.map((image) => image.url),
      }),
    onSuccess: (post) => {
      // 发帖成功后让首页列表与「我的帖子」失效，回到首页/个人中心时能立刻看到新帖
      void queryClient.invalidateQueries({ queryKey: ['posts'] })
      void queryClient.invalidateQueries({ queryKey: ['my-posts'] })
      toast.success('发布成功')
      navigate(`/post/${post.id}`, { replace: true })
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : '发布失败，请稍后重试'
      setError(message)
      toast.error(message)
    },
  })

  /** 选图后就立刻上传，发布时只提交 URL，不用等 */
  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return
    // 已上传 + 正在上传 一起算，避免快速连选时超量
    const room = Math.max(0, IMAGE_MAX_COUNT - images.length - uploadingRef.current)
    if (room <= 0) {
      setError(`最多上传 ${IMAGE_MAX_COUNT} 张图片`)
      return
    }
    const picked = Array.from(fileList).slice(0, room)
    if (fileList.length > room) {
      setError(`最多上传 ${IMAGE_MAX_COUNT} 张图片，多出的已忽略`)
    }
    for (const file of picked) {
      const problem = validateImageFile(file)
      if (problem) {
        setError(problem)
        continue
      }
      uploadingRef.current += 1
      setUploading((n) => n + 1)
      try {
        const uploaded = await uploadImage(file)
        setImages((list) => [...list, uploaded].slice(0, IMAGE_MAX_COUNT))
      } catch (err) {
        setError(err instanceof Error ? err.message : '图片上传失败')
      } finally {
        uploadingRef.current -= 1
        setUploading((n) => n - 1)
      }
    }
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (checking || mutation.isPending) return
    if (uploading > 0) {
      setError('图片还在上传，稍等一下再发布')
      return
    }
    setError(null)
    if (isBanned) {
      setError('当前账号被限制发言，无法发帖')
      return
    }
    if (!activeBoardSlug) {
      setError('请选择一个板块')
      return
    }
    if (activeBoard?.is_locked) {
      setError('该板块暂时关闭发帖')
      return
    }
    if (title.trim().length < 2) {
      setError('标题至少 2 个字符')
      return
    }
    if (title.trim().length > TITLE_MAX) {
      setError(`标题不能超过 ${TITLE_MAX} 个字符`)
      return
    }
    if (content.trim().length < 1) {
      setError('正文不能为空')
      return
    }
    if (content.trim().length > CONTENT_MAX) {
      setError(`正文不能超过 ${CONTENT_MAX} 个字符`)
      return
    }
    // 违禁词预检：命中就直接提示，不必等服务器拒绝
    setChecking(true)
    try {
      const hit = await checkBannedWord(`${title.trim()}\n${content.trim()}`).catch(() => null)
      if (hit) {
        setError(`帖子内容包含违禁词「${hit}」，请修改后再提交`)
        return
      }
      mutation.mutate()
    } finally {
      setChecking(false)
    }
  }

  if (boardsQuery.isPending) return <Spinner label="正在加载板块…" />
  if (boardsQuery.isError) {
    return <ErrorState error={boardsQuery.error} retry={() => void boardsQuery.refetch()} />
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        to="/"
        className="mb-3 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-slate-700"
      >
        <ArrowLeft className="h-4 w-4" />
        返回首页
      </Link>

      <form onSubmit={onSubmit} className="card p-5 sm:p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold tracking-tight text-ink">发布新帖</h1>
          <span className="text-xs text-ink-muted">
            {profile?.display_name ?? '未登录'}
          </span>
        </div>

        {/* 板块 */}
        <div className="mt-5">
          <p className="mb-2 text-xs font-medium text-slate-600">选择板块</p>
          <div className="flex flex-wrap gap-2">
            {boards.map((board) => {
              const meta = getBoardMeta(board.slug)
              const active = activeBoardSlug === board.slug
              return (
                <button
                  key={board.slug}
                  type="button"
                  onClick={() => setBoardSlug(board.slug)}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition ${
                    active
                      ? 'border-blue-300 bg-blue-50 font-medium text-blue-600'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <meta.icon className="h-3.5 w-3.5" />
                  {board.name}
                  {board.is_locked ? <Lock className="h-3 w-3 text-amber-500" /> : null}
                </button>
              )
            })}
          </div>
          {activeBoard?.description ? (
            <p className="mt-1.5 text-[11px] text-ink-muted">{activeBoard.description}</p>
          ) : null}
        </div>

        {/* 标题 */}
        <div className="mt-5">
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="title" className="text-xs font-medium text-slate-600">
              标题
            </label>
            <span className="text-[11px] text-ink-muted">
              {title.length}/{TITLE_MAX}
            </span>
          </div>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={TITLE_MAX}
            placeholder="一句话说清楚你想聊什么（2–80 字）"
            className="w-full rounded-xl border border-hairline bg-slate-50/70 px-3.5 py-2.5 text-sm outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
          />
        </div>

        {/* 正文 */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="content" className="text-xs font-medium text-slate-600">
              正文
            </label>
            <span className="text-[11px] text-ink-muted">
              {content.length}/{CONTENT_MAX}
            </span>
          </div>
          <textarea
            id="content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={CONTENT_MAX}
            rows={10}
            placeholder="写下你的内容…… 请遵守社区规则：不造谣、不攻击、不泄露隐私。"
            className="w-full resize-y rounded-xl border border-hairline bg-slate-50/70 px-3.5 py-3 text-sm leading-6 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100"
          />
        </div>

        {/* 图片 */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-slate-600">图片（可选）</span>
            <span className="text-[11px] text-ink-muted">
              {images.length}/{IMAGE_MAX_COUNT} 张 · 单张 ≤ 8MB
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            {images.map((image) => (
              <div
                key={image.url}
                className="group relative h-20 w-28 overflow-hidden rounded-xl border border-hairline bg-slate-50"
              >
                <img src={image.thumb} alt="已上传的图片" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => setImages((list) => list.filter((item) => item.url !== image.url))}
                  aria-label="移除这张图片"
                  className="absolute right-1 top-1 rounded-full bg-black/55 p-1 text-white opacity-0 transition group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}

            {uploading > 0 ? (
              <div className="flex h-20 w-28 items-center justify-center rounded-xl border border-dashed border-hairline-strong bg-white text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : null}

            {images.length + uploading < IMAGE_MAX_COUNT ? (
              <label
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  void handleFiles(event.dataTransfer.files)
                }}
                className={`flex h-20 w-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-[11px] transition ${
                  dragging
                    ? 'border-blue-300 bg-blue-50 text-blue-600'
                    : 'border-hairline-strong bg-white text-ink-muted hover:border-blue-300 hover:text-blue-600'
                }`}
              >
                <ImagePlus className="h-4 w-4" />
                添加图片
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  aria-label="选择图片"
                  className="hidden"
                  onChange={(event) => {
                    void handleFiles(event.target.files)
                    event.target.value = ''
                  }}
                />
              </label>
            ) : null}
          </div>
        </div>

        {isBanned ? (
          <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">
            当前账号被限制发言，暂时不能发帖。
          </p>
        ) : null}

        {error ? (
          <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
        ) : null}

        <div className="mt-5 flex items-center justify-between gap-3">
          <p className="text-[11px] leading-5 text-ink-muted">
            发布后所有人都能看到。发帖频率有上限，请勿刷屏。
          </p>
          <button
            type="submit"
            disabled={mutation.isPending || checking || isBanned || uploading > 0}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-card transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Send className="h-4 w-4" />
            {mutation.isPending
              ? '发布中…'
              : checking
                ? '检查中…'
                : uploading > 0
                  ? '图片上传中…'
                  : '发布'}
          </button>
        </div>
      </form>
    </div>
  )
}
