import {
  GraduationCap,
  Heart,
  MapPin,
  MessageSquare,
  Users,
  type LucideIcon,
} from 'lucide-react'

/* ------------------------------ 头像 ------------------------------ */
// 头像相关的图标与背景定义已移到 src/lib/avatar.ts（支持「自选图标 + 自定义背景」）

/* ------------------------------ 板块 ------------------------------ */

export interface BoardMeta {
  icon: LucideIcon
  iconBg: string
  iconColor: string
  chip: string
  text: string
}

const DEFAULT_BOARD_META: BoardMeta = {
  icon: MessageSquare,
  iconBg: 'bg-slate-100',
  iconColor: 'text-slate-500',
  chip: 'bg-slate-100 text-slate-600',
  text: 'text-slate-600',
}

const BOARD_META: Record<string, BoardMeta> = {
  chat: {
    icon: MessageSquare,
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-500',
    chip: 'bg-blue-50 text-blue-600',
    text: 'text-blue-600',
  },
  study: {
    icon: GraduationCap,
    iconBg: 'bg-sky-50',
    iconColor: 'text-sky-500',
    chip: 'bg-sky-50 text-sky-600',
    text: 'text-sky-600',
  },
  love: {
    icon: Heart,
    iconBg: 'bg-pink-50',
    iconColor: 'text-pink-500',
    chip: 'bg-pink-50 text-pink-600',
    text: 'text-pink-600',
  },
  lost: {
    icon: MapPin,
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-500',
    chip: 'bg-amber-50 text-amber-600',
    text: 'text-amber-600',
  },
  friend: {
    icon: Users,
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-500',
    chip: 'bg-violet-50 text-violet-600',
    text: 'text-violet-600',
  },
}

export function getBoardMeta(slug: string | null | undefined): BoardMeta {
  return (slug && BOARD_META[slug]) || DEFAULT_BOARD_META
}

/* ------------------------------ 举报 ------------------------------ */

export const REPORT_REASONS = ['广告营销', '辱骂攻击', '色情低俗', '违法违规', '虚假信息', '其他'] as const

export const RULES: Array<{ title: string; body: string }> = [
  {
    title: '友善交流',
    body: '可以争论观点，不要攻击同学。辱骂、人身攻击、地域歧视、性别歧视都会被处理。',
  },
  {
    title: '真实信息',
    body: '不造谣、不传谣。涉及具体个人、老师、社团的内容请先确认真实性。',
  },
  {
    title: '保护隐私',
    body: '不要公开他人的真实姓名、学号、手机号、宿舍门牌号和聊天记录截图。',
  },
  {
    title: '拒绝广告',
    body: '兼职刷单、代写代考、贷款、引流二维码等一律删除并可能封禁账号。',
  },
  {
    title: '遵守法律',
    body: '涉黄、涉赌、涉毒、涉暴与政治敏感内容按学校与平台规定处理。',
  },
  {
    title: '合理使用',
    body: '发帖前先看板块；同一个问题不要重复刷屏；图片与正文请相关。',
  },
]
