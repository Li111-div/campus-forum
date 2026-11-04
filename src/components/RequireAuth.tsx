import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { Spinner } from './ui'

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) return <Spinner label="正在确认登录状态…" />
  if (!session) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    )
  }
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, loading, profile, profileLoading, isAdmin, profileError } = useAuth()
  const location = useLocation()

  if (loading || (session && profileLoading)) return <Spinner label="正在确认权限…" />
  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  if (profileError) {
    return (
      <div className="rounded-card border border-amber-100 bg-amber-50/70 p-6 text-sm text-amber-700">
        无法读取管理员权限：{profileError}
      </div>
    )
  }
  if (!profile) return <Spinner label="正在确认权限…" />
  if (!isAdmin) {
    return <Navigate to="/" replace />
  }
  return <>{children}</>
}
