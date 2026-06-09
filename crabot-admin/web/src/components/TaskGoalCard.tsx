import React from 'react'
import type { TaskGoal, TaskGoalStatus } from '../types'

/**
 * 把 task.goal 渲染成只读卡片。
 *
 * 调用方负责：传 task.goal !== undefined 才渲染。
 *
 * spec: crabot-docs/superpowers/specs/2026-05-23-goal-mode-design.md §8.1
 */

const STATUS_LABEL: Record<TaskGoalStatus, string> = {
  active: '执行中',
  complete: '已完成',
  blocked: '已阻塞',
  budget_limited: '预算耗尽',
  cleared: '已清除',
}

const STATUS_COLOR: Record<TaskGoalStatus, string> = {
  active: '#3b82f6',
  complete: '#10b981',
  blocked: '#ef4444',
  budget_limited: '#f59e0b',
  cleared: '#6b7280',
}

function statusLabel(s: TaskGoalStatus): string {
  return STATUS_LABEL[s] ?? s
}

export interface TaskGoalCardProps {
  goal: TaskGoal
}

const AUDIT_HISTORY_MAX = 5

export const TaskGoalCard: React.FC<TaskGoalCardProps> = ({ goal }) => {
  const recentAudits = goal.audit_history.slice(-AUDIT_HISTORY_MAX).reverse()
  const totalAudits = goal.audit_history.length
  const hasBudget = goal.token_budget !== undefined

  return (
    <section
      style={{ marginTop: 16 }}
      data-testid="task-goal-card"
      aria-label="任务目标"
    >
      <h4 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600 }}>
        任务目标（agent 自定）
      </h4>
      <div
        style={{
          background: 'var(--bg-secondary, #fafafa)',
          padding: 12,
          borderRadius: 4,
          border: '1px solid var(--border)',
          fontSize: 13,
        }}
      >
        <div style={{ marginBottom: 10, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
          {goal.objective}
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary, #666)', marginBottom: 10 }}>
          <span>状态：</span>
          <strong style={{ color: STATUS_COLOR[goal.status] ?? '#6b7280' }}>
            {statusLabel(goal.status)}
          </strong>
          {hasBudget && (
            <span style={{ marginLeft: 12 }}>
              Token：{goal.tokens_used.toLocaleString()} / {goal.token_budget!.toLocaleString()}
            </span>
          )}
          {!hasBudget && goal.tokens_used > 0 && (
            <span style={{ marginLeft: 12 }}>
              Token 已用：{goal.tokens_used.toLocaleString()}
            </span>
          )}
        </div>

        <div style={{ marginBottom: 10 }}>
          <strong style={{ fontSize: 12 }}>
            验收条件（{goal.acceptance_criteria.length} 条）
          </strong>
          {goal.acceptance_criteria.length === 0 ? (
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-muted)' }}>
              （无）
            </div>
          ) : (
            <ul style={{ fontSize: 12, paddingLeft: 20, margin: '4px 0 0 0' }}>
              {goal.acceptance_criteria.map((c) => (
                <li key={c.id} style={{ marginBottom: 4 }}>
                  <code style={{ fontSize: 11 }}>{c.id}</code>
                  <span style={{ color: 'var(--text-muted)' }}> ({c.kind}): </span>
                  <span style={{ whiteSpace: 'pre-wrap' }}>{c.spec}</span>
                  {c.rationale && (
                    <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 2 }}>
                      — {c.rationale}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {totalAudits > 0 && (
          <div style={{ marginBottom: 10 }}>
            <strong style={{ fontSize: 12 }}>
              审计历史（{totalAudits} 次{totalAudits > AUDIT_HISTORY_MAX ? `，最近 ${AUDIT_HISTORY_MAX} 条` : ''}）
            </strong>
            <ul style={{ fontSize: 12, paddingLeft: 20, margin: '4px 0 0 0' }}>
              {recentAudits.map((h, i) => (
                <li
                  key={`${h.at}-${i}`}
                  style={{ color: h.pass ? 'var(--success)' : 'var(--error)', marginBottom: 2 }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                    {h.at}
                  </span>
                  {': '}
                  {h.pass ? (
                    <span>通过</span>
                  ) : (
                    <span>
                      未通过（{h.failed_criteria.length > 0 ? h.failed_criteria.join(', ') : '原因未指明'}）
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

      </div>
    </section>
  )
}
