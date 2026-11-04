import { AlertTriangle, ExternalLink } from 'lucide-react'

/**
 * 配置缺失时的兜底页面。
 *
 * 之前 supabase.ts 在模块加载阶段直接 throw，结果：白屏 + 控制台一行报错，
 * 第一次部署（尤其 GitHub Pages 忘了配 Secrets）的人根本看不出哪里错了。
 * 现在渲染成一张说明页，把「缺哪个变量、去哪填」直接写在脸上。
 */
export function ConfigNotice({ detail }: { detail: string[] }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="card w-full max-w-2xl p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-amber-500">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-ink">缺少运行配置</h1>
            <p className="text-xs text-ink-muted">校园论坛需要 Supabase 的连接信息才能启动</p>
          </div>
        </div>

        <div className="mt-5 rounded-xl bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-700">
          没有检测到：
          {detail.map((name) => (
            <code key={name} className="mx-1 rounded bg-white px-1.5 py-0.5 font-mono text-[12px]">
              {name}
            </code>
          ))}
        </div>

        <div className="mt-6 space-y-5 text-sm leading-6 text-ink-soft">
          <div>
            <p className="font-medium text-ink">① 本地开发</p>
            <p className="mt-1 text-ink-muted">
              在项目根目录建 <code className="rounded bg-slate-100 px-1 font-mono text-[12px]">.env.local</code>
              ，填入下面三项，然后重启 <code className="rounded bg-slate-100 px-1 font-mono text-[12px]">npm run dev</code>：
            </p>
            <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-900 px-4 py-3 text-[12px] leading-5 text-slate-100">
              {`VITE_SUPABASE_URL=https://<项目 ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
VITE_IMGBB_API_KEY=<ImgBB 图床密钥，可留空>`}
            </pre>
          </div>

          <div>
            <p className="font-medium text-ink">② 部署到 GitHub Pages</p>
            <p className="mt-1 text-ink-muted">
              前端变量是<strong className="text-ink">构建期</strong>写进包的，
              <code className="rounded bg-slate-100 px-1 font-mono text-[12px]">.env.local</code>
              不会进仓库。要在仓库 <span className="font-medium text-ink">Settings → Secrets and variables → Actions</span>
              里添加同名 Secret，工作流会在构建时注入。
            </p>
          </div>

          <div>
            <p className="font-medium text-ink">③ 数据库</p>
            <p className="mt-1 text-ink-muted">
              Supabase 项目里要先执行 <code className="rounded bg-slate-100 px-1 font-mono text-[12px]">supabase/init.sql</code>
              （或 <code className="rounded bg-slate-100 px-1 font-mono text-[12px]">npm run db:migrate</code>）建好表和策略。
            </p>
          </div>
        </div>

        <a
          href="https://supabase.com/dashboard/project/_/settings/api"
          target="_blank"
          rel="noreferrer noopener"
          className="mt-6 inline-flex items-center gap-1.5 rounded-control bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-500"
        >
          打开 Supabase 拿 API Key
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  )
}
