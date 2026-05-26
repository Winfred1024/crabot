import { describe, expect, it } from 'vitest'
import {
  appendAuditEntry,
  shouldAutoBlock,
  transitionGoalStatus,
  TASK_GOAL_BLOCKED_THRESHOLD,
} from './task-goal.js'
import type { TaskGoal, TaskGoalAuditEntry } from './types.js'

function makeActiveGoal(): TaskGoal {
  return {
    objective: 'test',
    acceptance_criteria: [
      { id: 'c1', kind: 'semantic', spec: 'x' },
      { id: 'c2', kind: 'semantic', spec: 'y' },
    ],
    status: 'active',
    tokens_used: 0,
    audit_history: [],
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:00.000Z',
  }
}

function entry(failedCriteria: string[], pass = false, at = '2026-05-26T00:01:00.000Z'): TaskGoalAuditEntry {
  return { at, pass, failed_criteria: failedCriteria, audit_trace_id: 'tr-x' }
}

describe('shouldAutoBlock wire-up 行为契约', () => {
  it('TASK_GOAL_BLOCKED_THRESHOLD === 3', () => {
    expect(TASK_GOAL_BLOCKED_THRESHOLD).toBe(3)
  })

  it('连续 3 次同 failed_criteria → shouldAutoBlock 返回 true', () => {
    let goal = makeActiveGoal()
    goal = appendAuditEntry(goal, entry(['c1']), 'now1')
    expect(shouldAutoBlock(goal, TASK_GOAL_BLOCKED_THRESHOLD)).toBe(false)
    goal = appendAuditEntry(goal, entry(['c1']), 'now2')
    expect(shouldAutoBlock(goal, TASK_GOAL_BLOCKED_THRESHOLD)).toBe(false)
    goal = appendAuditEntry(goal, entry(['c1']), 'now3')
    expect(shouldAutoBlock(goal, TASK_GOAL_BLOCKED_THRESHOLD)).toBe(true)
  })

  it('3 次但 failed_criteria 不一致 → 不 blocked', () => {
    let goal = makeActiveGoal()
    goal = appendAuditEntry(goal, entry(['c1']), 'now1')
    goal = appendAuditEntry(goal, entry(['c2']), 'now2')
    goal = appendAuditEntry(goal, entry(['c1']), 'now3')
    expect(shouldAutoBlock(goal, TASK_GOAL_BLOCKED_THRESHOLD)).toBe(false)
  })

  it('3 次中有 pass → 不 blocked', () => {
    let goal = makeActiveGoal()
    goal = appendAuditEntry(goal, entry(['c1']), 'now1')
    goal = appendAuditEntry(goal, entry([], true), 'now2')
    goal = appendAuditEntry(goal, entry(['c1']), 'now3')
    expect(shouldAutoBlock(goal, TASK_GOAL_BLOCKED_THRESHOLD)).toBe(false)
  })

  it('shouldAutoBlock=true 后调 transitionGoalStatus("blocked") → goal.status === "blocked"', () => {
    let goal = makeActiveGoal()
    goal = appendAuditEntry(goal, entry(['c1']), 'now1')
    goal = appendAuditEntry(goal, entry(['c1']), 'now2')
    goal = appendAuditEntry(goal, entry(['c1']), 'now3')
    expect(shouldAutoBlock(goal, TASK_GOAL_BLOCKED_THRESHOLD)).toBe(true)
    const blocked = transitionGoalStatus(goal, 'blocked', '2026-05-26T00:04:00.000Z')
    expect(blocked.status).toBe('blocked')
    expect(blocked.completed_at).toBe('2026-05-26T00:04:00.000Z')
  })
})
