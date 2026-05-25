import { describe, it, expect } from 'vitest'
import {
  LEGACY_UNCLAIMED_HINT_TEXT,
  LEGACY_ALREADY_CLAIMED_HINT_TEXT,
  UNCLAIMED_HINT_TEXT,
} from 'crabot-shared'
import { compatLegacyClaimHint } from '../../src/orchestration/context-assembler.js'
import type { ChannelMessage } from '../../src/types.js'

function makeMessage(text: string, type: 'text' | 'image' = 'text'): ChannelMessage {
  const content =
    type === 'text'
      ? { type: 'text' as const, text }
      : { type: 'image' as const, media_url: 'http://example.com/x.png' }
  return {
    platform_message_id: 'm1',
    session: { session_id: 's1' as any, channel_id: 'channel-x' as any, type: 'private' as const },
    sender: { platform_user_id: 'u1', platform_display_name: 'U' },
    content: content as ChannelMessage['content'],
    features: { is_mention_crab: false },
    platform_timestamp: new Date().toISOString(),
  }
}

describe('compatLegacyClaimHint', () => {
  it('老版裸 UNCLAIMED hint → 加 [系统响应 /认主] 前缀', () => {
    const msg = makeMessage(LEGACY_UNCLAIMED_HINT_TEXT)
    const out = compatLegacyClaimHint(msg)
    expect(out.content.type).toBe('text')
    if (out.content.type === 'text') {
      expect(out.content.text!.startsWith('[系统响应 /认主]\n')).toBe(true)
      expect(out.content.text!.includes(LEGACY_UNCLAIMED_HINT_TEXT)).toBe(true)
    }
  })

  it('老版裸 ALREADY_CLAIMED hint → 加 [系统响应 /认主] 前缀', () => {
    const msg = makeMessage(LEGACY_ALREADY_CLAIMED_HINT_TEXT)
    const out = compatLegacyClaimHint(msg)
    if (out.content.type === 'text') {
      expect(out.content.text!.startsWith('[系统响应 /认主]\n')).toBe(true)
    }
  })

  it('已带新前缀的文本（admin 新发出的话术）→ 原样保留', () => {
    const msg = makeMessage(UNCLAIMED_HINT_TEXT)
    const out = compatLegacyClaimHint(msg)
    if (out.content.type === 'text') {
      expect(out.content.text).toBe(UNCLAIMED_HINT_TEXT)
    }
  })

  it('无关 outbound 文本 → 原样保留', () => {
    const msg = makeMessage('hello, this is unrelated content')
    const out = compatLegacyClaimHint(msg)
    if (out.content.type === 'text') {
      expect(out.content.text).toBe('hello, this is unrelated content')
    }
  })

  it('inbound slash 字面（/目标 a3f8）→ 原样保留（不改写）', () => {
    const msg = makeMessage('/目标 a3f8')
    const out = compatLegacyClaimHint(msg)
    if (out.content.type === 'text') {
      expect(out.content.text).toBe('/目标 a3f8')
    }
  })

  it('非 text 内容 → 原样返回', () => {
    const msg = makeMessage('', 'image')
    const out = compatLegacyClaimHint(msg)
    expect(out).toBe(msg)
  })
})
