/**
 * 头像：由「图标（emoji）+ 背景（两色渐变）」组合而成。
 * 存储格式（profiles.avatar，text）：
 *   - 旧格式：'avatar-1' ~ 'avatar-8'（兼容已有用户）
 *   - 新格式：JSON 字符串 {"e":"🦊","c":["#38bdf8","#2563eb"]}
 * 渲染时用内联 style 画渐变，避免动态拼 Tailwind 类名导致样式丢失。
 */

export interface AvatarStyle {
  emoji: string
  from: string
  to: string
}

export const DEFAULT_AVATAR: AvatarStyle = { emoji: '🐱', from: '#38bdf8', to: '#3b82f6' }

/** 旧的 8 个预设头像 → 等价的 emoji + 颜色（保证老数据看起来不变） */
const LEGACY_AVATARS: Record<string, AvatarStyle> = {
  'avatar-1': { emoji: '🐱', from: '#38bdf8', to: '#3b82f6' },
  'avatar-2': { emoji: '🐶', from: '#fbbf24', to: '#f97316' },
  'avatar-3': { emoji: '🐼', from: '#34d399', to: '#14b8a6' },
  'avatar-4': { emoji: '🦊', from: '#fb7185', to: '#ec4899' },
  'avatar-5': { emoji: '🐨', from: '#a78bfa', to: '#a855f7' },
  'avatar-6': { emoji: '🐸', from: '#a3e635', to: '#22c55e' },
  'avatar-7': { emoji: '🐧', from: '#22d3ee', to: '#0ea5e9' },
  'avatar-8': { emoji: '🦉', from: '#818cf8', to: '#2563eb' },
}

/** 背景预设（两色渐变，点一下同时设置两个颜色） */
export const AVATAR_BACKGROUNDS: Array<{ label: string; from: string; to: string }> = [
  { label: '天空', from: '#38bdf8', to: '#3b82f6' },
  { label: '琥珀', from: '#fbbf24', to: '#f97316' },
  { label: '青翠', from: '#34d399', to: '#14b8a6' },
  { label: '玫瑰', from: '#fb7185', to: '#ec4899' },
  { label: '紫罗兰', from: '#a78bfa', to: '#a855f7' },
  { label: '青柠', from: '#a3e635', to: '#22c55e' },
  { label: '青色', from: '#22d3ee', to: '#0ea5e9' },
  { label: '靛蓝', from: '#818cf8', to: '#2563eb' },
  { label: '日落', from: '#f97316', to: '#db2777' },
  { label: '海洋', from: '#0ea5e9', to: '#0f766e' },
  { label: '薄荷', from: '#6ee7b7', to: '#059669' },
  { label: '糖果', from: '#f472b6', to: '#a78bfa' },
  { label: '森林', from: '#4ade80', to: '#166534' },
  { label: '暮色', from: '#6366f1', to: '#1e293b' },
  { label: '蜜桃', from: '#fdba74', to: '#f43f5e' },
  { label: '极光', from: '#2dd4bf', to: '#6366f1' },
  { label: '樱花', from: '#fbcfe8', to: '#f472b6' },
  { label: '柠檬', from: '#fef08a', to: '#eab308' },
  { label: '石墨', from: '#64748b', to: '#0f172a' },
  { label: '珊瑚', from: '#fca5a5', to: '#ef4444' },
]

/** 图标分组：约 180 个 emoji，选择面足够大 */
export const AVATAR_EMOJI_GROUPS: Array<{ label: string; emojis: string[] }> = [
  {
    label: '动物',
    emojis: [
      '🐱', '🐶', '🐼', '🦊', '🐨', '🐸', '🐧', '🦉', '🐯', '🦁',
      '🐮', '🐷', '🐵', '🐰', '🐹', '🐭', '🐻', '🐺', '🦝', '🦔',
      '🐢', '🐍', '🦎', '🐙', '🦑', '🐳', '🐬', '🐠', '🦈', '🦋',
      '🐝', '🐞', '🦄', '🐲', '🦖', '🦥', '🦭', '🐑', '🐘', '🦒',
      '🐦‍🔥', // 凤凰（Unicode 15.1 组合 emoji：鸟 + 火）
    ],
  },
  {
    label: '表情',
    emojis: [
      '😀', '😄', '😁', '😆', '😊', '😇', '🙂', '😉', '😍', '🥰',
      '😘', '😎', '🤩', '🤔', '🤗', '🤭', '😴', '😌', '🥳', '🤓',
      '😜', '🤪', '🧐', '😤', '😭', '😡', '🤯', '🫠', '🥺', '😈',
    ],
  },
  {
    label: '食物',
    emojis: [
      '🍎', '🍊', '🍋', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭',
      '🍍', '🥥', '🥝', '🍅', '🥑', '🌽', '🥕', '🍞', '🥐', '🍔',
      '🍕', '🍜', '🍣', '🍩', '🍪', '🎂', '🍫', '🧋', '☕', '🍵',
    ],
  },
  {
    label: '自然',
    emojis: [
      '🌸', '🌹', '🌻', '🌼', '🌷', '🌱', '🌲', '🌴', '🍀', '🍁',
      '🍂', '🌙', '⭐', '🌟', '✨', '⚡', '🔥', '❄️', '🌈', '☀️',
      '🌤️', '🌧️', '⛰️', '🌊', '🌵', '🍄', '🪐', '🌍',
    ],
  },
  {
    label: '运动 · 物品',
    emojis: [
      '⚽', '🏀', '🏐', '🎾', '🏓', '🏸', '🎮', '🎧', '🎨', '📚',
      '✏️', '💻', '📷', '🎸', '🎤', '🎬', '🚀', '✈️', '🚲', '🏆',
      '🥇', '🎯', '🎲', '💎', '📱', '⌚', '🔭', '🧪',
    ],
  },
  {
    label: '其他',
    emojis: [
      '👻', '🤖', '👽', '🎃', '🧸', '🪄', '🔮', '💡', '❤️', '🧡',
      '💛', '💚', '💙', '💜', '🖤', '🤍', '💫', '🌞', '🌝', '🦩',
      '🦚', '🦕', '🐉', '🐲', '😺', '🫧', '🎈', '🎁',
    ],
  },
]

function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null
}

function normalizeEmoji(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const emoji = value.trim()
  if (!emoji || /[<>\s]/.test(emoji)) return null
  if ([...emoji].length > 4) return null
  return emoji
}

/** 解析 profiles.avatar（兼容旧预设 id / 新 JSON / 脏数据） */
export function parseAvatar(value: string | null | undefined): AvatarStyle {
  if (!value) return DEFAULT_AVATAR
  if (LEGACY_AVATARS[value]) return LEGACY_AVATARS[value]

  try {
    const parsed = JSON.parse(value) as { e?: unknown; c?: unknown }
    const emoji = normalizeEmoji(parsed?.e)
    const colors = Array.isArray(parsed?.c) ? parsed.c : []
    const from = normalizeHex(colors[0])
    const to = normalizeHex(colors[1])
    if (emoji && from && to) return { emoji, from, to }
  } catch {
    /* 不是 JSON，按脏数据回退 */
  }

  return DEFAULT_AVATAR
}

/** 生成要写回 profiles.avatar 的字符串 */
export function encodeAvatar(style: AvatarStyle): string {
  const emoji = normalizeEmoji(style.emoji) ?? DEFAULT_AVATAR.emoji
  const from = normalizeHex(style.from) ?? DEFAULT_AVATAR.from
  const to = normalizeHex(style.to) ?? DEFAULT_AVATAR.to
  return JSON.stringify({ e: emoji, c: [from, to] })
}
