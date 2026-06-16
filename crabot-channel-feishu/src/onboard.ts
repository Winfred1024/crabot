/**
 * 飞书扫码 onboarding（设备码 OAuth）
 *
 * 由 admin 在用户进入 onboarding 流程时 require()，不通过 RPC 暴露。
 * 实现 base-protocol §10 的 Onboarder 接口。
 *
 * 端点来源参考：@larksuite/openclaw-lark-tools v1.0.40 (utils/feishu-auth.js)
 *   POST https://accounts.feishu.cn/oauth/v1/app/registration  (国际版：accounts.larksuite.com)
 *   body Content-Type: application/x-www-form-urlencoded
 *   action ∈ init | begin | poll
 *
 * 注：是 accounts.* 账号网关，不是 open.* OpenAPI 网关。
 */

import { randomUUID } from 'node:crypto'
import type {
  Onboarder,
  OnboarderBeginResult,
  OnboarderEvent,
  OnboarderFactory,
  OnboarderFinishResult,
} from 'crabot-shared'
import { SUBSCRIBED_EVENTS } from './feishu-channel.js'

type Brand = 'feishu' | 'lark'

interface OnboardSession {
  device_code: string
  base_url: string
  domain: Brand
  interval: number
  expires_at: number
  result?: { app_id: string; app_secret: string; open_id: string; domain: Brand }
}

export interface FeishuOnboarderOptions {
  /** 注入 fetch 用于测试 */
  fetchImpl?: typeof fetch
  /** 注入 delay 用于测试（避免真实 setTimeout 阻塞） */
  delayMs?: (ms: number) => Promise<void>
}

export const ONBOARD_SCOPES: readonly string[] = [
  // IM — 必備
  'im:message',
  'im:message:send_as_bot',
  // im:chat（读+写，含 group_info / members 全部子权限）。
  // 用 :readonly 也能跑当前实现（getChatMembers / listChats / getChat），但飞书
  // 后端有时对 :readonly 的开通流程有 UI 陷阱（默认勾选但要手动提交开通）；
  // 直接用 im:chat 一档到位，未来扩展加群成员 / 改群名也不必再走一遍 scope_grant_url。
  'im:chat',
  'im:resource',
  // 联系人 — 必备
  'contact:user.base:readonly',
  'contact:contact.base:readonly',
  // 云文档只读 — 必备（P1）
  'docx:document:readonly',
  'wiki:wiki:readonly',
  'sheets:spreadsheet:readonly',
  // 前瞻只读
  'bitable:app:readonly',
  'vc:meeting:readonly',
  'calendar:calendar:readonly',
  // 2026-06-16 放开 drive 读：大文件被飞书自动转 drive，命中率高
  'drive:drive:readonly',
  // 已砍：minutes:minutes:readonly（飞书侧标"需审核权限"，feishu-doc-reader 暂未实现妙记读取，要的话以后单独申请）
]

export function buildScopeGrantUrl(appId: string, domain: Brand, scopes: readonly string[] = ONBOARD_SCOPES): string {
  const q = scopes.join(',')
  return `${OPEN_BY_DOMAIN[domain]}/app/${appId}/auth?q=${encodeURIComponent(q)}&op_from=openapi&token_type=tenant`
}

const SESSION_TTL_MS = 10 * 60 * 1000
const GC_INTERVAL_MS = 60 * 1000

// 设备码 OAuth host（注：不是 open.* 的 OpenAPI 网关，是 accounts.* 的账号网关）
const BASE_BY_DOMAIN: Record<Brand, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
}

const OPEN_BY_DOMAIN: Record<Brand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
}

export function buildEventSubscriptionUrl(appId: string, domain: Brand): string {
  return `${OPEN_BY_DOMAIN[domain]}/app/${appId}/event`
}

export function buildEventSubscriptionGuide(appId: string, domain: Brand) {
  return {
    url: buildEventSubscriptionUrl(appId, domain),
    events: SUBSCRIBED_EVENTS,
    extra_instructions: [
      '飞书扫码后默认只订了「接收消息」事件。我们 Crabot 用到的另外 5 个（机器人进出群 / 用户进出群 / 群信息修改）必须在这里手动添加。',
      '飞书的 scope 和事件订阅是两件事：scope 决定 API 能调用，事件订阅决定事件会不会推过来，缺一不可。',
      '添加事件后必须发版才生效：进入「应用发布 → 版本管理与发布」点击右上角「创建版本」并提交。即便测试企业免审场景也要走这一步。',
    ],
  }
}

export class FeishuOnboarder implements Onboarder {
  private sessions = new Map<string, OnboardSession>()
  private gcTimer: NodeJS.Timeout | null = null
  private fetchImpl: typeof fetch
  private delay: (ms: number) => Promise<void>

  constructor(opts: FeishuOnboarderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.delay = opts.delayMs ?? defaultDelay
  }

  startGc(): void {
    if (this.gcTimer) return
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS)
    if (this.gcTimer && typeof this.gcTimer === 'object' && 'unref' in this.gcTimer) {
      ;(this.gcTimer as NodeJS.Timeout).unref()
    }
  }

  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer)
      this.gcTimer = null
    }
  }

  async begin(params?: { domain?: Brand }): Promise<OnboarderBeginResult> {
    const domain: Brand = params?.domain === 'lark' ? 'lark' : 'feishu'
    const baseUrl = BASE_BY_DOMAIN[domain]

    const initResp = await this.callRegistration(baseUrl, { action: 'init' })
    const methods = (initResp.supported_auth_methods as string[] | undefined) ?? []
    if (!methods.includes('client_secret')) {
      throw new Error(`飞书 OAuth 不支持 client_secret 模式（supported=${methods.join(',') || '无'}）`)
    }

    const beginResp = await this.callRegistration(baseUrl, {
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      request_user_info: 'open_id',
    })
    const deviceCode = beginResp.device_code as string | undefined
    const verifUri = beginResp.verification_uri_complete as string | undefined
    if (!deviceCode || !verifUri) {
      throw new Error('飞书 OAuth begin 响应缺少 device_code / verification_uri_complete')
    }
    const interval = Number(beginResp.interval) || 5
    // 飞书实际返回 expires_in；npm 包源码错把它写成 expire_in，两个字段都兼容
    const expireIn = Number(beginResp.expires_in ?? beginResp.expire_in) || 3600

    const sessionId = randomUUID()
    const expiresAt = Date.now() + expireIn * 1000
    this.sessions.set(sessionId, {
      device_code: deviceCode,
      base_url: baseUrl,
      domain,
      interval,
      expires_at: expiresAt,
    })

    return {
      session_id: sessionId,
      ui_mode: 'qrcode',
      verification_uri: appendFromOnboard(verifUri),
      interval,
      expires_at: expiresAt,
      display: {
        title: domain === 'lark' ? 'Lark 扫码授权' : '飞书扫码授权',
        description: '在飞书 / Lark App 内"扫一扫"，授权后将自动建 Bot',
      },
    }
  }

  async *poll(sessionId: string): AsyncIterable<OnboarderEvent> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      yield { type: 'error', code: 'session_not_found' }
      return
    }

    let interval = session.interval

    while (true) {
      if (Date.now() > session.expires_at) {
        yield { type: 'error', code: 'expired_token' }
        return
      }

      let resp: Record<string, unknown>
      try {
        resp = await this.callRegistration(session.base_url, {
          action: 'poll',
          device_code: session.device_code,
        })
      } catch (err) {
        yield { type: 'error', code: 'unknown', message: err instanceof Error ? err.message : String(err) }
        return
      }

      const errCode = (resp.error as string | undefined) ?? ''
      const clientId = resp.client_id as string | undefined
      const clientSecret = resp.client_secret as string | undefined

      if (clientId && clientSecret) {
        const userInfo = (resp.user_info as Record<string, unknown> | undefined) ?? {}
        const openId = (userInfo.open_id as string | undefined) ?? ''
        const tenantBrand = (userInfo.tenant_brand as string | undefined) ?? ''
        const domain: Brand = tenantBrand === 'lark' ? 'lark' : session.domain
        session.result = { app_id: clientId, app_secret: clientSecret, open_id: openId, domain }
        yield { type: 'success' }
        return
      }

      if (errCode === 'authorization_pending' || errCode === '') {
        yield { type: 'pending' }
      } else if (errCode === 'slow_down') {
        interval += 5
        yield { type: 'slow_down' }
      } else if (errCode === 'access_denied') {
        yield { type: 'error', code: 'access_denied' }
        return
      } else if (errCode === 'expired_token') {
        yield { type: 'error', code: 'expired_token' }
        return
      } else {
        yield { type: 'error', code: 'unknown', message: (resp.error_description as string | undefined) ?? errCode }
        return
      }

      await this.delay(interval * 1000)
    }
  }

  async finish(sessionId: string, _params?: Record<string, unknown>): Promise<OnboarderFinishResult> {
    const session = this.sessions.get(sessionId)
    if (!session?.result) throw new Error('会话不存在或尚未完成扫码')
    const { app_id, app_secret, open_id, domain } = session.result
    const env: Record<string, string> = {
      FEISHU_APP_ID: app_id,
      FEISHU_APP_SECRET: app_secret,
      FEISHU_DOMAIN: domain,
      FEISHU_ONLY_RESPOND_TO_MENTIONS: 'true',
    }
    if (open_id) env.FEISHU_OWNER_OPEN_ID = open_id
    this.sessions.delete(sessionId)
    return {
      env,
      suggested_name: undefined,
      scope_grant_url: buildScopeGrantUrl(app_id, domain),
      event_subscription: buildEventSubscriptionGuide(app_id, domain),
    }
  }

  cancel(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private async callRegistration(baseUrl: string, body: Record<string, string>): Promise<Record<string, unknown>> {
    const params = new URLSearchParams(body)
    const resp = await this.fetchImpl(`${baseUrl}/oauth/v1/app/registration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    let json: Record<string, unknown> = {}
    try {
      json = (await resp.json()) as Record<string, unknown>
    } catch {
      // ignore
    }
    if (!resp.ok && !json.error) {
      throw new Error(`飞书 OAuth ${body.action} 请求失败: HTTP ${resp.status}`)
    }
    return json
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (s.expires_at + SESSION_TTL_MS < now) this.sessions.delete(id)
    }
  }
}

/** Onboarder 工厂——admin 通过该函数创建实例 */
export const createOnboarder: OnboarderFactory = () => new FeishuOnboarder()

function appendFromOnboard(uri: string): string {
  const sep = uri.includes('?') ? '&' : '?'
  return `${uri}${sep}from=onboard`
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
