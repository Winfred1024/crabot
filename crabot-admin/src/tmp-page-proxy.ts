import http, { type IncomingMessage, type ServerResponse } from 'node:http'

/**
 * 把 /tmp-pages/* 请求纯透明转发到 127.0.0.1:<port>（agent 起的 tmp-page server）。
 * 不鉴权（匿名访问）。目标地址硬编码 127.0.0.1 + 固定端口，URL 不参与上游决策（无 SSRF）。
 */
export function proxyTmpPage(
  req: IncomingMessage,
  res: ServerResponse,
  tmpPagePort: number,
): Promise<void> {
  return new Promise((resolve) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: tmpPagePort,
        method: req.method,
        path: req.url,
        headers: req.headers,
        timeout: 10_000,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
        upRes.on('end', () => resolve())
        // 上游响应头已写出后中途断连：销毁下游连接，避免未处理的 error 冒泡
        upRes.on('error', () => { res.destroy(); resolve() })
      },
    )
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' })
      }
      res.end('<!DOCTYPE html><html><body style="font-family:system-ui;padding:2rem">'
        + '<h2>页面已失效或服务未启动</h2></body></html>')
      resolve()
    })
    upstream.on('timeout', () => upstream.destroy())
    req.pipe(upstream)
  })
}

/**
 * 判断路径是否命中 _manage 管理端点（应仅 agent 本机直连 127.0.0.1:<port>，不经公网反代）。
 * 必须先归一化连续斜杠再判：否则 `/tmp-pages//_manage/list` 这类绕过——admin 守卫漏判 →
 * 照常反代 → server.cjs 用 split('/').filter(Boolean) 折叠空段后仍命中 _manage → 匿名枚举/删除泄露。
 */
export function isManagePath(pathname: string): boolean {
  return pathname.replace(/\/{2,}/g, '/').startsWith('/tmp-pages/_manage')
}

/** 解析对外 base URL：env 优先，去尾斜杠；未配置退化为本地 web 地址 */
export function resolveTmpPageBaseUrl(
  envBaseUrl: string | undefined,
  webPort: number,
): string {
  if (envBaseUrl && envBaseUrl.trim()) {
    return envBaseUrl.trim().replace(/\/+$/, '')
  }
  return `http://localhost:${webPort}`
}
