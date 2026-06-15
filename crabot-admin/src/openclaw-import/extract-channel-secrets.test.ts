/**
 * channel secret 提取测试：从 channels.accounts 解析明文 secret（执行期用）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.2
 */
import { describe, it, expect } from 'vitest'
import { extractChannelSecrets } from './extract-channel-secrets.js'
import type { OpenClawChannelsConfig } from './openclaw-config.js'

const channels: OpenClawChannelsConfig = {
  feishu: {
    accounts: {
      main: { appId: 'cli_x', appSecret: 'secret32' },
      ref: { appId: 'cli_y', appSecret: { source: 'env', provider: 'd', id: 'K' } },
    },
  },
  telegram: { accounts: { bot1: { botToken: '123:abc' } }, botToken: 'top:level' },
}

describe('extractChannelSecrets', () => {
  it('feishu 账号 → 提取 appId/appSecret 明文', () => {
    expect(extractChannelSecrets(channels, 'feishu', 'main')).toEqual({ appId: 'cli_x', appSecret: 'secret32' })
  })

  it('appSecret 是 SecretRef → 该字段 undefined', () => {
    expect(extractChannelSecrets(channels, 'feishu', 'ref')).toEqual({ appId: 'cli_y' })
  })

  it('telegram 账号 → 提取 botToken', () => {
    expect(extractChannelSecrets(channels, 'telegram', 'bot1')).toEqual({ botToken: '123:abc' })
  })

  it('telegram default 账号（无 accounts.default）→ 回退到 channel 顶层 botToken', () => {
    expect(extractChannelSecrets(channels, 'telegram', 'default')).toEqual({ botToken: 'top:level' })
  })

  it('账号不存在 → 空对象', () => {
    expect(extractChannelSecrets(channels, 'feishu', 'nope')).toEqual({})
  })
})
