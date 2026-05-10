import { describe, it, expect } from 'vitest'
import { resolveSenderIdentity } from '../../src/utils/sender-identity.js'
import type { ChannelMessage, Friend } from '../../src/types.js'

const baseFriend: Friend = {
  id: 'f-1', display_name: 'Master', permission: 'master',
  channel_identities: [
    { channel_id: 'c', platform_user_id: 'pu', platform_display_name: 'Master' },
  ],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

function makeMsg(overrides: Partial<{
  friend_id: string | undefined
  platform_user_id: string
  platform_display_name: string
  channel_id: string
  type: 'private' | 'group'
}> = {}): ChannelMessage {
  return {
    platform_message_id: 'm',
    session: {
      session_id: 's',
      channel_id: overrides.channel_id ?? 'c',
      type: overrides.type ?? 'private',
    },
    sender: {
      friend_id: overrides.friend_id,
      platform_user_id: overrides.platform_user_id ?? 'pu',
      platform_display_name: overrides.platform_display_name ?? 'X',
    },
    content: { type: 'text', text: 'hi' },
    features: { is_mention_crab: false },
    platform_timestamp: '2026-05-10T00:00:00Z',
  }
}

describe('resolveSenderIdentity', () => {
  it('crab 自己的回复（from_crab 显式）→ assistant', () => {
    expect(resolveSenderIdentity({ from_crab: true })).toBe('assistant')
  })

  it('crabDisplayName 匹配 → assistant', () => {
    const msg = makeMsg({ platform_display_name: 'CrabBot' })
    expect(resolveSenderIdentity({ msg, crabDisplayName: 'CrabBot' })).toBe('assistant')
  })

  it('friend_id 命中 master → master', () => {
    const msg = makeMsg({ friend_id: 'f-1' })
    expect(resolveSenderIdentity({ msg, senderFriend: baseFriend })).toBe('master')
  })

  it('friend_id 命中 normal friend → friend', () => {
    const f: Friend = { ...baseFriend, permission: 'normal' }
    const msg = makeMsg({ friend_id: 'f-1' })
    expect(resolveSenderIdentity({ msg, senderFriend: f })).toBe('friend')
  })

  it('historical msg 缺 friend_id 但 platform_user_id+channel 匹配 channel_identities → master', () => {
    const msg = makeMsg({ friend_id: undefined, platform_user_id: 'pu', channel_id: 'c' })
    expect(resolveSenderIdentity({ msg, senderFriend: baseFriend })).toBe('master')
  })

  it('私聊 + sender 不匹配 senderFriend → assistant（私聊两方对话，非 senderFriend 即 crab）', () => {
    const msg = makeMsg({ friend_id: undefined, platform_user_id: 'crab-bot-id' })
    expect(resolveSenderIdentity({ msg, senderFriend: baseFriend })).toBe('assistant')
  })

  it('群聊 + 没匹配 senderFriend → stranger（保守）', () => {
    const msg = makeMsg({ friend_id: undefined, platform_user_id: 'unknown', type: 'group' })
    expect(resolveSenderIdentity({ msg, senderFriend: baseFriend, isGroup: true })).toBe('stranger')
  })

  it('群聊 + sender 匹配 senderFriend.channel_identities → master', () => {
    const msg = makeMsg({ friend_id: undefined, platform_user_id: 'pu', channel_id: 'c', type: 'group' })
    expect(resolveSenderIdentity({ msg, senderFriend: baseFriend, isGroup: true })).toBe('master')
  })

  it('未注册 friend_id 且无 senderFriend → stranger', () => {
    expect(resolveSenderIdentity({ msg: makeMsg({ friend_id: undefined }) })).toBe('stranger')
  })
})
