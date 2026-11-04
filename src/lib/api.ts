import { supabase } from './supabase'
import type {
  AuthorProfile,
  Board,
  Comment,
  CommentLikeResult,
  FavoriteResult,
  FollowResult,
  FollowUser,
  MyProfile,
  Notification,
  Post,
  Profile,
  Report,
  ReportInput,
  ReportStatus,
  SortKey,
  VoteResult,
} from '../types/db'

/**
 * 数据访问层。
 * 类型与 supabase/init.sql、docs/数据库-接口契约.md 对齐。
 */

type PostgrestError = { message: string } | null
type Result<T> = { data: T | null; error: PostgrestError }

/** 把 PostgREST 的英文报错翻译成用户能看懂的提示。 */
export function humanize(message: string | null | undefined): string {
  const text = message ?? ''
  if (/Could not find the table|schema cache/i.test(text)) {
    return '数据库还没有初始化：请先在 Supabase SQL Editor 中执行 supabase/init.sql（步骤见 supabase/README.md），然后刷新页面。'
  }
  // 22P02：uuid 之类的参数格式不对（例如手改了地址栏里的 /post/abc）
  if (/invalid input syntax|22P02|invalid_text_representation/i.test(text)) {
    return '内容不存在或链接不正确（参数格式不合法）。'
  }
  if (/permission denied|row-level security|violates row-level/i.test(text)) {
    return '没有权限执行这个操作（数据库已拦截，不是前端问题）。'
  }
  if (/JWT|token is expired|not authenticated/i.test(text)) {
    return '登录状态已失效，请重新登录。'
  }
  if (/timeout|timed out|aborted|abort|failed to fetch|networkerror|fetch failed|network request failed/i.test(text)) {
    return '网络连接超时或无法访问 Supabase：请确认设备能访问 supabase.co 后点重试。'
  }
  return text || '请求失败，请稍后重试'
}

async function unwrap<T>(promise: PromiseLike<Result<T>>): Promise<T> {
  const { data, error } = await promise
  if (error) throw new Error(humanize(error.message))
  return data as T
}

/** RPC 返回单行时 PostgREST 会给数组，这里统一取第一行。 */
function firstRow<T>(data: T | T[] | null): T {
  if (!data) throw new Error('请求失败：数据库没有返回数据')
  return Array.isArray(data) ? (data[0] as T) : (data as T)
}

export const POST_SELECT =
  '*, author:profiles!posts_author_id_fkey(id, display_name, avatar, bio, created_at)'

const COMMENT_SELECT =
  '*, author:profiles!comments_author_id_fkey(id, display_name, avatar, bio, created_at)'

const NOTIFICATION_SELECT =
  '*, actor:profiles!notifications_actor_id_fkey(id, display_name, avatar, bio, created_at), post:posts!notifications_post_id_fkey(id, title)'

export interface PageResult<T> {
  items: T[]
  hasMore: boolean
}

/* ============================== 板块 ============================== */

export async function fetchBoards(): Promise<Board[]> {
  return unwrap(
    supabase.from('boards').select('*').order('sort_order', { ascending: true }),
  ) as Promise<Board[]>
}

/* ============================== 帖子 ============================== */

export interface FetchPostsParams {
  board?: string | null
  sort?: SortKey
  query?: string
  /** 起始时间（含），ISO 字符串；null/undefined = 不限。 */
  since?: string | null
  /** 结束时间（不含），ISO 字符串；null/undefined = 不限。 */
  until?: string | null
  offset?: number
  limit?: number
}

interface SearchPostRow {
  id: string
  board_slug: string
  author_id: string
  title: string
  content: string
  images: string[] | null
  like_count: number
  dislike_count: number
  comment_count: number
  favorite_count: number
  is_pinned: boolean
  is_locked: boolean
  created_at: string
  updated_at: string
  author_display_name: string | null
  author_avatar: string | null
}

export async function fetchPosts({
  board,
  sort = 'new',
  query,
  since = null,
  until = null,
  offset = 0,
  limit = 10,
}: FetchPostsParams = {}): Promise<PageResult<Post>> {
  const q = query?.trim()

  // 有关键词走 RPC（会转义 % _ \，避免 ilike 注入）
  if (q) {
    const rows = await unwrap(
      supabase.rpc('search_posts', {
        p_query: q,
        p_board: board ?? null,
        p_sort: sort,
        p_limit: limit + 1,
        p_offset: offset,
        p_since: since,
        p_until: until,
      }),
    )
    const list = (rows as SearchPostRow[] | null) ?? []
    const hasMore = list.length > limit
    const items: Post[] = list.slice(0, limit).map((row) => ({
      id: row.id,
      board_slug: row.board_slug,
      author_id: row.author_id,
      title: row.title,
      content: row.content,
      images: row.images ?? [],
      like_count: row.like_count,
      dislike_count: row.dislike_count,
      comment_count: row.comment_count,
      favorite_count: row.favorite_count,
      is_pinned: row.is_pinned,
      is_locked: row.is_locked,
      is_deleted: false,
      created_at: row.created_at,
      updated_at: row.updated_at,
      author: row.author_display_name
        ? {
            id: row.author_id,
            display_name: row.author_display_name,
            avatar: row.author_avatar ?? 'avatar-1',
            bio: '',
            created_at: row.created_at,
          }
        : null,
    }))
    return { items, hasMore }
  }

  let builder = supabase.from('posts').select(POST_SELECT).eq('is_deleted', false)

  if (board) builder = builder.eq('board_slug', board)

  // 时间范围：左闭右开，和 search_posts 的 p_since / p_until 语义保持一致
  if (since) builder = builder.gte('created_at', since)
  if (until) builder = builder.lt('created_at', until)

  if (sort === 'hot') {
    // 置顶帖始终最前，其次按赞数、时间
    builder = builder
      .order('is_pinned', { ascending: false })
      .order('like_count', { ascending: false })
      .order('created_at', { ascending: false })
  } else {
    builder = builder
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })
  }

  const rows = (await unwrap(builder.range(offset, offset + limit))) as Post[]
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit), hasMore }
}

export async function fetchPost(id: string): Promise<Post | null> {
  const { data, error } = await supabase
    .from('posts')
    .select(POST_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(humanize(error.message))
  const post = (data as Post | null) ?? null
  // posts_select 允许作者/管理员读到已软删的行；详情页应该显示「已删除」而不是正常渲染，
  // 否则删除后从缓存/直链进来还能点赞、收藏。
  if (post?.is_deleted) return null
  return post
}

export async function fetchPostsByAuthor(
  userId: string,
  offset = 0,
  limit = 10,
): Promise<PageResult<Post>> {
  const rows = (await unwrap(
    supabase.rpc('posts_by_author', {
      p_user_id: userId,
      p_limit: limit + 1,
      p_offset: offset,
    }),
  )) as Post[]
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit), hasMore }
}

export async function fetchMyPosts(
  userId: string,
  offset = 0,
  limit = 10,
): Promise<PageResult<Post>> {
  const rows = (await unwrap(
    supabase
      .from('posts')
      .select(POST_SELECT)
      .eq('author_id', userId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit),
  )) as Post[]
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit), hasMore }
}

export async function fetchMyFavoritePosts(
  offset = 0,
  limit = 10,
): Promise<PageResult<Post>> {
  const rows = (await unwrap(
    supabase
      .from('favorites')
      .select(`post_id, created_at, post:posts!favorites_post_id_fkey(${POST_SELECT})`)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit),
  )) as unknown as Array<{ post: Post | null }>
  // 已删除 / 无权限的帖子会返回 post = null，过滤后条数会变少；
  // hasMore 按原始行数判断，避免「一页只剩 1 条却显示加载更多」
  const posts = rows.map((r) => r.post).filter((p): p is Post => Boolean(p))
  return { items: posts.slice(0, limit), hasMore: rows.length > limit }
}

export interface CreatePostInput {
  board_slug: string
  title: string
  content: string
  images?: string[]
}

export async function createPost(input: CreatePostInput): Promise<Post> {
  const data = await unwrap(
    supabase
      .from('posts')
      .insert({
        board_slug: input.board_slug,
        title: input.title,
        content: input.content,
        images: input.images ?? [],
      })
      .select(POST_SELECT)
      .single(),
  )
  return data as unknown as Post
}

export async function softDeletePost(postId: string): Promise<void> {
  await unwrap(supabase.rpc('soft_delete_post', { p_post_id: postId }))
}

/* ============================== 评论 ============================== */

export async function fetchComments(postId: string): Promise<Comment[]> {
  return unwrap(
    supabase
      .from('comments')
      .select(COMMENT_SELECT)
      .eq('post_id', postId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true })
      // 楼中楼要按 parent_id 组树，必须一次性拿到全量；500 条足够覆盖单个帖子的讨论量，
      // 超过时页面会提示「只显示最早的 500 条」。
      .limit(500),
  ) as Promise<Comment[]>
}

export async function fetchMyComments(userId: string, limit = 50): Promise<Comment[]> {
  return unwrap(
    supabase
      .from('comments')
      .select(`${COMMENT_SELECT}, post:posts!comments_post_id_fkey(id, title)`)
      .eq('author_id', userId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit),
  ) as Promise<Comment[]>
}

export async function createComment(
  postId: string,
  content: string,
  parentId?: string | null,
): Promise<Comment> {
  const data = await unwrap(
    supabase
      .from('comments')
      .insert({ post_id: postId, content, parent_id: parentId ?? null })
      .select(COMMENT_SELECT)
      .single(),
  )
  return data as unknown as Comment
}

export async function softDeleteComment(commentId: string): Promise<void> {
  await unwrap(supabase.rpc('soft_delete_comment', { p_comment_id: commentId }))
}

/** 评论点赞：一次查出当前用户赞过哪些评论（RLS 只返回自己的行）。 */
export async function fetchMyCommentLikes(commentIds: string[]): Promise<Record<string, boolean>> {
  if (commentIds.length === 0) return {}
  const { data, error } = await supabase
    .from('comment_likes')
    .select('comment_id')
    .in('comment_id', commentIds)
  if (error) throw new Error(humanize(error.message))
  const likes: Record<string, boolean> = {}
  for (const row of (data ?? []) as Array<{ comment_id: string }>) {
    likes[row.comment_id] = true
  }
  return likes
}

/** 给评论点赞 / 取消点赞（RPC 原子更新 comments.like_count）。 */
export async function toggleCommentLike(commentId: string): Promise<CommentLikeResult> {
  const data = await unwrap(supabase.rpc('toggle_comment_like', { p_comment_id: commentId }))
  return firstRow<CommentLikeResult>(data as CommentLikeResult | CommentLikeResult[])
}

/* ============================== 互动 ============================== */

export async function fetchMyVote(postId: string, userId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('post_votes')
    .select('value')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(humanize(error.message))
  return (data as { value: number } | null)?.value ?? null
}

/** 列表卡片用：一次查出当前用户对一批帖子的投票（RLS 只返回自己的行）。 */
export async function fetchMyVotes(postIds: string[]): Promise<Record<string, number>> {
  if (postIds.length === 0) return {}
  const { data, error } = await supabase
    .from('post_votes')
    .select('post_id, value')
    .in('post_id', postIds)
  if (error) throw new Error(humanize(error.message))
  const votes: Record<string, number> = {}
  for (const row of (data ?? []) as Array<{ post_id: string; value: number }>) {
    votes[row.post_id] = row.value
  }
  return votes
}

export async function fetchIsFavorite(postId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('favorites')
    .select('post_id')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(humanize(error.message))
  return Boolean(data)
}

export async function votePost(postId: string, value: number): Promise<VoteResult> {
  const data = await unwrap(supabase.rpc('vote_post', { p_post_id: postId, p_value: value }))
  return firstRow<VoteResult>(data as VoteResult | VoteResult[])
}

export async function toggleFavorite(postId: string): Promise<FavoriteResult> {
  const data = await unwrap(supabase.rpc('toggle_favorite', { p_post_id: postId }))
  return firstRow<FavoriteResult>(data as FavoriteResult | FavoriteResult[])
}

export async function toggleFollow(targetId: string): Promise<FollowResult> {
  const data = await unwrap(supabase.rpc('toggle_follow', { p_target_id: targetId }))
  return firstRow<FollowResult>(data as FollowResult | FollowResult[])
}

/* ============================== 用户与关注 ============================== */

export async function fetchMyProfile(): Promise<MyProfile> {
  const data = await unwrap(supabase.rpc('my_profile'))
  return firstRow<MyProfile>(data as MyProfile | MyProfile[])
}

export async function fetchAuthorProfile(userId: string): Promise<AuthorProfile> {
  const data = await unwrap(supabase.rpc('author_profile', { p_user_id: userId }))
  return firstRow<AuthorProfile>(data as AuthorProfile | AuthorProfile[])
}

export async function fetchFollowing(limit = 20, offset = 0): Promise<FollowUser[]> {
  return unwrap(
    supabase.rpc('my_following', { p_limit: limit, p_offset: offset }),
  ) as Promise<FollowUser[]>
}

export async function fetchFollowers(limit = 20, offset = 0): Promise<FollowUser[]> {
  return unwrap(
    supabase.rpc('my_followers', { p_limit: limit, p_offset: offset }),
  ) as Promise<FollowUser[]>
}

export async function updateMyProfile(patch: {
  display_name?: string
  avatar?: string
  bio?: string
}): Promise<void> {
  const { data: sessionData } = await supabase.auth.getUser()
  const userId = sessionData.user?.id
  if (!userId) throw new Error('登录状态已失效，请重新登录')
  const { error } = await supabase.from('profiles').update(patch).eq('id', userId)
  if (error) throw new Error(humanize(error.message))
}

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, avatar, bio, created_at')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw new Error(humanize(error.message))
  return (data as Profile | null) ?? null
}

/* ============================== 通知 ============================== */

export async function fetchNotifications(): Promise<Notification[]> {
  return unwrap(
    supabase
      .from('notifications')
      .select(NOTIFICATION_SELECT)
      .order('created_at', { ascending: false })
      .limit(100),
  ) as Promise<Notification[]>
}

export async function fetchUnreadCount(): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('is_read', false)
  if (error) throw new Error(humanize(error.message))
  return count ?? 0
}

export async function markAllNotificationsRead(): Promise<void> {
  await unwrap(supabase.rpc('mark_all_notifications_read'))
}

/* ============================== 举报 ============================== */

export async function createReport(input: ReportInput): Promise<void> {
  const { error } = await supabase.from('reports').insert({
    target_type: input.target_type,
    target_id: input.target_id,
    reason: input.reason,
    detail: input.detail ?? '',
  })
  if (error) throw new Error(humanize(error.message))
}

/* ============================== 搜索 ============================== */

export async function searchPosts(query: string): Promise<Post[]> {
  const result = await fetchPosts({ query, limit: 20 })
  return result.items
}

/* ============================== 管理员 ============================== */

export async function fetchReports(status?: ReportStatus): Promise<Report[]> {
  let builder = supabase
    .from('reports')
    .select(
      '*, reporter:profiles!reports_reporter_id_fkey(id, display_name, avatar, bio, created_at)',
    )
    .order('created_at', { ascending: false })
    .limit(100)
  if (status) builder = builder.eq('status', status)
  const reports = (await unwrap(builder)) as Report[]
  if (reports.length === 0) return reports

  // 补充被举报对象：评论要知道它在哪个帖子下，帖子/用户要能显示标题/昵称
  const commentIds = [...new Set(reports.filter((r) => r.target_type === 'comment').map((r) => r.target_id))]
  const postIds = [...new Set(reports.filter((r) => r.target_type === 'post').map((r) => r.target_id))]
  const userIds = [...new Set(reports.filter((r) => r.target_type === 'user').map((r) => r.target_id))]

  const comments = commentIds.length
    ? ((await unwrap(
        supabase
          .from('comments')
          .select('id, post_id, content, is_deleted, author_id')
          .in('id', commentIds),
      )) as Report['target_comment'][])
    : []
  const targetPosts = postIds.length
    ? ((await unwrap(supabase.from('posts').select('id, title').in('id', postIds))) as Report['target_post'][])
    : []
  const targetProfiles = userIds.length
    ? ((await unwrap(
        supabase.from('profiles').select('id, display_name').in('id', userIds),
      )) as Report['target_profile'][])
    : []

  const commentMap = new Map((comments ?? []).map((c) => [c!.id, c]))
  const postMap = new Map((targetPosts ?? []).map((p) => [p!.id, p]))
  const profileMap = new Map((targetProfiles ?? []).map((p) => [p!.id, p]))

  return reports.map((report) => ({
    ...report,
    target_comment:
      report.target_type === 'comment' ? (commentMap.get(report.target_id) ?? null) : null,
    target_post: report.target_type === 'post' ? (postMap.get(report.target_id) ?? null) : null,
    target_profile:
      report.target_type === 'user' ? (profileMap.get(report.target_id) ?? null) : null,
  }))
}

/** ilike 的通配符转义：% _ \ 都按字面量匹配（与 search_posts 的口径一致）。 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export async function fetchAdminPosts(keyword?: string, limit = 100): Promise<Post[]> {
  let builder = supabase
    .from('posts')
    .select(POST_SELECT)
    .order('created_at', { ascending: false })
    .limit(limit)
  const q = keyword?.trim()
  if (q) builder = builder.ilike('title', `%${escapeLike(q)}%`)
  return unwrap(builder) as Promise<Post[]>
}

export interface AdminUserRow extends Profile {
  role: MyProfile['role']
  is_active: boolean
  banned_reason: string | null
  banned_until: string | null
  post_count: number
  comment_count: number
  follower_count: number
  username: string | null
}

export async function fetchAdminUsers(keyword?: string): Promise<AdminUserRow[]> {
  // admin_profiles 是数据库侧的视图：内部按 is_admin() 过滤，非管理员查询返回空集
  let builder = supabase
    .from('admin_profiles')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)
  const q = keyword?.trim()
  if (q) builder = builder.ilike('display_name', `%${escapeLike(q)}%`)
  return unwrap(builder) as Promise<AdminUserRow[]>
}

export async function adminSetActive(
  userId: string,
  active: boolean,
  reason?: string,
): Promise<void> {
  await unwrap(
    supabase.rpc('admin_set_active', {
      p_user_id: userId,
      p_active: active,
      p_reason: active ? null : (reason ?? '违反社区规则'),
      p_until: null,
    }),
  )
}

export async function adminSetPinned(postId: string, pinned: boolean): Promise<void> {
  await unwrap(supabase.rpc('admin_set_pinned', { p_post_id: postId, p_pinned: pinned }))
}

export async function adminLockPost(postId: string, locked: boolean): Promise<void> {
  await unwrap(supabase.rpc('admin_lock_post', { p_post_id: postId, p_locked: locked }))
}

export async function adminDeletePost(postId: string): Promise<void> {
  await unwrap(supabase.rpc('admin_soft_delete_post', { p_post_id: postId }))
}

export async function adminResolveReport(
  reportId: string,
  status: Exclude<ReportStatus, 'pending'>,
  note?: string,
): Promise<void> {
  await unwrap(
    supabase.rpc('admin_resolve_report', {
      p_report_id: reportId,
      p_status: status,
      p_note: note ?? null,
    }),
  )
}

/* ============================== 违禁词 ============================== */

export interface BannedWord {
  id: string
  word: string
  note: string | null
  created_at: string
}

/** 预校验一段文本（匿名也可调）：返回命中的违禁词，没命中返回 null。 */
export async function checkBannedWord(text: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('check_banned_word', { p_text: text })
  if (error) throw new Error(humanize(error.message))
  return (data as string | null) ?? null
}

export async function fetchAdminBannedWords(): Promise<BannedWord[]> {
  return unwrap(supabase.rpc('admin_banned_words')) as Promise<BannedWord[]>
}

export async function adminAddBannedWord(word: string, note?: string): Promise<void> {
  await unwrap(supabase.rpc('admin_add_banned_word', { p_word: word, p_note: note ?? null }))
}

export async function adminDeleteBannedWord(id: string): Promise<void> {
  await unwrap(supabase.rpc('admin_delete_banned_word', { p_id: id }))
}

/* ============================== 意见反馈 ============================== */

export const FEEDBACK_CATEGORIES = ['建议', '问题', '其他'] as const
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
export type FeedbackStatus = 'pending' | 'resolved'

export interface FeedbackItem {
  id: string
  category: string
  content: string
  contact: string | null
  status: FeedbackStatus
  created_at: string
  handled_at: string | null
}

export interface AdminFeedbackItem extends FeedbackItem {
  user_id: string
  display_name: string
}

export async function submitFeedback(
  content: string,
  category: string = '建议',
  contact?: string,
): Promise<void> {
  await unwrap(
    supabase.rpc('submit_feedback', {
      p_content: content,
      p_category: category,
      p_contact: contact?.trim() ? contact.trim() : null,
    }),
  )
}

export async function fetchMyFeedback(): Promise<FeedbackItem[]> {
  return unwrap(supabase.rpc('my_feedback')) as Promise<FeedbackItem[]>
}

export async function fetchAdminFeedback(status?: FeedbackStatus | null): Promise<AdminFeedbackItem[]> {
  return unwrap(supabase.rpc('admin_feedback', { p_status: status ?? null })) as Promise<AdminFeedbackItem[]>
}

export async function adminResolveFeedback(id: string, status: FeedbackStatus): Promise<void> {
  await unwrap(supabase.rpc('admin_resolve_feedback', { p_id: id, p_status: status }))
}


/* ============================== 好友 / 私信（二期） ============================== */

export type SocialRelation = 'self' | 'none' | 'friend' | 'half' | 'blocked' | 'blockedBy'

export interface UserSearchItem {
  user_id: string
  display_name: string
  avatar: string | null
  relation: SocialRelation
}

export interface FriendItem {
  friend_id: string
  display_name: string
  avatar: string | null
  bio: string
  since: string
  relation: SocialRelation
}

export interface FriendRequestItem {
  request_id: string
  direction: 'incoming' | 'outgoing'
  peer_id: string
  peer_name: string
  peer_avatar: string | null
  message: string
  status: string
  created_at: string
}

export interface ConversationItem {
  conversation_id: string
  peer_id: string
  peer_name: string
  peer_avatar: string | null
  last_content: string | null
  last_at: string
  unread_count: number
}

export interface DMMessage {
  seq: number
  sender_id: string
  content: string
  is_read: boolean
  created_at: string
}

export interface SocialBadges {
  pending_requests: number
  unread_dms: number
}

/** 搜人：关键词至少 2 个字才有结果（数据库侧限制）。 */
export async function searchUsers(keyword: string): Promise<UserSearchItem[]> {
  return unwrap(
    supabase.rpc('search_users', { p_keyword: keyword.trim(), p_limit: 20 }),
  ) as Promise<UserSearchItem[]>
}

/** 我与某个用户的关系，作者主页用来决定显示哪个按钮。 */
export async function fetchUserRelation(userId: string): Promise<SocialRelation> {
  const data = await unwrap(supabase.rpc('user_relation', { p_user_id: userId }))
  return (data as SocialRelation | null) ?? 'none'
}

export async function sendFriendRequest(to: string, message?: string): Promise<void> {
  await unwrap(
    supabase.rpc('send_friend_request', { p_to: to, p_message: message?.trim() ?? '' }),
  )
}

export async function respondFriendRequest(requestId: string, accept: boolean): Promise<void> {
  await unwrap(
    supabase.rpc('respond_friend_request', { p_request_id: requestId, p_accept: accept }),
  )
}

export async function fetchFriendRequests(): Promise<FriendRequestItem[]> {
  return unwrap(supabase.rpc('my_friend_requests')) as Promise<FriendRequestItem[]>
}

export async function fetchFriends(): Promise<FriendItem[]> {
  return unwrap(supabase.rpc('my_friends')) as Promise<FriendItem[]>
}

export async function removeFriend(friendId: string): Promise<void> {
  await unwrap(supabase.rpc('remove_friend', { p_friend_id: friendId }))
}

export async function setFriendBlock(friendId: string, blocked: boolean): Promise<void> {
  await unwrap(
    supabase.rpc('set_friend_block', { p_friend_id: friendId, p_blocked: blocked }),
  )
}

export async function fetchConversations(): Promise<ConversationItem[]> {
  return unwrap(supabase.rpc('my_conversations')) as Promise<ConversationItem[]>
}

/** 拉消息：p_after_seq 传已拿到的最大 seq，只取增量。 */
export async function fetchDMMessages(
  conversationId: string,
  afterSeq = 0,
): Promise<DMMessage[]> {
  return unwrap(
    supabase.rpc('dm_messages', { p_conversation_id: conversationId, p_after_seq: afterSeq }),
  ) as Promise<DMMessage[]>
}

export async function sendDM(to: string, content: string): Promise<void> {
  await unwrap(supabase.rpc('send_dm', { p_to: to, p_content: content.trim() }))
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await unwrap(supabase.rpc('mark_conversation_read', { p_conversation_id: conversationId }))
}

export async function fetchSocialBadges(): Promise<SocialBadges> {
  const data = await unwrap(supabase.rpc('social_badges'))
  const row = Array.isArray(data) ? data[0] : data
  return {
    pending_requests: Number(row?.pending_requests ?? 0),
    unread_dms: Number(row?.unread_dms ?? 0),
  }
}
