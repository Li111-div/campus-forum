import { Link } from 'react-router-dom'
import {
  FileText,
  Megaphone,
  MessageSquare,
  Shield,
  ShieldAlert,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { RULES } from '../lib/constants'

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-500'
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-xl border border-hairline bg-white px-3 py-1.5 text-sm text-ink-soft transition hover:bg-slate-50'

interface GuideStep {
  icon: LucideIcon
  title: string
  body: string
}

const GUIDE_STEPS: GuideStep[] = [
  {
    icon: UserPlus,
    title: '注册与登录',
    body: '用邮箱或用户名注册。昵称是你在论坛的公开身份，请认真填写。',
  },
  {
    icon: FileText,
    title: '发帖',
    body: '登录后点右上角「发帖」，选择板块、填写标题和正文。标题要能说明问题，正文写清楚背景。',
  },
  {
    icon: MessageSquare,
    title: '评论与互动',
    body: '可以对帖子点赞、踩、收藏和评论。锁定或已删除的帖子不能继续评论。',
  },
  {
    icon: Users,
    title: '关注与作者主页',
    body: '点作者昵称可以进入作者主页，看到 TA 公开发过的全部帖子；关注后 TA 的新帖会通知你。',
  },
  {
    icon: Megaphone,
    title: '举报违规',
    body: '帖子和评论都有举报入口。请如实填写举报原因，管理员会尽快核实处理。',
  },
]

export default function RulesPage() {
  return (
    <div className="space-y-5">
      <section className="card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <Shield className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[22px] font-bold tracking-tight text-ink">社区规则</h1>
            <p className="mt-1 text-sm leading-[1.7] text-ink-soft">
              校园论坛是同学们交流的地方。发帖、评论前请先读一遍下面的规则，违规内容会被删除，账号可能被限制。
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-card border border-amber-100 bg-amber-50/70 p-5 sm:p-5">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
          <div className="min-w-0 text-sm leading-6 text-amber-800">
            <p className="font-semibold">本站不是匿名论坛</p>
            <p className="mt-1">
              你发的帖子和评论会显示你的昵称，其他人可以点进你的主页看到你发过的所有帖子。请勿发布违法违规、侵犯他人隐私的内容；管理员可追溯到账号并处理。
            </p>
          </div>
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <Shield className="h-4 w-4 text-blue-500" />
          六条基本规则
        </h2>
        <ol className="mt-3 space-y-3">
          {RULES.map((rule, index) => (
            <li key={rule.title} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-xs font-bold text-blue-600">
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">{rule.title}</p>
                <p className="mt-0.5 text-sm leading-[1.7] text-ink-soft">{rule.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">使用说明</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {GUIDE_STEPS.map((step) => (
            <div key={step.title} className="flex items-start gap-3 rounded-xl bg-slate-50 p-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white text-ink-muted ring-1 ring-slate-200">
                <step.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">{step.title}</p>
                <p className="mt-0.5 text-xs leading-5 text-ink-muted">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">免责声明</h2>
        <p className="mt-2 text-sm leading-[1.7] text-ink-soft">
          论坛内容由同学自行发布，不代表平台立场。请自行判断信息真实性，涉及交易、人身安全的内容请谨慎对待。平台会按规则处理违规内容，但不对用户发布的信息承担担保责任。
        </p>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-hairline pt-3">
          <Link to="/" className={SECONDARY_BUTTON}>
            返回首页
          </Link>
          <Link to="/new" className={PRIMARY_BUTTON}>
            去发帖
          </Link>
        </div>
      </section>
    </div>
  )
}
