/**
 * 不含密钥导出时，把敏感字段替换成占位符。
 * 字段名以 types.ts 的 ModelProvider/OAuthCredential 为准。
 * 设计依据：2026-06-19-crabot-backup-migration-design.md §6.2
 */

export const SECRET_PLACEHOLDER = ''

/** key 名包含这些子串（大小写不敏感）视为 channel secret。 */
const CHANNEL_SECRET_HINTS = ['api_key', 'secret', 'token', 'password']

function isChannelSecretKey(key: string): boolean {
  const lower = key.toLowerCase()
  return CHANNEL_SECRET_HINTS.some((h) => lower.includes(h))
}

/** 置空 model_providers.json 里每个 provider 的 api_key 与 oauth token。 */
export function scrubProvidersJson(raw: string): string {
  const arr = JSON.parse(raw) as Array<Record<string, unknown>>
  const scrubbed = arr.map((p) => {
    const next: Record<string, unknown> = { ...p, api_key: SECRET_PLACEHOLDER }
    if (p.oauth_credential && typeof p.oauth_credential === 'object') {
      next.oauth_credential = {
        ...(p.oauth_credential as Record<string, unknown>),
        access_token: SECRET_PLACEHOLDER,
        refresh_token: SECRET_PLACEHOLDER,
      }
    }
    return next
  })
  return JSON.stringify(scrubbed, null, 2)
}

/** 置空单个 channel config 文件里看着像 secret 的字段。 */
export function scrubChannelConfigJson(raw: string): string {
  const obj = JSON.parse(raw) as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    next[k] = isChannelSecretKey(k) && typeof v === 'string' ? SECRET_PLACEHOLDER : v
  }
  return JSON.stringify(next, null, 2)
}
