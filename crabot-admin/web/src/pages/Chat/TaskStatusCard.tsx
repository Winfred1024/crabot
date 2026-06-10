import React from 'react'
import { useNavigate } from 'react-router-dom'
import type { ChatTaskSnapshot } from '../../types/chat'

/** 任务状态 → 展示样式。未知状态按"执行中"渲染（向前兼容新状态值） */
const STATUS_STYLES: Record<string, { label: string; color: string; spinning?: boolean }> = {
  pending: { label: '排队中', color: 'var(--info)', spinning: true },
  planning: { label: '规划中', color: 'var(--info)', spinning: true },
  executing: { label: '执行中', color: 'var(--info)', spinning: true },
  waiting: { label: '等待子任务', color: 'var(--warning)' },
  waiting_human: { label: '等待回复', color: 'var(--warning)' },
  completed: { label: '已完成', color: 'var(--success)' },
  failed: { label: '执行失败', color: 'var(--error)' },
  cancelled: { label: '已取消', color: 'var(--text-secondary)' },
}

interface TaskStatusCardProps {
  taskId: string
  /** 快照可能尚未 hydrate（404 / 加载中）——此时降级为纯链接 */
  snapshot?: ChatTaskSnapshot
}

export const TaskStatusCard: React.FC<TaskStatusCardProps> = ({ taskId, snapshot }) => {
  const navigate = useNavigate()
  const style = STATUS_STYLES[snapshot?.status ?? ''] ?? STATUS_STYLES.executing

  return (
    <div
      style={{
        marginTop: '0.5rem',
        padding: '0.75rem',
        borderRadius: '8px',
        border: '1px solid var(--border)',
        backgroundColor: 'var(--surface)',
      }}
    >
      {snapshot ? (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            {style.spinning ? (
              <div className="spinner" style={{ width: '12px', height: '12px', borderWidth: '2px' }} />
            ) : (
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: style.color }} />
            )}
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: style.color }}>{style.label}</span>
            <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>{snapshot.title}</span>
          </div>
          {snapshot.step && (
            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
              进度 {snapshot.step.index + 1}/{snapshot.step.total}：{snapshot.step.description}
            </div>
          )}
        </>
      ) : (
        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
          关联任务 {taskId.slice(0, 12)}
        </div>
      )}
      <button
        onClick={() => navigate(`/traces?task_id=${encodeURIComponent(taskId)}`)}
        style={{
          padding: '0.3rem 0.6rem',
          fontSize: '0.8rem',
          background: 'transparent',
          color: 'var(--primary)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          cursor: 'pointer',
        }}
      >
        查看执行详情 →
      </button>
    </div>
  )
}
