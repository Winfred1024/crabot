/**
 * OpenAI Codex OAuth 配置和工具函数
 *
 * Authorization Code + PKCE 流程，参数和 pi-ai / openclaw 完全一致：
 * - redirect_uri 永远是 http://localhost:1455/auth/callback（OpenAI 白名单只有这个）
 * - client_id 用 Codex CLI 公开 ID
 * - originator='openclaw'
 *
 * 两种回调收码方式：
 *   1. 自动：用户浏览器和 Admin 在同一台机器（loopback 访问），本地 1455 server 接住回调
 *   2. 手动：用户从 LAN/远程访问 Admin，本机浏览器打开 auth URL，把回调 URL 粘贴回来
 */

import crypto from 'crypto'
import http from 'http'
import { oauthErrorHtml, oauthSuccessHtml } from './oauth-page.js'

// --- OAuth 配置（和 pi-ai 完全一致） ---

const CALLBACK_PORT = 1455
const CALLBACK_BIND_HOST = '127.0.0.1'
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`
const ORIGINATOR = 'openclaw'

const OAUTH_CONFIG = {
  authorizationEndpoint: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  callbackPort: CALLBACK_PORT,
  scope: 'openid profile email offline_access',
  originator: ORIGINATOR,
}

// --- PKCE ---

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex')
}

// --- JWT 解析 ---

export interface CodexJwtPayload {
  exp?: number
  'https://api.openai.com/profile'?: { email?: string }
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string
  }
}

function decodeJwtPayload(token: string): CodexJwtPayload | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
    return JSON.parse(payload) as CodexJwtPayload
  } catch {
    return null
  }
}

export function extractTokenInfo(accessToken: string): {
  email?: string
  accountId?: string
  expiresAt: number
} {
  const payload = decodeJwtPayload(accessToken)
  if (!payload) {
    return { expiresAt: Date.now() + 3600_000 }
  }

  const profile = payload['https://api.openai.com/profile']
  const auth = payload['https://api.openai.com/auth']

  return {
    email: profile?.email,
    accountId: auth?.chatgpt_account_id,
    expiresAt: payload.exp ? payload.exp * 1000 : Date.now() + 3600_000,
  }
}

// --- OAuth 流程 ---

export interface OAuthLoginResult {
  access_token: string
  refresh_token: string
  expires_at: number
  account_id?: string
  email?: string
}

/**
 * 把 Codex CLI 的 auth.json 文本解析成 OAuthLoginResult。
 *
 * 接受 Codex CLI（~/.codex/auth.json）的标准结构：
 * { tokens: { access_token, refresh_token, account_id, id_token? }, ... }
 *
 * 只做结构 + JWT 解析层的校验，不发网络请求。
 * 网络层校验应单独调 validateChatGPTAccessToken 完成。
 */
export function parseCodexAuthJson(text: string): OAuthLoginResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(`auth.json 不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('auth.json 必须是对象')
  }

  const tokens = (parsed as { tokens?: unknown }).tokens
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('auth.json 缺少 tokens 字段')
  }

  const t = tokens as Record<string, unknown>
  const accessToken = typeof t.access_token === 'string' ? t.access_token : null
  const refreshToken = typeof t.refresh_token === 'string' ? t.refresh_token : null
  const fileAccountId = typeof t.account_id === 'string' ? t.account_id : undefined

  if (!accessToken) {
    throw new Error('auth.json 缺少 tokens.access_token 字段')
  }
  if (!refreshToken) {
    throw new Error('auth.json 缺少 tokens.refresh_token 字段')
  }

  const info = extractTokenInfo(accessToken)
  // extractTokenInfo 在 JWT 解析失败时会回退到 { expiresAt: now + 1h }，
  // 但不会标记失败。这里通过"必须能解出 chatgpt_account_id"反向探测合法性。
  const jwtAccountId = info.accountId
  const accountId = jwtAccountId ?? fileAccountId

  if (!jwtAccountId && !fileAccountId) {
    throw new Error('access_token 无法解析出 chatgpt_account_id，文件可能损坏或不是 Codex CLI 的 auth.json')
  }

  if (info.expiresAt < Date.now()) {
    const ageMin = Math.round((Date.now() - info.expiresAt) / 60_000)
    throw new Error(`access_token 已过期 ${ageMin} 分钟，请在 Codex CLI 上重新登录后再导入`)
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: info.expiresAt,
    account_id: accountId,
    email: info.email,
  }
}

/**
 * 调一次 ChatGPT Codex 后端 /models 端点验证 access_token + account_id 是否被服务端接受。
 *
 * 这一步不可省略：fetchVendorModels 在拉模型失败时会吞错并回退到 default_models，
 * 因此仅靠后续的 createProvider 流程拿不到真实的服务端校验结果。
 *
 * 失败时抛 Error，包含分级错误文案（401/403 / 网络错误 / 未知）。
 */
export async function validateChatGPTAccessToken(
  accessToken: string,
  accountId: string,
): Promise<void> {
  const { resolveCodexClientVersion } = await import('./codex-client-version.js')
  const clientVersion = await resolveCodexClientVersion()
  const url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(clientVersion)}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`无法连接 ChatGPT 后端：${msg}（请检查网络 / 代理）`)
  }

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `token 被服务端拒绝（HTTP ${response.status}）：可能账号已登出所有设备或订阅已失效，请在 Codex CLI 上重新登录` +
      (body ? `。响应：${body.slice(0, 200)}` : ''),
    )
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`ChatGPT 后端返回 HTTP ${response.status}：${body.slice(0, 200) || '未知错误'}`)
  }
}

interface PendingOAuthFlow {
  state: string
  codeVerifier: string
  resolve: (result: OAuthLoginResult) => void
  reject: (error: Error) => void
  server: http.Server
  timeout: ReturnType<typeof setTimeout>
}

let pendingFlow: PendingOAuthFlow | null = null

/**
 * 启动回调服务器，等待 OAuth 回调
 *
 * 自动模式下，本地 1455 server 接住浏览器回调直接 resolve；
 * 手动模式下，调用方应通过 submitManualCallback() 完成同一个 pending flow。
 *
 * 注：1455 端口被占用是 hard error（PORT_IN_USE），即使最终走手动也报错。
 * 因为 OpenAI 白名单只有 localhost:1455，被占就拿不到独占的 callback 通道。
 */
export function waitForOAuthCallback(): Promise<OAuthLoginResult> {
  return new Promise((resolve, reject) => {
    const state = generateState()
    const codeVerifier = generateCodeVerifier()

    if (pendingFlow) {
      pendingFlow.server.close()
      clearTimeout(pendingFlow.timeout)
      pendingFlow.reject(new Error('Superseded by new login attempt'))
    }

    const sendHtml = (res: http.ServerResponse, statusCode: number, body: string): void => {
      res.writeHead(statusCode, {
        'Content-Type': 'text/html; charset=utf-8',
        'Connection': 'close',
      })
      res.end(body)
    }

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${OAUTH_CONFIG.callbackPort}`)

        if (url.pathname === '/__selfcheck') {
          const nonce = url.searchParams.get('nonce') ?? ''
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Connection': 'close' })
          res.end(nonce)
          return
        }

        if (url.pathname !== '/auth/callback') {
          sendHtml(res, 404, oauthErrorHtml('Callback route not found.'))
          return
        }

        const oauthError = url.searchParams.get('error')
        if (oauthError) {
          const errorDesc = url.searchParams.get('error_description') ?? oauthError
          sendHtml(res, 400, oauthErrorHtml(errorDesc))
          cleanup()
          reject(new Error(`OAuth error: ${oauthError}`))
          return
        }

        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')

        if (returnedState !== state) {
          sendHtml(res, 400, oauthErrorHtml('State mismatch.'))
          return
        }

        if (!code) {
          sendHtml(res, 400, oauthErrorHtml('Missing authorization code.'))
          return
        }

        try {
          const tokenResult = await exchangeCodeForToken(code, codeVerifier)
          sendHtml(res, 200, oauthSuccessHtml('OpenAI authentication completed. You can close this window.'))
          cleanup()
          resolve(tokenResult)
        } catch (err) {
          sendHtml(res, 500, oauthErrorHtml(err instanceof Error ? err.message : String(err)))
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      } catch {
        sendHtml(res, 500, oauthErrorHtml('Internal error while processing OAuth callback.'))
      }
    })

    const cleanup = () => {
      if (pendingFlow) {
        clearTimeout(pendingFlow.timeout)
        pendingFlow = null
      }
      server.close()
    }

    // 5 分钟超时
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('OAuth login timed out (5 minutes)'))
    }, 5 * 60 * 1000)

    server.listen(OAUTH_CONFIG.callbackPort, CALLBACK_BIND_HOST, () => {
      // Server ready
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup()
      if (err.code === 'EADDRINUSE') {
        const e = new Error(`Port ${OAUTH_CONFIG.callbackPort} is already in use`) as Error & { code: string }
        e.code = 'PORT_IN_USE'
        reject(e)
      } else {
        reject(new Error(`Failed to start callback server: ${err.message}`))
      }
    })

    pendingFlow = {
      state,
      codeVerifier,
      resolve,
      reject,
      server,
      timeout,
    }
  })
}

/**
 * 获取当前 pending flow 的授权 URL（供 API 返回给前端）
 */
export function getOAuthAuthUrl(): string | null {
  if (!pendingFlow) return null

  const codeChallenge = generateCodeChallenge(pendingFlow.codeVerifier)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: REDIRECT_URI,
    scope: OAUTH_CONFIG.scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state: pendingFlow.state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: OAUTH_CONFIG.originator,
  })

  return `${OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`
}

// --- 手动粘贴回调 ---

/**
 * 解析用户粘贴的回调内容。和 pi-ai parseAuthorizationInput 的接受形式一致：
 *   - 完整 URL：http://localhost:1455/auth/callback?code=...&state=...
 *   - 裸 query 串：code=...&state=...
 *   - code#state 短串
 *   - 仅 code（不推荐，无 state 校验）
 *
 * LAN 场景下粘贴的几乎总是完整 URL。
 */
export function parseManualCallbackInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}

  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      const url = new URL(value)
      return {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
      }
    } catch {
      // 不是合法 URL，继续尝试其他形式
    }
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    }
  }

  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }

  return { code: value }
}

/**
 * 提交用户从浏览器地址栏复制回来的回调（手动模式）。
 * 校验 state，做 token exchange，然后让 waitForOAuthCallback 的 promise resolve。
 */
export async function submitManualCallback(input: string): Promise<OAuthLoginResult> {
  if (!pendingFlow) {
    throw new Error('No pending OAuth flow to submit callback to')
  }

  const { code, state } = parseManualCallbackInput(input)

  if (!code) {
    throw new Error('粘贴内容里没找到 authorization code')
  }
  if (state !== undefined && state !== pendingFlow.state) {
    throw new Error('State mismatch — 粘贴的回调链接和当前登录会话不匹配')
  }

  const flow = pendingFlow
  try {
    const tokenResult = await exchangeCodeForToken(code, flow.codeVerifier)
    flow.server.close()
    clearTimeout(flow.timeout)
    pendingFlow = null
    flow.resolve(tokenResult)
    return tokenResult
  } catch (err) {
    flow.server.close()
    clearTimeout(flow.timeout)
    pendingFlow = null
    const error = err instanceof Error ? err : new Error(String(err))
    flow.reject(error)
    throw error
  }
}

// --- Token 换取 ---

async function exchangeCodeForToken(
  code: string,
  codeVerifier: string,
): Promise<OAuthLoginResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OAUTH_CONFIG.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
  })

  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`)
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    token_type?: string
  }

  const tokenInfo = extractTokenInfo(data.access_token)

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? '',
    expires_at: tokenInfo.expiresAt,
    account_id: tokenInfo.accountId,
    email: tokenInfo.email,
  }
}

// --- Token 刷新 ---

export async function refreshOAuthToken(refreshToken: string): Promise<OAuthLoginResult> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CONFIG.clientId,
  })

  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`)
  }

  const data = await response.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }

  const tokenInfo = extractTokenInfo(data.access_token)

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: tokenInfo.expiresAt,
    account_id: tokenInfo.accountId,
    email: tokenInfo.email,
  }
}

/**
 * 检查 OAuth 登录是否正在进行中
 */
export function isOAuthPending(): boolean {
  return pendingFlow !== null
}

/**
 * 使用 node:http 原生请求（绕过 undici globalDispatcher 代理）验证回调 server 是否属于本实例。
 * 向 callback server 实际可达地址发送 GET，校验响应体是否原样返回该 nonce。
 */
export function selfCheckCallbackServer(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const nonce = crypto.randomBytes(16).toString('hex')
    const req = http.request(
      {
        host: CALLBACK_BIND_HOST,
        port: OAUTH_CONFIG.callbackPort,
        path: `/__selfcheck?nonce=${nonce}`,
        method: 'GET',
        timeout: 2000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          done(res.statusCode === 200 && body === nonce)
        })
      },
    )
    req.on('error', () => done(false))
    req.on('timeout', () => {
      req.destroy()
      done(false)
    })
    req.end()
  })
}

/**
 * 取消当前 pending 的 OAuth 流程
 */
export function cancelOAuthFlow(): void {
  if (pendingFlow) {
    pendingFlow.server.close()
    clearTimeout(pendingFlow.timeout)
    pendingFlow.reject(new Error('OAuth flow cancelled'))
    pendingFlow = null
  }
}
