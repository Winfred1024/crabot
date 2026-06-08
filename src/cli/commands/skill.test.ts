import { describe, it, expect } from 'vitest'
import { buildSkillAddReverse } from './skill.js'

describe('buildSkillAddReverse', () => {
  it('was_overwrite=true → skill restore reverse', () => {
    const reverse = buildSkillAddReverse(
      { id: 'sk-1', was_overwrite: true },
      { source: 'path /tmp/foo' },
    )
    expect(reverse).toEqual({
      command: 'skill restore sk-1',
      preview_description: 'restore skill sk-1 to version before this overwrite',
    })
  })

  it('was_overwrite=false → skill delete reverse', () => {
    const reverse = buildSkillAddReverse(
      { id: 'sk-1', was_overwrite: false },
      { source: 'path /tmp/foo' },
    )
    expect(reverse).toEqual({
      command: 'skill delete sk-1',
      preview_description: 'delete newly imported skill from path /tmp/foo (sk-1)',
    })
  })

  it('was_overwrite 缺失（旧 admin）→ skill delete reverse（兼容）', () => {
    const reverse = buildSkillAddReverse(
      { id: 'sk-1' },
      { source: 'git https://example.com/repo' },
    )
    expect(reverse).toEqual({
      command: 'skill delete sk-1',
      preview_description: 'delete newly imported skill from git https://example.com/repo (sk-1)',
    })
  })

  it('result 为 null → id = <unknown>', () => {
    const reverse = buildSkillAddReverse(null, { source: 'path /tmp/foo' })
    expect(reverse.command).toBe('skill delete <unknown>')
  })
})
