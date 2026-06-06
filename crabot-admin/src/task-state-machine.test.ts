import { describe, it, expect } from 'vitest'
import { VALID_TRANSITIONS } from './task-state-machine.js'

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
