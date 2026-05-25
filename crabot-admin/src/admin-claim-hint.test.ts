import { describe, expect, it } from 'vitest'
import { UNCLAIMED_HINT_TEXT, ALREADY_CLAIMED_HINT_TEXT } from 'crabot-shared'

describe('claim hint 文本契约', () => {
  it('UNCLAIMED_HINT_TEXT 以 [系统响应 /认主] 开头', () => {
    expect(UNCLAIMED_HINT_TEXT.startsWith('[系统响应 /认主]\n')).toBe(true)
  })

  it('ALREADY_CLAIMED_HINT_TEXT 以 [系统响应 /认主] 开头', () => {
    expect(ALREADY_CLAIMED_HINT_TEXT.startsWith('[系统响应 /认主]\n')).toBe(true)
  })

  it('UNCLAIMED_HINT_TEXT 不再提及废除的英文 slash', () => {
    expect(UNCLAIMED_HINT_TEXT.includes('/pair')).toBe(false)
    expect(UNCLAIMED_HINT_TEXT.includes('/apply')).toBe(false)
  })

  it('ALREADY_CLAIMED_HINT_TEXT 提到 /加好友 + 不再提及废除的 /pair /apply', () => {
    expect(ALREADY_CLAIMED_HINT_TEXT.includes('/加好友')).toBe(true)
    expect(ALREADY_CLAIMED_HINT_TEXT.includes('/pair')).toBe(false)
    expect(ALREADY_CLAIMED_HINT_TEXT.includes('/apply')).toBe(false)
  })
})
