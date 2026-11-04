import { useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { toast } from 'sonner'
import { fetchMyVotes, votePost } from './api'
import type { PageResult } from './api'
import type { Post } from '../types/db'
import { useAuth } from './auth'

/** 列表页也可能同时存在多份帖子缓存，点赞后统一刷新计数 */
const LIST_QUERY_KEYS: string[][] = [['posts'], ['my-posts'], ['my-favorites'], ['author-posts']]

function patchPages(
  old: InfiniteData<PageResult<Post>> | undefined,
  postId: string,
  likeCount: number,
  dislikeCount: number,
): InfiniteData<PageResult<Post>> | undefined {
  if (!old) return old
  return {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === postId
          ? { ...item, like_count: likeCount, dislike_count: dislikeCount }
          : item,
      ),
    })),
  }
}

/**
 * 列表卡片点赞：批量查当前用户对这些帖子的投票，点击时调 vote_post RPC。
 * 返回的 votes 形如 { [postId]: 1 | -1 }，没有记录表示未投票。
 */
export function usePostVotes(postIds: string[]) {
  const { userId } = useAuth()
  const queryClient = useQueryClient()
  const ids = [...postIds].sort()
  const votesKey = ['my-votes', userId ?? '', ids.join(',')]

  const votesQuery = useQuery({
    queryKey: votesKey,
    queryFn: () => fetchMyVotes(ids),
    enabled: Boolean(userId) && ids.length > 0,
    staleTime: 30_000,
  })

  const mutation = useMutation({
    mutationFn: ({ postId, value }: { postId: string; value: number }) =>
      votePost(postId, value),
    onSuccess: (result, vars) => {
      queryClient.setQueryData<Record<string, number>>(votesKey, (old) => {
        const next = { ...(old ?? {}) }
        if (result.my_vote === null) delete next[vars.postId]
        else next[vars.postId] = result.my_vote
        return next
      })
      // 详情页用的是另一套 key（['my-vote', postId, userId]），这里同步写一份，
      // 否则 30s 内从列表点进详情会显示成「没投过票」，再点一次就把赞取消了。
      queryClient.setQueryData(['my-vote', vars.postId, userId], result.my_vote)
      for (const queryKey of LIST_QUERY_KEYS) {
        queryClient.setQueriesData<InfiniteData<PageResult<Post>>>({ queryKey }, (old) =>
          patchPages(old, vars.postId, result.like_count, result.dislike_count),
        )
      }
      queryClient.setQueryData<Post | null>(['post', vars.postId], (old) =>
        old ? { ...old, like_count: result.like_count, dislike_count: result.dislike_count } : old,
      )
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : '点赞失败，请稍后重试')
    },
  })

  const votes = votesQuery.data ?? {}
  const votesReady = votesQuery.isSuccess
  const pendingPostId = mutation.isPending ? mutation.variables?.postId : undefined

  /**
   * 再点一次取消点赞；如果之前是踩，则切换成赞（由数据库 RPC 保证原子性）。
   * 投票状态还没加载完时不允许点：否则可能把「已点赞」误判成「未点赞」而取消掉。
   */
  const toggleLike = (postId: string) => {
    if (!votesReady) return
    mutation.mutate({ postId, value: votes[postId] === 1 ? 0 : 1 })
  }

  return { votes, votesReady, toggleLike, pendingPostId }
}
