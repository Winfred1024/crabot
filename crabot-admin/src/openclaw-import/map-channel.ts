/**
 * 把 OpenClaw channel + 归一化 secret 映射成 crabot createInstance 入参。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.2
 * 必需 secret 缺失（未填 / SecretRef / 不在备份）→ 不产出半成品，返回 missing-secret。
 */
import type { CreateChannelInstanceParams } from '../types.js'

/** 已从备份解析出的归一化 secret（明文；缺失或引用类则为 undefined）。 */
export type NormalizedChannelSecrets = {
  botToken?: string
  appId?: string
  appSecret?: string
  ownerOpenId?: string
}

export type ChannelMapInput = {
  channel: 'telegram' | 'feishu' | 'lark'
  name: string
  secrets: NormalizedChannelSecrets
}

export type ChannelMapResult =
  | { ok: true; params: CreateChannelInstanceParams }
  | { ok: false; reason: 'missing-secret' }

function mapTelegram(name: string, secrets: NormalizedChannelSecrets): ChannelMapResult {
  if (!secrets.botToken) return { ok: false, reason: 'missing-secret' }
  return {
    ok: true,
    params: { implementation_id: 'channel-telegram', name, platform: 'telegram', env: { TELEGRAM_BOT_TOKEN: secrets.botToken } },
  }
}

function mapFeishu(
  name: string,
  domain: 'feishu' | 'lark',
  secrets: NormalizedChannelSecrets,
): ChannelMapResult {
  if (!secrets.appId || !secrets.appSecret) return { ok: false, reason: 'missing-secret' }
  const env: Record<string, string> = {
    FEISHU_APP_ID: secrets.appId,
    FEISHU_APP_SECRET: secrets.appSecret,
    FEISHU_DOMAIN: domain,
    ...(secrets.ownerOpenId ? { FEISHU_OWNER_OPEN_ID: secrets.ownerOpenId } : {}),
  }
  return { ok: true, params: { implementation_id: 'channel-feishu', name, platform: 'feishu', env } }
}

export function mapChannel(input: ChannelMapInput): ChannelMapResult {
  switch (input.channel) {
    case 'telegram':
      return mapTelegram(input.name, input.secrets)
    case 'feishu':
      return mapFeishu(input.name, 'feishu', input.secrets)
    case 'lark':
      return mapFeishu(input.name, 'lark', input.secrets)
  }
}
