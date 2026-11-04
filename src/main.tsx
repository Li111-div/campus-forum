import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import App from './App'
import { ConfigNotice } from './components/ConfigNotice'
import { configError } from './lib/supabase'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // 切回标签页时刷新一次，避免信息流/管理列表长时间停在旧数据
      refetchOnWindowFocus: true,
    },
  },
})

// 配置缺失时直接渲染说明页，不挂载业务页面（否则每个请求都会失败并弹一堆报错）
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {configError ? (
      <ConfigNotice detail={configError} />
    ) : (
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster position="top-center" richColors closeButton toastOptions={{ duration: 2600 }} />
      </QueryClientProvider>
    )}
  </StrictMode>,
)
