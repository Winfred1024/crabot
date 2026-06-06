import { describe, it, expect } from 'vitest'
import { VALID_TRANSITIONS, applyDerivedFields } from './task-state-machine.js'
import type { Task } from './types.js'

describe('VALID_TRANSITIONS', () => {
  it('allows pending → failed (admin restart cleanup path)', () => {
    expect(VALID_TRANSITIONS.pending).toContain('failed')
  })

  it('allows pending → planning / cancelled / failed', () => {
    expect(VALID_TRANSITIONS.pending).toEqual(
      expect.arrayContaining(['planning', 'cancelled', 'failed'])
    )
  })

  it('allows waiting_human → executing / cancelled / failed', () => {
    expect(VALID_TRANSITIONS.waiting_human).toEqual(
      expect.arrayContaining(['executing', 'cancelled', 'failed'])
    )
  })

  it('forbids any transition from terminal states', () => {
    expect(VALID_TRANSITIONS.completed).toEqual([])
    expect(VALID_TRANSITIONS.failed).toEqual([])
    expect(VALID_TRANSITIONS.cancelled).toEqual([])
  })
})

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-x',
    status: 'pending',
    priority: 'normal',
    title: 't',
    description: 'd',
    source: { trigger_type: 'manual', origin: 'human' },
    messages: [],
    tags: [],
    created_at: '2026-05-07T01:00:00.000Z',
    updated_at: '2026-05-07T01:00:00.000Z',
    ...overrides,
  }
}

const NOW = '2026-06-05T10:00:00.000Z'

describe('applyDerivedFields', () => {
  it('sets status and updated_at', () => {
    const next = applyDerivedFields(fakeTask({ status: 'planning' }), 'executing', NOW)
    expect(next.status).toBe('executing')
    expect(next.updated_at).toBe(NOW)
  })

  it('sets started_at on first entry to executing', () => {
    const next = applyDerivedFields(fakeTask({ status: 'planning' }), 'executing', NOW)
    expect(next.started_at).toBe(NOW)
  })

  it('preserves started_at on re-entry to executing', () => {
    const earlier = '2026-06-04T00:00:00.000Z'
    const next = applyDerivedFields(
      fakeTask({ status: 'waiting_human', started_at: earlier, waiting_human_at: '2026-06-04T01:00:00.000Z' }),
      'executing',
      NOW,
    )
    expect(next.started_at).toBe(earlier)
  })

  it('sets completed_at on entering terminal state', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as const) {
      const next = applyDerivedFields(fakeTask({ status: 'executing', started_at: NOW }), s, NOW)
      expect(next.completed_at).toBe(NOW)
    }
  })

  it('sets waiting_human_at on enter, clears on leave', () => {
    const entering = applyDerivedFields(fakeTask({ status: 'executing' }), 'waiting_human', NOW)
    expect(entering.waiting_human_at).toBe(NOW)

    const leaving = applyDerivedFields(
      fakeTask({ status: 'waiting_human', waiting_human_at: '2026-06-04T00:00:00.000Z' }),
      'executing',
      NOW,
    )
    expect(leaving.waiting_human_at).toBeUndefined()

    const leavingToFailed = applyDerivedFields(
      fakeTask({ status: 'waiting_human', waiting_human_at: '2026-06-04T00:00:00.000Z' }),
      'failed',
      NOW,
    )
    expect(leavingToFailed.waiting_human_at).toBeUndefined()
  })

  it('sets waiting_at on enter, clears on leave', () => {
    const entering = applyDerivedFields(fakeTask({ status: 'executing' }), 'waiting', NOW)
    expect(entering.waiting_at).toBe(NOW)

    const leaving = applyDerivedFields(
      fakeTask({ status: 'waiting', waiting_at: '2026-06-04T00:00:00.000Z' }),
      'executing',
      NOW,
    )
    expect(leaving.waiting_at).toBeUndefined()
  })

  it('writes pending_question on entering waiting_human (when provided)', () => {
    const next = applyDerivedFields(
      fakeTask({ status: 'executing' }),
      'waiting_human',
      NOW,
      { pendingQuestion: '需要 root 密码吗？' },
    )
    expect(next.pending_question).toBe('需要 root 密码吗？')
  })

  it('preserves pending_question on entering waiting_human when not provided', () => {
    // 现有语义：覆盖式但仅在传值时；不传则保留旧值（极少触发，保险起见保留）
    const next = applyDerivedFields(
      fakeTask({ status: 'executing', pending_question: 'old q' }),
      'waiting_human',
      NOW,
    )
    expect(next.pending_question).toBe('old q')
  })

  it('clears pending_question on leaving waiting_human (any direction)', () => {
    for (const target of ['executing', 'cancelled', 'failed'] as const) {
      const next = applyDerivedFields(
        fakeTask({ status: 'waiting_human', waiting_human_at: NOW, pending_question: 'q?' }),
        target,
        NOW,
      )
      expect(next.pending_question).toBeUndefined()
    }
  })

  it('clears pending_question if opts.pendingQuestion === null even when entering waiting_human', () => {
    const next = applyDerivedFields(
      fakeTask({ status: 'executing', pending_question: 'leftover' }),
      'waiting_human',
      NOW,
      { pendingQuestion: null },
    )
    expect(next.pending_question).toBeUndefined()
  })

  it('sets error from opts when provided', () => {
    const next = applyDerivedFields(fakeTask({ status: 'executing' }), 'failed', NOW, { error: 'oom' })
    expect(next.error).toBe('oom')
  })

  it('preserves existing error when opts.error not provided', () => {
    const next = applyDerivedFields(
      fakeTask({ status: 'executing', error: 'preexisting' }),
      'failed',
      NOW,
    )
    expect(next.error).toBe('preexisting')
  })

  it('does not mutate input task', () => {
    const input = fakeTask({ status: 'waiting_human', waiting_human_at: '2026-06-04T00:00:00.000Z' })
    applyDerivedFields(input, 'failed', NOW)
    expect(input.status).toBe('waiting_human')
    expect(input.waiting_human_at).toBe('2026-06-04T00:00:00.000Z')
  })
})
