import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 静态托管（GitHub Pages / 任意子路径）下用相对 base；路由用 HashRouter，不需要 404 回退
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    // 局域网测试：监听所有网卡，同网段设备可用 http://<本机IP>:5173 访问
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // 允许用 IP / 局域网主机名访问（Vite 默认只放行 localhost）
    allowedHosts: true,
    watch: {
      // 验收脚本产生的目录不需要热更新，避免文件锁报 EBUSY
      ignored: ['**/.chrome-profile*/**', '**/.shots/**', '**/.npm-cache/**', '**/dist/**'],
    },
  },
  preview: {
    // npm run lan：用构建产物起一个给同学访问的静态服务器
    host: '0.0.0.0',
    port: 8080,
    strictPort: true,
    allowedHosts: true,
  },
})
