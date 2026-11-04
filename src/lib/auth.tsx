import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { fetchMyProfile } from './api'
import type { MyProfile } from '../types/db'

interface AuthContextValue {
  session: Session | null
  userId: string | null
  profile: MyProfile | null
  loading: boolean
  /** 已登录但个人资料（含角色）还在加载 —— 管理员路由要等它结束再判断 */
  profileLoading: boolean
  profileError: string | null
  isAdmin: boolean
  isBanned: boolean
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<MyProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)

  const refreshProfile = useCallback(async () => {
    setProfileLoading(true)
    try {
      const next = await fetchMyProfile()
      setProfile(next)
      setProfileError(null)
    } catch (err) {
      setProfile(null)
      setProfileError(err instanceof Error ? err.message : '读取个人资料失败')
    } finally {
      setProfileLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setSession(data.session)
      setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      if (!nextSession) {
        setProfile(null)
        setProfileError(null)
        setProfileLoading(false)
      }
    })

    return () => {
      cancelled = true
      subscription.subscription.unsubscribe()
    }
  }, [])

  // 登录状态变化后拉取自己的完整资料（role / 封禁信息只有 my_profile() 能拿到）
  useEffect(() => {
    if (!session) return
    void refreshProfile()
  }, [session?.user.id, refreshProfile, session])

  useEffect(() => {
    if (!session) queryClient.clear()
  }, [session, queryClient])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setSession(null)
    setProfile(null)
    setProfileLoading(false)
    queryClient.clear()
  }, [queryClient])

  const isBanned = Boolean(
    profile &&
      !profile.is_active &&
      (!profile.banned_until || new Date(profile.banned_until).getTime() > Date.now()),
  )

  // 与后端 is_admin() 保持一致：角色够 + 账号可用。被封禁的版主能进后台页面但所有操作都会失败，
  // 所以在路由守卫这一层就把「不可用账号」挡掉。
  const isAdmin = Boolean(
    profile &&
      (profile.role === 'admin' || profile.role === 'moderator') &&
      profile.is_active &&
      !isBanned,
  )

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      userId: session?.user.id ?? null,
      profile,
      loading,
      profileLoading,
      profileError,
      isAdmin,
      isBanned,
      refreshProfile,
      signOut,
    }),
    [
      session,
      profile,
      loading,
      profileLoading,
      profileError,
      isAdmin,
      isBanned,
      refreshProfile,
      signOut,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用')
  return ctx
}
