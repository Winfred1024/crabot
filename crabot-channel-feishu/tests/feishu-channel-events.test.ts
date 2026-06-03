import { describe, it, expect } from 'vitest'
import { SUBSCRIBED_EVENTS } from '../src/feishu-channel.js'

describe('SUBSCRIBED_EVENTS', () => {
  it('has exactly 6 events covering all dispatcher handlers', () => {
    expect(SUBSCRIBED_EVENTS).toHaveLength(6)
  })

  it('all identifiers end with _v1 (feishu v2.0 schema convention)', () => {
    for (const e of SUBSCRIBED_EVENTS) {
      expect(e.identifier.endsWith('_v1')).toBe(true)
    }
  })

  it('all identifiers are unique', () => {
    const ids = SUBSCRIBED_EVENTS.map((e) => e.identifier)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every event has a Chinese name', () => {
    for (const e of SUBSCRIBED_EVENTS) {
      expect(e.name).toBeTruthy()
      expect(/[一-龥]/.test(e.name)).toBe(true)
    }
  })

  it('includes the 5 events that require manual subscription on Feishu console', () => {
    const ids = SUBSCRIBED_EVENTS.map((e) => e.identifier)
    expect(ids).toContain('im.chat.member.bot.added_v1')
    expect(ids).toContain('im.chat.member.bot.deleted_v1')
    expect(ids).toContain('im.chat.member.user.added_v1')
    expect(ids).toContain('im.chat.member.user.deleted_v1')
    expect(ids).toContain('im.chat.updated_v1')
  })

  it('includes im.message.receive_v1 (feishu default-subscribed)', () => {
    const ids = SUBSCRIBED_EVENTS.map((e) => e.identifier)
    expect(ids).toContain('im.message.receive_v1')
  })
})
