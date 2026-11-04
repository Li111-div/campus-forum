/** 与 supabase/init.sql 的列名一一对应。 */

export type UserRole = 'user' | 'moderator' | 'admin'
export type NotificationType = 'comment' | 'reply' | 'like' | 'system' | 'follow_post'
export type ReportStatus = 'pending' | 'resolved' | 'rejected'
export type ReportTarget = 'post' | 'comment' | 'user'
export type SortKey = 'new' | 'hot'

export interface Board {
  slug: string
  name: string
  description: string
  icon: string
  accent: string
  sort_order: number
  is_anonymous: boolean
  is_locked: boolean
  created_at: string
}

/** 公开可见的用户资料（id / display_name / avatar / bio / created_at）。 */
export interface Profile {
  id: string
  display_name: string
  avatar: string
  bio: string
  created_at: string
}

export interface Post {
  id: string
  board_slug: string
  author_id: string
  title: string
  content: string
  images: string[]
  like_count: number
  dislike_count: number
  comment_count: number
  favorite_count: number
  is_pinned: boolean
  is_locked: boolean
  is_deleted: boolean
  created_at: string
  updated_at: string
  author?: Profile | null
}

export interface Comment {
  id: string
  post_id: string
  author_id: string
  parent_id: string | null
  content: string
  is_deleted: boolean
  like_count: number
  created_at: string
  updated_at: string
  author?: Profile | null
  post?: Pick<Post, 'id' | 'title'> | null
}

export interface Notification {
  id: string
  user_id: string
  type: NotificationType
  post_id: string | null
  comment_id: string | null
  actor_id: string | null
  is_read: boolean
  created_at: string
  actor?: Profile | null
  post?: Pick<Post, 'id' | 'title'> | null
}

export interface Report {
  id: string
  reporter_id: string
  target_type: ReportTarget
  target_id: string
  reason: string
  detail: string
  status: ReportStatus
  handled_by: string | null
  handled_at: string | null
  resolution_note: string | null
  created_at: string
  reporter?: Profile | null
  /** 管理员列表里由 api.fetchReports 补充的被举报对象信息 */
  target_comment?: {
    id: string
    post_id: string
    content: string
    is_deleted: boolean
    author_id: string
  } | null
  target_post?: { id: string; title: string } | null
  target_profile?: { id: string; display_name: string } | null
}

/** my_profile() 的返回：只有本人能拿到 role / 封禁信息 / username。 */
export interface MyProfile extends Profile {
  role: UserRole
  is_active: boolean
  banned_reason: string | null
  banned_until: string | null
  updated_at: string
  username: string | null
}

/** author_profile() 的返回：公开字段 + 关注计数。 */
export interface AuthorProfile {
  user_id: string
  display_name: string
  avatar: string
  bio: string
  created_at: string
  post_count: number
  follower_count: number
  following_count: number
  is_following: boolean
  is_me: boolean
}

export interface FollowUser {
  user_id: string
  display_name: string
  avatar: string
  bio: string
  followed_at: string
}

export interface VoteResult {
  like_count: number
  dislike_count: number
  my_vote: number | null
}

/** 评论点赞 RPC 的返回：当前赞数 + 我是否已赞。 */
export interface CommentLikeResult {
  like_count: number
  liked: boolean
}

export interface FavoriteResult {
  favorited: boolean
  favorite_count: number
}

export interface FollowResult {
  following: boolean
  follower_count: number
}

export interface ReportInput {
  target_type: ReportTarget
  target_id: string
  reason: string
  detail?: string
}
