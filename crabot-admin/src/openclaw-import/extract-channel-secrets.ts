/**
 * 从 OpenClaw channels.accounts 提取某账号的明文 secret（仅执行期用，不进概览/UI）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.2
 * SecretRef 引用类解析为 undefined（明文不在备份）。
 */
import type { OpenClawChannelsConfig } from './openclaw-config.js'
import type { NormalizedChannelSecrets } from './map-channel.js'
import { resolveSecret } from './resolve-secret.js'

export function extractChannelSecrets(
  channels: OpenClawChannelsConfig,
  sourceChannel: string,
  accountId: string,
): NormalizedChannelSecrets {
  const cfg = channels[sourceChannel]
  if (!cfg) return {}

  const account = cfg.accounts?.[accountId]
  // telegram 顶层 botToken 回退（account_id='default' 且无对应 account）
  const botTokenInput = account?.botToken ?? (accountId === 'default' ? cfg.botToken : undefined)

  const secrets: NormalizedChannelSecrets = {}
  const appId = resolveSecret(account?.appId)
  const appSecret = resolveSecret(account?.appSecret)
  const botToken = resolveSecret(botTokenInput)
  if (appId !== undefined) secrets.appId = appId
  if (appSecret !== undefined) secrets.appSecret = appSecret
  if (botToken !== undefined) secrets.botToken = botToken
  return secrets
}
