import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { fetchMyCommentLikes, toggleCommentLike } from './api'
import type { Comment } from '../types/db'
import { useAuth } from './auth'

/**
 * 评论点赞：批量查当前用户赞过哪些评论，点击时调 toggle_comment_like RPC。
 * 返回的 likes 形如 { [commentId]: true }，没有记录表示没赞过。
 */
export function useCommentLikes(postId: string, commentIds: string[]) {
  const { userId } = useAuth()
  const queryClient = useQueryClient()
  const ids = [...commentIds].sort()
  const likesKey = ['my-comment-likes', userId ?? '', postId, ids.join(',')]

  const likesQuery = useQuery({
    queryKey: likesKey,
    queryFn: () => fetchMyCommentLikes(ids),
    enabled: Boolean(userId) && ids.length > 0,
    staleTime: 30_000,
  })

  const mutation = useMutation({
    mutationFn: (commentId: string) => toggleCommentLike(commentId),
    onSuccess: (result, commentId) => {
      queryClient.setQueryData<Record<string, boolean>>(likesKey, (old) => {
        const next = { ...(old ?? {}) }
        if (result.liked) next[commentId] = true
        else delete next[commentId]
        return next
      })
      // 计数用 RPC 返回值直接写进评论缓存，避免整页重新请求
      queryClient.setQueryData<Comment[]>(['comments', postId], (old) =>
        old ? old.map((comment) => (comment.id === commentId ? { ...comment, like_count: result.like_count } : comment)) : old,
      )
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '点赞失败，请稍后重试')
    },
  })

  const likes = likesQuery.data ?? {}
  const likesReady = likesQuery.isSuccess
  const pendingCommentId = mutation.isPending ? mutation.variables : undefined

  /** 再点一次取消点赞；状态没加载完时不允许点，避免误判。 */
  const toggleLike = (commentId: string) => {
    if (!likesReady) return
    mutation.mutate(commentId)
  }

  return { likes, likesReady, toggleLike, pendingCommentId }
}
