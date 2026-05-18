import { describe, it, expect } from 'vitest'
import { resolveTimeoutSeconds, resolveOverdueReminder } from '../src/unified-agent.js'

describe('resolveTimeoutSeconds', () => {
  it('未配置 → 默认 30', () => {
    expect(resolveTimeoutSeconds(undefined)).toBe(30)
  })
  it('配置具体值 → 使用配置', () => {
    expect(resolveTimeoutSeconds(60)).toBe(60)
  })
  it('配置 0 → 透传 0（语义是立即超时；禁用提醒应走 overdue_reminder_enabled=false）', () => {
    expect(resolveTimeoutSeconds(0)).toBe(0)
  })
})

describe('resolveOverdueReminder', () => {
  it('未配置 → 默认 true', () => {
    expect(resolveOverdueReminder(undefined)).toBe(true)
  })
  it('配置 false → false', () => {
    expect(resolveOverdueReminder(false)).toBe(false)
  })
  it('配置 true → true', () => {
    expect(resolveOverdueReminder(true)).toBe(true)
  })
})
