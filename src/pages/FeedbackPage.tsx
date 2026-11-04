import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Clock3, Lightbulb, Send } from 'lucide-react'
import {
  FEEDBACK_CATEGORIES,
  fetchMyFeedback,
  submitFeedback,
  type FeedbackCategory,
} from '../lib/api'
import { formatDateTime } from '../lib/format'
import { Badge, EmptyState, ErrorState, Spinner } from '../components/ui'

const INPUT_CLASS =
  'w-full rounded-xl border border-hairline bg-slate-50/70 px-3 py-2 text-sm text-slate-800 outline-none transition placeholder:text-ink-muted focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-100'
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-card transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60'

const CONTENT_MIN = 5
const CONTENT_MAX = 1000
const CONTACT_MAX = 100

export default function FeedbackPage() {
  const queryClient = useQueryClient()
  const [category, setCategory] = useState<FeedbackCategory>('建议')
  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [error, setError] = useState<string | null>(null)

  const listQuery = useQuery({ queryKey: ['my-feedback'], queryFn: fetchMyFeedback })
  const items = listQuery.data ?? []

  const mutation = useMutation({
    mutationFn: () => submitFeedback(content.trim(), category, contact),
    onSuccess: () => {
      toast.success('反馈已提交，感谢你的建议！')
      setContent('')
      setContact('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['my-feedback'] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : '提交失败，请稍后重试'
      setError(message)
      toast.error(message)
    },
  })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const text = content.trim()
    if (text.length < CONTENT_MIN) {
      setError(`反馈内容至少写 ${CONTENT_MIN} 个字，方便我们理解你的问题`)
      return
    }
    if (text.length > CONTENT_MAX) {
      setError(`反馈内容不能超过 ${CONTENT_MAX} 字`)
      return
    }
    if (contact.trim().length > CONTACT_MAX) {
      setError(`联系方式不能超过 ${CONTACT_MAX} 个字符`)
      return
    }
    mutation.mutate()
  }

  return (
    <div className="space-y-5">
      <section className="card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-500">
            <Lightbulb className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold tracking-tight text-ink">意见反馈</h1>
            <p className="mt-1 text-sm leading-[1.7] text-ink-soft">
              用得不顺手？发现 bug？想要新功能？都可以在这里告诉管理员。反馈只有你和管理员能看到，处理进度会显示在下方列表里。
            </p>
          </div>
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">提交反馈</h2>

        <form onSubmit={onSubmit} className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="feedback-category" className="text-sm text-ink-soft">
              反馈类型
            </label>
            <select
              id="feedback-category"
              value={category}
              onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
              className={`${INPUT_CLASS} max-w-[10rem]`}
            >
              {FEEDBACK_CATEGORIES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="feedback-content" className="text-sm text-ink-soft">
                反馈内容
              </label>
              <span className="text-xs text-ink-muted">
                {content.trim().length}/{CONTENT_MAX}
              </span>
            </div>
            <textarea
              id="feedback-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={5}
              maxLength={CONTENT_MAX}
              placeholder="写清楚你遇到的问题或想要的改进，越具体越好…"
              className={`${INPUT_CLASS} mt-1 resize-y leading-6`}
            />
          </div>

          <div>
            <label htmlFor="feedback-contact" className="text-sm text-ink-soft">
              联系方式（可选）
            </label>
            <input
              id="feedback-contact"
              value={contact}
              onChange={(event) => setContact(event.target.value)}
              maxLength={CONTACT_MAX}
              placeholder="QQ / 微信 / 邮箱，方便管理员找你确认细节"
              className={`${INPUT_CLASS} mt-1`}
            />
          </div>

          {error ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-ink-muted">提交后管理员会在后台看到，处理完状态会变成「已处理」。</p>
            <button type="submit" disabled={mutation.isPending} className={PRIMARY_BUTTON}>
              <Send className="h-4 w-4" />
              {mutation.isPending ? '提交中…' : '提交反馈'}
            </button>
          </div>
        </form>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">
          我的反馈
          <span className="ml-2 text-xs font-normal text-ink-muted">{items.length} 条</span>
        </h2>

        {listQuery.isPending ? <Spinner label="正在加载反馈…" /> : null}
        {listQuery.isError ? (
          <ErrorState error={listQuery.error} retry={() => void listQuery.refetch()} />
        ) : null}
        {listQuery.isSuccess && items.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              bare
              title="还没有提交过反馈"
              description="遇到问题或者有好点子，就在上面写一条吧。"
              icon={<Lightbulb className="h-7 w-7" />}
            />
          </div>
        ) : null}

        <ul className="mt-2 divide-y divide-hairline">
          {items.map((item) => (
            <li key={item.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="blue">{item.category}</Badge>
                {item.status === 'resolved' ? (
                  <Badge tone="green">
                    <CheckCircle2 className="h-3 w-3" />
                    已处理
                  </Badge>
                ) : (
                  <Badge tone="amber">
                    <Clock3 className="h-3 w-3" />
                    待处理
                  </Badge>
                )}
                <span className="ml-auto text-xs text-ink-muted">{formatDateTime(item.created_at)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-[1.7] text-ink-soft">
                {item.content}
              </p>
              {item.contact ? (
                <p className="mt-1 text-xs text-ink-muted">联系方式：{item.contact}</p>
              ) : null}
              {item.handled_at ? (
                <p className="mt-1 text-xs text-emerald-600">处理时间：{formatDateTime(item.handled_at)}</p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
