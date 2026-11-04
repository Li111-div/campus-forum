import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/**
 * 缺失的配置项（空数组表示配置齐全）。
 *
 * 不在模块加载阶段直接 throw —— 那样线上少配一个变量就是白屏 + 控制台报错，
 * 部署的人很难查。改成把缺失项交给 main.tsx 渲染成「配置说明页」。
 */
export const missingConfig: string[] = [
  ...(url ? [] : ['VITE_SUPABASE_URL']),
  ...(key ? [] : ['VITE_SUPABASE_ANON_KEY']),
]

/** 配置齐全才为 null；否则是给 <ConfigNotice> 用的缺失列表 */
export const configError = missingConfig.length > 0 ? missingConfig : null

const FETCH_TIMEOUT_MS = 20_000

/**
 * 给所有 Supabase 请求加 20 秒超时：
 * 网络不通 / 被防火墙拦住时不会一直转圈，而是走到页面的错误态（可点重试）。
 */
const fetchWithTimeout: typeof fetch = (input, init) => {
  if (init?.signal) return fetch(input, init)
  return fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

/**
 * 浏览器端只使用 publishable / anon key。
 * 所有权限校验都在数据库里（RLS + 列级 GRANT + RPC），前端隐藏按钮不算安全边界。
 *
 * 配置缺失时用占位地址创建一个「不会真的被调用」的客户端：
 * 因为此时 main.tsx 渲染的是配置说明页，不会挂载业务页面，也就不会发出请求。
 */
export const supabase = createClient(url ?? 'https://placeholder.supabase.co', key ?? 'placeholder-anon-key', {
  global: { fetch: fetchWithTimeout },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

export const SUPABASE_URL = url ?? ''
