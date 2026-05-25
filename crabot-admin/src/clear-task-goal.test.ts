import { describe, expect, it } from 'vitest'
import { transitionGoalStatus } from './task-goal.js'
import type { TaskGoal } from './types.js'

// 单元层只校 task-goal.ts 暴露的纯函数；handleClearTaskGoal 的 admin 集成由 Task 5 覆盖
describe('transitionGoalStatus 用于 clear', () => {
  const baseGoal: TaskGoal = {
    objective: 'test',
    acceptance_criteria: [{ id: 'c1', kind: 'semantic', spec: 'x' }],
    status: 'active',
    tokens_used: 0,
    audit_history: [],
    created_at: '2026-05-25T00:00:00.000Z',
    updated_at: '2026-05-25T00:00:00.000Z',
  }

  it('active → cleared 合法', () => {
    const out = transitionGoalStatus(baseGoal, 'cleared', '2026-05-25T01:00:00.000Z')
    expect(out.status).toBe('cleared')
    expect(out.completed_at).toBe('2026-05-25T01:00:00.000Z')
    expect(out.updated_at).toBe('2026-05-25T01:00:00.000Z')
  })

  it('已 cleared 再次 cleared 幂等', () => {
    const cleared = transitionGoalStatus(baseGoal, 'cleared', '2026-05-25T01:00:00.000Z')
    const second = transitionGoalStatus(cleared, 'cleared', '2026-05-25T02:00:00.000Z')
    // 同状态直接返回，updated_at 不变
    expect(second).toBe(cleared)
  })

  it('complete → cleared 非法（终态不可互转）', () => {
    const completed: TaskGoal = { ...baseGoal, status: 'complete' }
    expect(() => transitionGoalStatus(completed, 'cleared', 'now')).toThrow(/非法状态切换/)
  })
})
