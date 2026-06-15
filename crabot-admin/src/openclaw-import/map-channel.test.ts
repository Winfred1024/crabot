/**
 * channel 映射测试：OpenClaw channel + 归一化 secret → crabot CreateChannelInstanceParams。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.2
 * crabot implementation_id：channel-telegram / channel-feishu（lark 也走 feishu 模块 + FEISHU_DOMAIN）。
 */
import { describe, it, expect } from 'vitest'
import { mapChannel } from './map-channel.js'

describe('mapChannel', () => {
  it('telegram + botToken → channel-telegram，env=TELEGRAM_BOT_TOKEN', () => {
    const r = mapChannel({ channel: 'telegram', name: 'tg', secrets: { botToken: '123:abc' } })

    expect(r).toEqual({
      ok: true,
      params: { implementation_id: 'channel-telegram', name: 'tg', platform: 'telegram', env: { TELEGRAM_BOT_TOKEN: '123:abc' } },
    })
  })

  it('telegram 缺 botToken → ok:false，reason=missing-secret', () => {
    expect(mapChannel({ channel: 'telegram', name: 'tg', secrets: {} })).toEqual({ ok: false, reason: 'missing-secret' })
  })

  it('feishu + appId/appSecret → channel-feishu，FEISHU_* env，DOMAIN=feishu', () => {
    const r = mapChannel({ channel: 'feishu', name: 'fs', secrets: { appId: 'cli_x', appSecret: 'sec' } })

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.params.implementation_id).toBe('channel-feishu')
      expect(r.params.env).toEqual({ FEISHU_APP_ID: 'cli_x', FEISHU_APP_SECRET: 'sec', FEISHU_DOMAIN: 'feishu' })
    }
  })

  it('lark → 同 feishu 模块，DOMAIN=lark', () => {
    const r = mapChannel({ channel: 'lark', name: 'lk', secrets: { appId: 'cli_x', appSecret: 'sec' } })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params.env?.FEISHU_DOMAIN).toBe('lark')
  })

  it('feishu 带 ownerOpenId → 写入 FEISHU_OWNER_OPEN_ID；不带则省略', () => {
    const withOwner = mapChannel({ channel: 'feishu', name: 'fs', secrets: { appId: 'a', appSecret: 's', ownerOpenId: 'ou_1' } })
    const without = mapChannel({ channel: 'feishu', name: 'fs', secrets: { appId: 'a', appSecret: 's' } })

    if (withOwner.ok) expect(withOwner.params.env?.FEISHU_OWNER_OPEN_ID).toBe('ou_1')
    if (without.ok) expect(without.params.env && 'FEISHU_OWNER_OPEN_ID' in without.params.env).toBe(false)
  })

  it('feishu 缺 appSecret → ok:false', () => {
    expect(mapChannel({ channel: 'feishu', name: 'fs', secrets: { appId: 'a' } })).toEqual({ ok: false, reason: 'missing-secret' })
  })
})
