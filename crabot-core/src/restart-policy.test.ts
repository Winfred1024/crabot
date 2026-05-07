import { describe, it, expect } from 'vitest'
import { scheduleRestart, computeBackoff, type RestartHistory } from './restart-policy.js'

const empty: RestartHistory = { attempts: [] }

describe('computeBackoff', () => {
  it('exponential backoff with 10s ceiling', () => {
    expect([0, 1, 2, 3, 4, 5].map(computeBackoff)).toEqual([1000, 2000, 4000, 8000, 10000, 10000])
  })
})

describe('scheduleRestart', () => {
  it('first crash schedules with 1s backoff', () => {
    const r = scheduleRestart(empty, 1_000_000)
    expect(r.should_restart).toBe(true)
    expect(r.delay_ms).toBe(1000)
    expect(r.next_history.attempts).toHaveLength(1)
    expect(r.next_history.attempts[0]).toBe(1_000_000)
  })

  it('gives up after 3 attempts within 5 minute window', () => {
    const t0 = 1_000_000
    let h = empty
    for (let i = 0; i < 3; i++) {
      h = scheduleRestart(h, t0 + i * 100).next_history
    }
    const fourth = scheduleRestart(h, t0 + 400)
    expect(fourth.should_restart).toBe(false)
    expect(fourth.delay_ms).toBe(0)
    expect(fourth.reason).toContain('limit')
    // limit reached 时 history 不增长
    expect(fourth.next_history.attempts).toHaveLength(3)
  })

  it('forgets attempts older than 5 minute window', () => {
    const t0 = 1_000_000
    let h = empty
    for (let i = 0; i < 3; i++) {
      h = scheduleRestart(h, t0 + i * 1000).next_history
    }
    // 6 分钟后再来 → 旧的 3 次已出窗口，应允许
    const later = scheduleRestart(h, t0 + 6 * 60 * 1000)
    expect(later.should_restart).toBe(true)
    expect(later.next_history.attempts).toHaveLength(1) // 只剩这次
  })

  it('does not mutate input history', () => {
    const h: RestartHistory = { attempts: [1, 2, 3] }
    const snapshot = JSON.stringify(h)
    scheduleRestart(h, 1000)
    expect(JSON.stringify(h)).toBe(snapshot)
  })
})
