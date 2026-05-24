import { describe, it, expect } from 'vitest'
import { buildRecoveryTask, cleanupStaleInflightTasks } from './recovery-handler.js'
import type { Task, TaskStatus } from './types.js'

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

describe('cleanupStaleInflightTasks', () => {
  const NOW = '2026-05-24T10:00:00.000Z'

  it('marks pending / planning / executing as failed', () => {
    const statuses: TaskStatus[] = ['pending', 'planning', 'executing']
    const input = statuses.map((s) => fakeTask({ id: s, status: s }))
    const { tasks, staleCount } = cleanupStaleInflightTasks(input, NOW)
    expect(staleCount).toBe(3)
    for (const t of tasks) {
      expect(t.status).toBe('failed')
      expect(t.error).toBe('admin_restarted_during_task')
      expect(t.updated_at).toBe(NOW)
      expect(t.completed_at).toBe(NOW)
    }
  })

  it('preserves waiting_human (worker not running, will resume via supplement)', () => {
    const input = [fakeTask({ id: 'wh', status: 'waiting_human' })]
    const { tasks, staleCount } = cleanupStaleInflightTasks(input, NOW)
    expect(staleCount).toBe(0)
    expect(tasks[0].status).toBe('waiting_human')
    expect(tasks[0].updated_at).not.toBe(NOW)
  })

  it('preserves terminal states (completed / failed / cancelled)', () => {
    const terminals: TaskStatus[] = ['completed', 'failed', 'cancelled']
    const input = terminals.map((s) => fakeTask({ id: s, status: s }))
    const { tasks, staleCount } = cleanupStaleInflightTasks(input, NOW)
    expect(staleCount).toBe(0)
    expect(tasks.map((t) => t.status)).toEqual(terminals)
  })

  it('does not overwrite existing error field', () => {
    const input = [fakeTask({ id: 'a', status: 'executing', error: 'preexisting reason' })]
    const { tasks } = cleanupStaleInflightTasks(input, NOW)
    expect(tasks[0].error).toBe('preexisting reason')
  })

  it('returns a fresh array (no mutation of input objects)', () => {
    const original = fakeTask({ id: 'a', status: 'executing' })
    cleanupStaleInflightTasks([original], NOW)
    expect(original.status).toBe('executing') // 入参未被改写
  })
})
