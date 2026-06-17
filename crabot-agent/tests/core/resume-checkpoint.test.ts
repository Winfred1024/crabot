import { describe, it, expect } from 'vitest'
import { isResumable, buildResumeWakeupMessage } from '../../src/core/resume-checkpoint.js'

const base = {
  agent_version: '1.0.0',
  system_prompt: 'SP',
  messages: [{ id: 'm1', role: 'user' as const, content: 'hi', timestamp: 1 }],
  worker_state: { todo_items: [] },
}

describe('isResumable', () => {
  it('版本一致 + 有 messages → 可 resume', () => {
    expect(isResumable(base, '1.0.0').ok).toBe(true)
  })
  it('版本不符 → 拒绝', () => {
    const r = isResumable(base, '2.0.0')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('version_mismatch')
  })
  it('空 messages → 拒绝', () => {
    const r = isResumable({ ...base, messages: [] }, '1.0.0')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty_checkpoint')
  })
})

describe('buildResumeWakeupMessage', () => {
  it('返回 user 角色、含「重启」「自查」字样', () => {
    const m = buildResumeWakeupMessage()
    expect(m.role).toBe('user')
    expect(String(m.content)).toContain('重启')
    expect(String(m.content)).toContain('自查')
  })
})
