import { describe, expect, it } from 'vitest'
import { buildNewTaskGoal } from './task-goal.js'
import type { TaskGoal, TaskGoalStatus, AcceptanceCriterion } from './types.js'

// 测试 handleSetTaskGoal 的核心契约：
// - task.goal === undefined → 允许 buildNewTaskGoal + 覆盖
// - task.goal.status === 'active' → 拒绝
// - task.goal.status ∈ {blocked, cleared, complete, budget_limited} → 允许覆盖
//
// 集成层（handler 真跑）走 Task 7 E2E。这里测策略函数。

function makeGoal(status: TaskGoalStatus): TaskGoal {
  return {
    objective: 'old',
    acceptance_criteria: [{ id: 'c1', kind: 'semantic', spec: 'x' }],
    status,
    tokens_used: 0,
    audit_history: [],
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:00.000Z',
    ...(status !== 'active' ? { completed_at: '2026-05-26T00:01:00.000Z' } : {}),
  }
}

/** handleSetTaskGoal 的"拒绝判定"提取为纯策略函数便于测试。
 *  实际 handler 内联使用同样逻辑（见 Task 5 Step 3）。 */
function shouldRejectSetTaskGoal(existingGoal: TaskGoal | undefined): boolean {
  return existingGoal?.status === 'active'
}

describe('handleSetTaskGoal 拒绝策略：仅 active 拒绝，terminal 放行', () => {
  it('无 goal → 允许', () => {
    expect(shouldRejectSetTaskGoal(undefined)).toBe(false)
  })
  it('active goal → 拒绝（反 specification-gaming）', () => {
    expect(shouldRejectSetTaskGoal(makeGoal('active'))).toBe(true)
  })
  it('blocked goal → 允许（master/系统已判定原方向走不通，agent 可重写承诺）', () => {
    expect(shouldRejectSetTaskGoal(makeGoal('blocked'))).toBe(false)
  })
  it('cleared goal → 允许（master 主动清除，agent 可重新承诺）', () => {
    expect(shouldRejectSetTaskGoal(makeGoal('cleared'))).toBe(false)
  })
  it('complete goal → 允许（按上下文 agent 自定是否开启新目标）', () => {
    expect(shouldRejectSetTaskGoal(makeGoal('complete'))).toBe(false)
  })
  it('budget_limited goal → 允许', () => {
    expect(shouldRejectSetTaskGoal(makeGoal('budget_limited'))).toBe(false)
  })
})

describe('buildNewTaskGoal 仍按现有约束工作', () => {
  it('给定合法 params 构造 active goal（用于覆盖旧 terminal goal）', () => {
    const criteria: AcceptanceCriterion[] = [{ id: 'new-c1', kind: 'semantic', spec: 'new' }]
    const g = buildNewTaskGoal({ objective: 'new', acceptance_criteria: criteria }, '2026-05-26T00:05:00.000Z')
    expect(g.objective).toBe('new')
    expect(g.status).toBe('active')
    expect(g.audit_history).toEqual([])
  })
})
