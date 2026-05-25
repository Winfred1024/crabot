import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TaskGoalCard } from './TaskGoalCard'
import type { TaskGoal } from '../types'

function makeGoal(over: Partial<TaskGoal> = {}): TaskGoal {
  return {
    objective: '把 README 翻成中文',
    acceptance_criteria: [
      {
        id: 'AC-1',
        kind: 'file',
        spec: 'README.zh.md 存在且非空',
        rationale: '产物要可见',
      },
    ],
    status: 'active',
    tokens_used: 1234,
    audit_history: [],
    created_at: '2026-05-20T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
    ...over,
  }
}

describe('TaskGoalCard', () => {
  it('渲染 objective / 验收条件 / 状态', () => {
    render(<TaskGoalCard goal={makeGoal()} />)
    expect(screen.getByText('把 README 翻成中文')).toBeInTheDocument()
    expect(screen.getByText(/AC-1/)).toBeInTheDocument()
    expect(screen.getByText(/README\.zh\.md 存在且非空/)).toBeInTheDocument()
    // 状态：active -> 执行中
    expect(screen.getByText('执行中')).toBeInTheDocument()
  })

  it('有 token_budget 时显示 used/budget', () => {
    render(<TaskGoalCard goal={makeGoal({ token_budget: 50000 })} />)
    expect(screen.getByText(/Token：1,234 \/ 50,000/)).toBeInTheDocument()
  })

  it('audit_history 倒序显示 pass/fail', () => {
    render(
      <TaskGoalCard
        goal={makeGoal({
          audit_history: [
            { at: '2026-05-20T01:00:00Z', pass: false, failed_criteria: ['AC-1'], audit_trace_id: 'tr-1' },
            { at: '2026-05-20T02:00:00Z', pass: true, failed_criteria: [], audit_trace_id: 'tr-2' },
          ],
        })}
      />,
    )
    // 标题"审计历史（2 次）"
    expect(screen.getByText(/审计历史（2 次/)).toBeInTheDocument()
    expect(screen.getByText('通过')).toBeInTheDocument()
    expect(screen.getByText(/未通过（AC-1）/)).toBeInTheDocument()
  })

  it('清除按钮已废弃：active 状态也不显示（master 改用 /清除目标 slash）', () => {
    render(<TaskGoalCard goal={makeGoal({ status: 'active' })} />)
    expect(screen.queryByRole('button', { name: /清除当前 goal/ })).toBeNull()
  })

  it('非 active 状态不显示清除按钮', () => {
    render(<TaskGoalCard goal={makeGoal({ status: 'complete' })} />)
    expect(screen.queryByRole('button', { name: /清除当前 goal/ })).toBeNull()
    expect(screen.getByText('已完成')).toBeInTheDocument()
  })
})
