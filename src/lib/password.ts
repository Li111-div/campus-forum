import { supabase } from './supabase'

/**
 * 密码相关：找回密码（邮件链接）与修改密码。
 *
 * 恢复链接的落地页是 `#/reset-password`。Supabase 的恢复链接形如
 *   http://host/#/reset-password#access_token=...&refresh_token=...&type=recovery
 * （redirectTo 后面的 `#access_token=...` 由 Supabase 追加），
 * 这里统一从 URL 里把 token 抠出来，再手动 setSession——
 * 不依赖 SDK 的 detectSessionInUrl，避免和 HashRouter 抢 hash。
 */

/** Supabase（GoTrue）默认最小长度 6；bcrypt 上限 72 字节，超了会被静默截断。 */
export const PASSWORD_MIN = 6
export const PASSWORD_MAX = 72

export const RESET_PATH = '/reset-password'

export interface RecoveryTokens {
  accessToken: string
  refreshToken: string | null
}

/** 把 GoTrue 的英文报错翻成中文。 */
export function humanizeAuthError(message: string | null | undefined): string {
  const text = message ?? ''
  if (/invalid login credentials/i.test(text)) return '邮箱或密码不正确'
  if (/email not confirmed/i.test(text)) return '邮箱还没确认，请先到邮箱里点确认链接'
  if (/too many requests|rate limit|for security purposes/i.test(text)) {
    return '操作太频繁了，请等一分钟后再试'
  }
  if (/invalid email/i.test(text)) return '邮箱格式不正确'
  if (/password should be at least/i.test(text)) return `密码至少 ${PASSWORD_MIN} 位`
  if (/different from the old password|same password/i.test(text)) return '新密码不能和当前密码相同'
  if (/weak password|password is too weak/i.test(text)) return '密码强度太弱，请换一个更复杂的'
  if (/auth session missing|session.*not.*found|not authenticated|JWT/i.test(text)) {
    return '重置链接已失效，请重新发起找回密码'
  }
  if (/timeout|failed to fetch|networkerror|network request failed/i.test(text)) {
    return '网络连接超时或无法访问 Supabase，请检查网络后重试'
  }
  return text || '操作失败，请稍后重试'
}

/** 新密码的本地校验（数据库/Auth 侧仍会再校验一次）。 */
export function passwordProblem(password: string, confirm?: string): string | null {
  if (password.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`
  if (password.length > PASSWORD_MAX) return `密码不能超过 ${PASSWORD_MAX} 位`
  if (confirm !== undefined && password !== confirm) return '两次输入的密码不一致'
  return null
}

/**
 * 从当前 URL 里读出恢复链接带回的 token。
 * 兼容几种写法：
 *   #access_token=..&refresh_token=..&type=recovery
 *   #/reset-password#access_token=..&refresh_token=..
 *   ?access_token=..&refresh_token=..（少数情况下 Supabase 用 query）
 */
export function readRecoveryTokens(): RecoveryTokens | null {
  if (typeof window === 'undefined') return null

  const params = new URLSearchParams()
  const hash = window.location.hash
  const hashBody = hash.startsWith('#') ? hash.slice(1) : hash
  const secondHash = hashBody.indexOf('#')
  const candidates = [
    secondHash >= 0 ? hashBody.slice(secondHash + 1) : hashBody,
    hashBody,
    window.location.search.replace(/^\?/, ''),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const parsed = new URLSearchParams(candidate)
    parsed.forEach((value, key) => {
      if (!params.has(key)) params.set(key, value)
    })
  }

  const accessToken = params.get('access_token')
  if (!accessToken) return null
  return { accessToken, refreshToken: params.get('refresh_token') }
}

/** 读取 URL 里 Supabase 回传的错误（例如 otp_expired / access_denied）。 */
export function readRecoveryError(): string | null {
  if (typeof window === 'undefined') return null

  const hashBody = window.location.hash.replace(/^#/, '')
  const secondHash = hashBody.indexOf('#')
  const chunks = [
    secondHash >= 0 ? hashBody.slice(secondHash + 1) : hashBody,
    hashBody,
    window.location.search.replace(/^\?/, ''),
  ]

  const merged = new URLSearchParams()
  for (const chunk of chunks) {
    if (!chunk) continue
    new URLSearchParams(chunk).forEach((value, key) => {
      if (!merged.has(key)) merged.set(key, value)
    })
  }

  const code = merged.get('error_code') ?? merged.get('error')
  if (!code) return null
  if (/otp_expired|access_denied|invalid/i.test(code)) {
    return '重置链接已失效或已被使用，请重新发送找回密码邮件'
  }
  const description = merged.get('error_description')
  return description ? decodeURIComponent(description.replace(/\+/g, ' ')) : '重置链接无效'
}

/** 把地址栏里的 token 清掉（避免刷新页面时重复使用一个已作废的 token）。 */
export function clearRecoveryUrl(): void {
  if (typeof window === 'undefined') return
  window.history.replaceState(null, '', `${window.location.pathname}#${RESET_PATH}`)
}

/** 发送找回密码邮件。无论邮箱是否存在都返回成功，避免被用来探测注册邮箱。 */
export async function requestPasswordReset(email: string): Promise<void> {
  const redirectTo = `${window.location.origin}${window.location.pathname}#${RESET_PATH}`
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo })
  if (error) throw new Error(humanizeAuthError(error.message))
}

/** 用恢复链接里的 token 建立一次性会话（之后才能改密码）。 */
export async function applyRecoverySession(tokens: RecoveryTokens): Promise<void> {
  const { error } = await supabase.auth.setSession({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken ?? '',
  })
  if (error) throw new Error(humanizeAuthError(error.message))
}

/** 改密码（需要已有会话：恢复会话或正常登录会话都行）。 */
export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw new Error(humanizeAuthError(error.message))
  // 改完密码把其它设备踢下线，避免旧密码泄露后一直被登录
  try {
    await supabase.auth.signOut({ scope: 'others' })
  } catch {
    /* 失败不影响主流程 */
  }
}

/**
 * 修改密码：先用当前密码登录验证一次，再更新。
 * （Supabase 没有「校验当前密码」的独立接口，重新 signIn 是官方推荐做法。）
 */
export async function changePasswordWithVerify(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const { data } = await supabase.auth.getUser()
  const email = data.user?.email
  if (!email) throw new Error('登录状态已失效，请重新登录')

  if (currentPassword === newPassword) throw new Error('新密码不能和当前密码相同')

  const { error: verifyError } = await supabase.auth.signInWithPassword({
    email,
    password: currentPassword,
  })
  if (verifyError) {
    if (/invalid login credentials/i.test(verifyError.message)) throw new Error('当前密码不正确')
    throw new Error(humanizeAuthError(verifyError.message))
  }

  await updatePassword(newPassword)
}
