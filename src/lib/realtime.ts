import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'

/**
 * Realtime 桥：登录后挂一次，把「通知」和「私信」的数据库变更直接推成缓存失效，
 * 页面不用轮询就能拿到新数据。
 *
 * 依赖数据库侧的两件事（见 migrations/20261102000009_realtime.sql）：
 *   1) notifications / conversations / direct_messages 已加入 supabase_realtime 发布
 *   2) 三张表都有 SELECT 的 RLS 策略（Realtime 会按策略过滤行，没有策略就收不到）
 *
 * 注意：Realtime 只是「加速通道」，各页面仍保留低频轮询兜底，
 * 断线重连或策略变更时不会彻底收不到消息。
 */
export function useRealtimeBridge(userId: string | null) {
  const queryClient = useQueryClient()
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!userId) {
      setConnected(false)
      return
    }

    const channels: RealtimeChannel[] = []

    // ① 通知：新通知 / 已读状态变化 → 刷新通知列表与红点
    const notifyChannel = supabase
      .channel(`rt:notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['notifications'] })
          void queryClient.invalidateQueries({ queryKey: ['unread-count'] })
        },
      )
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'))
    channels.push(notifyChannel)

    // ② 私信：新消息 / 新会话 → 刷新聊天记录、会话列表、私信红点
    const dmChannel = supabase
      .channel(`rt:direct_messages:${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'direct_messages' },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['dm-messages'] })
          void queryClient.invalidateQueries({ queryKey: ['conversations'] })
          void queryClient.invalidateQueries({ queryKey: ['social-badges'] })
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'conversations' },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['conversations'] })
          void queryClient.invalidateQueries({ queryKey: ['social-badges'] })
        },
      )
      .subscribe()
    channels.push(dmChannel)

    return () => {
      for (const channel of channels) void supabase.removeChannel(channel)
      setConnected(false)
    }
  }, [userId, queryClient])

  return { connected }
}
