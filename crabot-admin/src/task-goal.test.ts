/**
 * TaskGoal 纯函数测试。
 * spec: 2026-05-23-goal-mode-design.md §3
 */

import { describe, it, expect } from 'vitest'
import {
  isTerminal,
  isValidTransition,
  validateCriteria,
  buildNewTaskGoal,
  appendAuditEntry,
  incrementTokens,
  transitionGoalStatus,
  shouldAutoBlock,
} from './task-goal.js'
import type { AcceptanceCriterion, TaskGoal, TaskGoalAuditEntry } from './types.js'

const NOW = '2026-05-23T00:00:00.000Z'
const LATER = '2026-05-23T01:00:00.000Z'

function sampleCriteria(): AcceptanceCriterion[] {
  return [
    { id: 'c-typecheck', kind: 'cmd', spec: 'pnpm typecheck', expect: { exit_code: 0 } },
    { id: 'c-file', kind: 'file', spec: 'README.md' },
    { id: 'c-sem', kind: 'semantic', spec: '协议字段加齐了' },
  ]
}

function fakeAudit(pass: boolean, failed: string[] = []): TaskGoalAuditEntry {
  return {
    at: NOW,
    pass,
    failed_criteria: pass ? [] : failed,
    audit_trace_id: 'trace-x',
  }
}

describe('isTerminal', () => {
  it('正确识别终态', () => {
    expect(isTerminal('active')).toBe(false)
    expect(isTerminal('complete')).toBe(true)
    expect(isTerminal('blocked')).toBe(true)
    expect(isTerminal('budget_limited')).toBe(true)
    expect(isTerminal('cleared')).toBe(true)
  })
})

describe('isValidTransition', () => {
  it('active → 任意终态合法', () => {
    expect(isValidTransition('active', 'complete')).toBe(true)
    expect(isValidTransition('active', 'blocked')).toBe(true)
    expect(isValidTransition('active', 'budget_limited')).toBe(true)
    expect(isValidTransition('active', 'cleared')).toBe(true)
  })
  it('同状态切换幂等', () => {
    expect(isValidTransition('complete', 'complete')).toBe(true)
    expect(isValidTransition('active', 'active')).toBe(true)
  })
  it('终态 → 其它终态不合法', () => {
    expect(isValidTransition('complete', 'cleared')).toBe(false)
    expect(isValidTransition('blocked', 'complete')).toBe(false)
    expect(isValidTransition('cleared', 'active')).toBe(false)
  })
})

describe('validateCriteria', () => {
  it('合法 criteria 不抛错', () => {
    expect(() => validateCriteria(sampleCriteria())).not.toThrow()
  })
  it('空列表 → 抛错', () => {
    expect(() => validateCriteria([])).toThrow(/至少需要 1 条/)
  })
  it('id 重复 → 抛错', () => {
    expect(() => validateCriteria([
      { id: 'a', kind: 'cmd', spec: 'true' },
      { id: 'a', kind: 'file', spec: 'README.md' },
    ])).toThrow(/id 重复/)
  })
  it('id 为空 → 抛错', () => {
    expect(() => validateCriteria([
      { id: '   ', kind: 'cmd', spec: 'true' },
    ])).toThrow(/id 不能为空/)
  })
  it('spec 为空 → 抛错', () => {
    expect(() => validateCriteria([
      { id: 'a', kind: 'cmd', spec: '' },
    ])).toThrow(/spec 不能为空/)
  })
  it('stdout_matches 非法正则 → 抛错', () => {
    expect(() => validateCriteria([
      { id: 'a', kind: 'cmd', spec: 'true', expect: { stdout_matches: '(' } },
    ])).toThrow(/不是合法正则/)
  })
})

describe('buildNewTaskGoal', () => {
  it('成功构造 active 初值', () => {
    const g = buildNewTaskGoal({
      objective: '加 goal 模式',
      acceptance_criteria: sampleCriteria(),
    }, NOW)
    expect(g.status).toBe('active')
    expect(g.tokens_used).toBe(0)
    expect(g.audit_history).toEqual([])
    expect(g.created_at).toBe(NOW)
    expect(g.updated_at).toBe(NOW)
    expect(g.completed_at).toBeUndefined()
  })
  it('objective 为空 → 抛错', () => {
    expect(() => buildNewTaskGoal({
      objective: '   ',
      acceptance_criteria: sampleCriteria(),
    }, NOW)).toThrow(/objective 不能为空/)
  })
  it('记录 token_budget', () => {
    const g = buildNewTaskGoal({
      objective: 'x',
      acceptance_criteria: sampleCriteria(),
      token_budget: 100_000,
    }, NOW)
    expect(g.token_budget).toBe(100_000)
  })
  it('token_budget <= 0 → 抛错', () => {
    expect(() => buildNewTaskGoal({
      objective: 'x',
      acceptance_criteria: sampleCriteria(),
      token_budget: 0,
    }, NOW)).toThrow(/必须是正数/)
  })
})

describe('appendAuditEntry', () => {
  function freshGoal(): TaskGoal {
    return buildNewTaskGoal({ objective: 'x', acceptance_criteria: sampleCriteria() }, NOW)
  }
  it('最新的在前', () => {
    let g = freshGoal()
    g = appendAuditEntry(g, fakeAudit(false, ['c-typecheck']), NOW)
    g = appendAuditEntry(g, fakeAudit(true), LATER)
    expect(g.audit_history).toHaveLength(2)
    expect(g.audit_history[0]!.pass).toBe(true)
    expect(g.audit_history[1]!.pass).toBe(false)
  })
  it('非 active goal 不可追加', () => {
    const g = transitionGoalStatus(freshGoal(), 'cleared', NOW)
    expect(() => appendAuditEntry(g, fakeAudit(false, ['x']), NOW)).toThrow(/非 active/)
  })
})

describe('incrementTokens', () => {
  function freshGoal(budget?: number): TaskGoal {
    return buildNewTaskGoal({
      objective: 'x',
      acceptance_criteria: sampleCriteria(),
      ...(budget !== undefined ? { token_budget: budget } : {}),
    }, NOW)
  }
  it('累加 tokens_used', () => {
    let g = freshGoal()
    g = incrementTokens(g, 100, NOW)
    g = incrementTokens(g, 200, NOW)
    expect(g.tokens_used).toBe(300)
    expect(g.status).toBe('active')
  })
  it('超过 token_budget → 切 budget_limited', () => {
    let g = freshGoal(500)
    g = incrementTokens(g, 200, NOW)
    expect(g.status).toBe('active')
    g = incrementTokens(g, 400, LATER)
    expect(g.status).toBe('budget_limited')
    expect(g.tokens_used).toBe(600)
    expect(g.completed_at).toBe(LATER)
  })
  it('未设 budget 不会触发 limited', () => {
    let g = freshGoal()
    g = incrementTokens(g, 10_000_000, NOW)
    expect(g.status).toBe('active')
  })
  it('非 active goal noop', () => {
    let g = freshGoal()
    g = transitionGoalStatus(g, 'cleared', NOW)
    const after = incrementTokens(g, 100, LATER)
    expect(after.tokens_used).toBe(0)
  })
  it('delta < 0 抛错', () => {
    const g = freshGoal()
    expect(() => incrementTokens(g, -1, NOW)).toThrow(/delta 必须 >= 0/)
  })
})

describe('transitionGoalStatus', () => {
  function freshGoal(): TaskGoal {
    return buildNewTaskGoal({ objective: 'x', acceptance_criteria: sampleCriteria() }, NOW)
  }
  it('active → complete 设 completed_at', () => {
    const g = transitionGoalStatus(freshGoal(), 'complete', LATER)
    expect(g.status).toBe('complete')
    expect(g.completed_at).toBe(LATER)
  })
  it('幂等同状态切换', () => {
    const g = freshGoal()
    const same = transitionGoalStatus(g, 'active', LATER)
    expect(same).toBe(g)
  })
  it('非法切换抛错', () => {
    const g = transitionGoalStatus(freshGoal(), 'complete', NOW)
    expect(() => transitionGoalStatus(g, 'active', LATER)).toThrow(/非法状态切换/)
  })
})

describe('shouldAutoBlock', () => {
  function freshGoal(history: TaskGoalAuditEntry[]): TaskGoal {
    return { ...buildNewTaskGoal({ objective: 'x', acceptance_criteria: sampleCriteria() }, NOW), audit_history: history }
  }
  it('少于 N 次不 block', () => {
    const g = freshGoal([fakeAudit(false, ['a']), fakeAudit(false, ['a'])])
    expect(shouldAutoBlock(g, 3)).toBe(false)
  })
  it('N 次同 failed_criteria → 应 block', () => {
    const g = freshGoal([
      fakeAudit(false, ['a', 'b']),
      fakeAudit(false, ['b', 'a']),
      fakeAudit(false, ['a', 'b']),
    ])
    expect(shouldAutoBlock(g, 3)).toBe(true)
  })
  it('failed_criteria 不同 → 不 block', () => {
    const g = freshGoal([
      fakeAudit(false, ['a']),
      fakeAudit(false, ['b']),
      fakeAudit(false, ['a']),
    ])
    expect(shouldAutoBlock(g, 3)).toBe(false)
  })
  it('最近 N 次里有 pass → 不 block', () => {
    const g = freshGoal([
      fakeAudit(false, ['a']),
      fakeAudit(true),
      fakeAudit(false, ['a']),
    ])
    expect(shouldAutoBlock(g, 3)).toBe(false)
  })
})
