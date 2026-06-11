/**
 * 进行中任务条：仅显示非终态任务，执行中任务不随滚动消失。
 * 终态任务（completed/failed/cancelled）从条中移除，结果本身是一条回复消息。
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChatTaskSnapshot } from '../../types/chat'

/** 终态任务状态集合 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/** 旋转中状态（pending/planning/executing）*/
const SPINNING_STATUSES = new Set(['pending', 'planning', 'executing'])

/** 等待中状态 → 黄色圆点 */
const WAITING_STATUSES: Record<string, string> = {
  waiting: '等待中',
  waiting_human: '等回复',
}

interface ActiveTasksBarProps {
  tasks: ChatTaskSnapshot[]
}

export const ActiveTasksBar: React.FC<ActiveTasksBarProps> = ({ tasks }) => {
  const navigate = useNavigate()

  // 空数组渲染 null
  if (tasks.length === 0) return null

  // 防御性过滤：终态任务不在条中显示（正常由 chat_task_update 移除，此处兜底）
  const activeTasks = tasks.filter((t) => !TERMINAL_STATUSES.has(t.status))
  if (activeTasks.length === 0) return null

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.4rem',
        marginBottom: '0.5rem',
      }}
    >
      {activeTasks.map((task) => {
        const isSpinning = SPINNING_STATUSES.has(task.status)
        const waitingLabel = WAITING_STATUSES[task.status]

        return (
          <div
            key={task.task_id}
            onClick={() => navigate(`/traces?task_id=${encodeURIComponent(task.task_id)}`)}
            title={task.title}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              padding: '0.3rem 0.6rem',
              fontSize: '0.8rem',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--surface)',
              borderRadius: '8px',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            {/* 状态指示器 */}
            {isSpinning ? (
              <div className="spinner" style={{ width: 10, height: 10, borderWidth: 2, flexShrink: 0 }} />
            ) : waitingLabel ? (
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: 'var(--warning)',
                  flexShrink: 0,
                }}
              />
            ) : (
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: 'var(--text-secondary)',
                  flexShrink: 0,
                }}
              />
            )}

            {/* 任务标题（截断） */}
            <span
              style={{
                maxWidth: 200,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--text-primary)',
              }}
            >
              {task.title}
            </span>

            {/* 等待中状态文案 */}
            {waitingLabel && (
              <span style={{ color: 'var(--warning)', flexShrink: 0 }}>{waitingLabel}</span>
            )}

            {/* 进度 n/m（snapshot.step 存在时） */}
            {task.step && (
              <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
                {task.step.index + 1}/{task.step.total}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
