import { HashRouter, Outlet, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import { Layout } from './components/Layout'
import { RequireAdmin, RequireAuth } from './components/RequireAuth'
import HomePage from './pages/HomePage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import NewPostPage from './pages/NewPostPage'
import PostDetailPage from './pages/PostDetailPage'
import ProfilePage from './pages/ProfilePage'
import AuthorPage from './pages/AuthorPage'
import NotificationsPage from './pages/NotificationsPage'
import FeedbackPage from './pages/FeedbackPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import FriendsPage from './pages/FriendsPage'
import MessagesPage from './pages/MessagesPage'
import RulesPage from './pages/RulesPage'
import AdminPage from './pages/AdminPage'
import NotFoundPage from './pages/NotFoundPage'

/** 未登录时的统一网关：先看到登录/注册，登录后才能进入论坛。 */
function AuthGate() {
  return (
    <RequireAuth>
      <Outlet />
    </RequireAuth>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            {/* 公开页面：登录、注册、找回密码、社区规则 */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            {/* 重置密码页必须公开：邮件链接带回来的 token 就是未登录态 */}
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/rules" element={<RulesPage />} />

            {/* 需要登录的页面 */}
            <Route element={<AuthGate />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/post/:id" element={<PostDetailPage />} />
              <Route path="/u/:userId" element={<AuthorPage />} />
              <Route path="/me" element={<ProfilePage />} />
              <Route path="/new" element={<NewPostPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/feedback" element={<FeedbackPage />} />
              <Route path="/friends" element={<FriendsPage />} />
              <Route path="/messages" element={<MessagesPage />} />
              <Route path="/messages/:peerId" element={<MessagesPage />} />
            </Route>

            {/* 需要管理员 */}
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <AdminPage />
                </RequireAdmin>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </HashRouter>
    </AuthProvider>
  )
}
