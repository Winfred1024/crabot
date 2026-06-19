import { describe, it, expect } from 'vitest'
import { shouldDisableOnImport } from './schedule-arm.js'

const NOW = Date.parse('2026-06-19T00:00:00Z')

describe('shouldDisableOnImport', () => {
  it('过期的 once → 应 disable', () => {
    expect(shouldDisableOnImport(
      { trigger: { type: 'once', execute_at: '2020-01-01T00:00:00Z' } }, NOW,
    )).toBe(true)
  })

  it('未过期的 once → 不 disable', () => {
    expect(shouldDisableOnImport(
      { trigger: { type: 'once', execute_at: '2099-01-01T00:00:00Z' } }, NOW,
    )).toBe(false)
  })

  it('cron → 永不因导入 disable', () => {
    expect(shouldDisableOnImport(
      { trigger: { type: 'cron', expression: '0 9 * * *' } }, NOW,
    )).toBe(false)
  })

  it('interval → 永不因导入 disable', () => {
    expect(shouldDisableOnImport(
      { trigger: { type: 'interval', seconds: 60 } }, NOW,
    )).toBe(false)
  })

  it('trigger 缺失或非法 execute_at → 不 disable', () => {
    expect(shouldDisableOnImport({}, NOW)).toBe(false)
    expect(shouldDisableOnImport({ trigger: { type: 'once', execute_at: 'not-a-date' } }, NOW)).toBe(false)
  })
})
