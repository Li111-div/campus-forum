/**
 * 图片上传：存在 ImgBB，论坛数据库只记录图片 URL。
 *
 * 为什么用图床：数据库只存 URL，帖子表仍然是纯文本，备份/导出体积小，
 * 也不用给 Supabase Storage 开桶和 RLS 策略。
 *
 * 注意：ImgBB 的 API key 是通过 VITE_ 环境变量打在前端包里的，任何能打开
 * 网站的人都能从 JS 里读到它。对校内小论坛够用，但要清楚这个风险：
 *   - 别人可以拿你的 key 上传任意图片，消耗你的额度
 *   - 想彻底藏住 key，需要改成 Supabase Edge Function 代理上传
 */

const API_ENDPOINT = 'https://api.imgbb.com/1/upload'
const API_KEY = import.meta.env.VITE_IMGBB_API_KEY as string | undefined

/** ImgBB 单张上限 32MB；论坛这边再收紧到 8MB，避免有人传大图卡页面 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024
/** 单帖最多几张（和 app_config.max_images_per_post 保持一致） */
export const IMAGE_MAX_COUNT = 4

export interface UploadedImage {
  /** 原图直链，存进 posts.images */
  url: string
  /** ImgBB 的缩略图，列表页用 */
  thumb: string
  /** 删除页地址（ImgBB 的删除需要打开网页点确认，不是 API） */
  deleteUrl: string
}

/**
 * 只放行 http/https 的图片地址。
 * 数据库层已经用触发器拦截了 javascript:/data: 之类的伪协议，
 * 这里再兜一层：渲染历史脏数据时也不会被当成可点击链接。
 */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const url = value.trim()
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return null
  return url
}

/** 过滤出可以安全渲染的图片地址 */
export function safeImageList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.map(safeImageUrl).filter((url): url is string => Boolean(url))
}

function formatMb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 上传前先把明显不合格的文件拦下来，免得白白消耗图床额度。 */
export function validateImageFile(file: File): string | null {
  if (!file.type.startsWith('image/')) return '只能上传图片文件（jpg / png / gif / webp）'
  if (file.size === 0) return '图片是空文件，换一张试试'
  if (file.size > IMAGE_MAX_BYTES) {
    return `图片不能超过 ${formatMb(IMAGE_MAX_BYTES)}（当前 ${formatMb(file.size)}）`
  }
  return null
}

export async function uploadImage(file: File): Promise<UploadedImage> {
  if (!API_KEY) {
    throw new Error('没有配置图床密钥（VITE_IMGBB_API_KEY），图片上传暂不可用')
  }
  const problem = validateImageFile(file)
  if (problem) throw new Error(problem)

  const form = new FormData()
  form.append('image', file)
  form.append('name', file.name.replace(/\.[^.]+$/, '').slice(0, 60) || 'post-image')

  let response: Response
  try {
    response = await fetch(`${API_ENDPOINT}?key=${encodeURIComponent(API_KEY)}`, {
      method: 'POST',
      body: form,
      // 图床偶尔会卡住，30 秒没响应就当失败，别让按钮一直转圈
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('图片上传超时（30 秒），换个网络或换张小一点的图再试')
    }
    throw new Error('图片上传失败：网络不通或图床不可达，稍后再试')
  }

  const payload = (await response.json().catch(() => null)) as
    | { success?: boolean; data?: { display_url?: string; url?: string; thumb?: { url?: string }; delete_url?: string }; error?: { message?: string } }
    | null

  if (!response.ok || !payload?.success || !payload.data) {
    const reason = payload?.error?.message ?? `HTTP ${response.status}`
    throw new Error(`图片上传失败：${reason}`)
  }

  const url = payload.data.display_url ?? payload.data.url
  if (!url) throw new Error('图片上传失败：图床没有返回图片地址')

  return {
    url,
    thumb: payload.data.thumb?.url ?? url,
    deleteUrl: payload.data.delete_url ?? '',
  }
}
