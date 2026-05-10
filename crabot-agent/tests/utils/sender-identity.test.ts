import { describe, it, expect } from 'vitest'
import { resolveSenderIdentity } from '../../src/utils/sender-identity.js'
import type { ChannelMessage, Friend } from '../../src/types.js'

const baseFriend: Friend = {
  id: 'f-1', display_name: 'Master', permission: 'master',
  channel_identities: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

function makeMsg(overrides: Partial<{ friend_id: string | undefined; from_crab: boolean }> = {}): ChannelMessage {
  return {
    platform_message_id: 'm', session: { session_id: 's', channel_id: 'c', type: 'private' },
    sender: { friend_id: overrides.friend_id, platform_user_id: 'pu', platform_display_name: 'X' },
    content: { type: 'text', text: 'hi' }, features: { is_mention_crab: false },
    platform_timestamp: '2026-05-10T00:00:00Z',
  }
}

describe('resolveSenderIdentity', () => {
  it('crab 自己的回复 → assistant', () => {
    expect(resolveSenderIdentity({ from_crab: true })).toBe('assistant')
  })
  it('master friend → master', () => {
    expect(resolveSenderIdentity({ msg: makeMsg({ friend_id: 'f-1' }), senderFriend: baseFriend })).toBe('master')
  })
  it('normal friend → friend', () => {
    const f: Friend = { ...baseFriend, permission: 'normal' }
    expect(resolveSenderIdentity({ msg: makeMsg({ friend_id: 'f-1' }), senderFriend: f })).toBe('friend')
  })
  it('未注册 friend_id（群里陌生人）→ stranger', () => {
    expect(resolveSenderIdentity({ msg: makeMsg({ friend_id: undefined }) })).toBe('stranger')
  })
})
