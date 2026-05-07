import { describe, it, expect } from 'vitest'
import { buildRecoveryTask } from './recovery-handler.js'
import type { Task } from './types.js'

function fakeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-x',
    status: 'executing',
    priority: 'normal',
    title: 't',
    description: 'd',
    source: { trigger_type: 'manual', origin: 'human' },
    messages: [],
    tags: [],
    created_at: '2026-05-07T01:00:00.000Z',
    updated_at: '2026-05-07T01:00:00.000Z',
    started_at: '2026-05-07T01:00:00.000Z',
    ...overrides,
  }
}

describe('buildRecoveryTask', () => {
  it('returns null when no in-flight tasks', () => {
    const r = buildRecoveryTask([], 1, '2026-05-07T01:30:00.000Z')
    expect(r).toBeNull()
  })

  it('skips recovery tasks themselves to avoid avalanche', () => {
    const tasks = [
      fakeTask({ id: 'a', tags: ['recovery'] }),
      fakeTask({ id: 'b', tags: ['recovery'] }),
    ]
    const r = buildRecoveryTask(tasks, 1, '2026-05-07T01:30:00.000Z')
    expect(r).toBeNull()
  })

  it('builds a CreateTaskParams when there are non-recovery in-flight tasks', () => {
    const tasks = [
      fakeTask({ id: 'aaa', title: 'first task' }),
      fakeTask({ id: 'bbb', title: 'second', tags: ['recovery'] }), // 跳过
      fakeTask({ id: 'ccc', title: 'third task' }),
    ]
    const r = buildRecoveryTask(tasks, 1, '2026-05-07T01:30:00.000Z')
    expect(r).not.toBeNull()
    expect(r!.tags).toEqual(['recovery'])
    expect(r!.priority).toBe('high')
    expect(r!.source.origin).toBe('system')
    expect(r!.source.trigger_type).toBe('auto')
    expect(r!.title).toContain('2 条')
    expect(r!.description).toContain('aaa')
    expect(r!.description).toContain('first task')
    expect(r!.description).toContain('ccc')
    expect(r!.description).toContain('third task')
    expect(r!.description).not.toContain('bbb') // 防雪崩
  })

  it('returns null on first start (restart_count = 0)', () => {
    const tasks = [fakeTask({ id: 'a' })]
    const r = buildRecoveryTask(tasks, 0, '2026-05-07T01:30:00.000Z')
    expect(r).toBeNull()
  })
})
