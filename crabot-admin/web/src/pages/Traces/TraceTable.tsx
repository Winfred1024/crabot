import React, { useState } from 'react'
import {
  type TraceIndexEntry,
  type TokenUsage,
} from '../../services/trace'
import {
  formatTime,
  formatDuration,
  formatTokens,
  statusColor,
  triggerTypeLabel,
  triggerTypeColor,
  totalPromptTokens,
  cacheHitRate,
  type TraceGroup,
} from './utils'

// ============================================================================
// 子组件：TokenUsageCell — 紧凑显示 token 用量
// ============================================================================

export function TokenUsageCell({ usage }: { usage?: TokenUsage }) {
  if (!usage || (usage.input_tokens === 0 && usage.output_tokens === 0 && !usage.cache_read_tokens && !usage.cache_creation_tokens)) {
    return <span style={{ color: '#9ca3af' }}>-</span>
  }
  const cacheRead = usage.cache_read_tokens ?? 0
  const cacheCreate = usage.cache_creation_tokens ?? 0
  const promptTotal = totalPromptTokens(usage)
  const hitRate = cacheHitRate(usage)
  const hasCache = cacheRead > 0 || cacheCreate > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.25 }}>
      <div
        style={{ fontSize: 12, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}
        title={`未命中输入 ${usage.input_tokens} → 输出 ${usage.output_tokens}`}
      >
        <span>{formatTokens(usage.input_tokens)}</span>
        <span style={{ color: '#9ca3af', margin: '0 3px' }}>→</span>
        <span>{formatTokens(usage.output_tokens)}</span>
      </div>
      {hasCache ? (
        <div
          style={{ fontSize: 10, color: '#10b981', fontVariantNumeric: 'tabular-nums', display: 'flex', gap: 4, alignItems: 'center' }}
          title={`全量 prompt ${promptTotal}，缓存命中率 ${(hitRate * 100).toFixed(0)}%`}
        >
          <span>●</span>
          {cacheRead > 0 && <span>命中 {formatTokens(cacheRead)} ({(hitRate * 100).toFixed(0)}%)</span>}
          {cacheRead === 0 && cacheCreate > 0 && <span>写入 {formatTokens(cacheCreate)}</span>}
          {cacheRead > 0 && cacheCreate > 0 && <span style={{ color: '#0ea5e9' }}>+ 写入 {formatTokens(cacheCreate)}</span>}
        </div>
      ) : (
        <div style={{ fontSize: 10, color: '#9ca3af' }} title="无缓存命中">
          <span>○ 无缓存</span>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 子组件：StatusDot
// ============================================================================

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: statusColor(status),
        flexShrink: 0,
      }}
    />
  )
}

// ============================================================================
// 子组件：TriggerBadge
// ============================================================================

export function TriggerBadge({ type }: { type: string }) {
  const label = triggerTypeLabel[type] ?? type
  const color = triggerTypeColor[type] ?? '#6b7280'
  return (
    <span
      style={{
        background: color,
        color: '#fff',
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 3,
        fontWeight: 500,
        letterSpacing: 0.2,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  )
}

// ============================================================================
// 子组件：TraceLink
// ============================================================================

export function TraceLink({ traceId, onNavigate }: { traceId: string; onNavigate?: (id: string) => void }) {
  return (
    <span
      style={{ color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' }}
      onClick={() => onNavigate?.(traceId)}
    >
      {traceId.slice(0, 8)}... →
    </span>
  )
}

// ============================================================================
// 子组件：TraceTableRow
// ============================================================================

export function TraceTableRow({
  entry,
  isSelected,
  onClick,
  onFilterByTask,
  onJumpToTrace,
}: {
  entry: TraceIndexEntry
  isSelected: boolean
  onClick: () => void
  onFilterByTask?: (taskId: string) => void
  onJumpToTrace?: (traceId: string) => void
}) {
  const taskId = entry.related_task_id
  const parentTraceId = entry.parent_trace_id

  return (
    <tr
      onClick={onClick}
      style={{
        cursor: 'pointer',
        background: isSelected ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : undefined,
        borderBottom: '1px solid var(--border)',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = 'var(--bg-hover, rgba(0,0,0,0.02))'
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLTableRowElement).style.background = ''
      }}
    >
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <StatusDot status={entry.status} />
      </td>
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <TriggerBadge type={entry.trigger_type} />
      </td>
      <td
        style={{
          padding: '8px 10px',
          maxWidth: 320,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 13,
        }}
        title={entry.trigger_summary}
      >
        {entry.trigger_summary || <span style={{ color: '#9ca3af' }}>(空)</span>}
      </td>
      <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {taskId && onFilterByTask && (
            <span
              onClick={(e) => { e.stopPropagation(); onFilterByTask(taskId) }}
              title={`属于任务 ${taskId}\n点击：仅看此任务的所有 trace`}
              style={{
                fontSize: 10,
                padding: '1px 5px',
                background: 'rgba(99,102,241,0.12)',
                color: '#6366f1',
                borderRadius: 3,
                fontFamily: 'monospace',
                cursor: 'pointer',
              }}
            >
              🔗 {taskId.slice(0, 6)}
            </span>
          )}
          {parentTraceId && onJumpToTrace && (
            <span
              onClick={(e) => { e.stopPropagation(); onJumpToTrace(parentTraceId) }}
              title={`父 trace ${parentTraceId}\n点击：跳转到父 trace`}
              style={{
                fontSize: 10,
                padding: '1px 5px',
                background: 'rgba(236,72,153,0.12)',
                color: '#ec4899',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              ↑ parent
            </span>
          )}
        </div>
      </td>
      <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
        {formatTime(entry.started_at)}
      </td>
      <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {formatDuration(entry.duration_ms)}
      </td>
      <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
        <TokenUsageCell usage={entry.total_usage} />
      </td>
      <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {entry.span_count}
      </td>
    </tr>
  )
}

// ============================================================================
// 子组件：GroupedTableRow — 聚合视图的折叠组
// ============================================================================

export function GroupedTableRow({
  group,
  selectedTraceId,
  onSelectTrace,
  onFilterByTask,
  onJumpToTrace,
  defaultExpanded,
}: {
  group: TraceGroup
  selectedTraceId: string | null
  onSelectTrace: (traceId: string) => void
  onFilterByTask: (taskId: string) => void
  onJumpToTrace: (traceId: string) => void
  defaultExpanded: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const groupContainsSelected = group.members.some((m) => m.trace_id === selectedTraceId)

  // 单成员组：直接当扁平行渲染（不折叠）
  if (group.members.length === 1) {
    return (
      <TraceTableRow
        entry={group.primary}
        isSelected={selectedTraceId === group.primary.trace_id}
        onClick={() => onSelectTrace(group.primary.trace_id)}
        onFilterByTask={group.taskId ? onFilterByTask : undefined}
        onJumpToTrace={onJumpToTrace}
      />
    )
  }

  return (
    <>
      <tr
        onClick={() => setExpanded((v) => !v)}
        style={{
          cursor: 'pointer',
          background: groupContainsSelected ? 'var(--bg-highlight, rgba(99,102,241,0.06))' : 'rgba(99,102,241,0.03)',
          borderBottom: '1px solid var(--border)',
          borderTop: '1px solid rgba(99,102,241,0.2)',
        }}
      >
        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 12, color: '#6366f1', fontSize: 10 }}>
              {expanded ? '▼' : '▶'}
            </span>
            <StatusDot status={group.status} />
          </span>
        </td>
        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
          <span
            style={{
              fontSize: 10,
              padding: '1px 6px',
              background: '#6366f1',
              color: '#fff',
              borderRadius: 3,
              fontWeight: 600,
              letterSpacing: 0.3,
            }}
          >
            TASK · {group.members.length}
          </span>
        </td>
        <td
          style={{
            padding: '8px 10px',
            maxWidth: 320,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13,
            fontWeight: 500,
          }}
          title={group.primary.trigger_summary}
        >
          {group.primary.trigger_summary || <span style={{ color: '#9ca3af' }}>(空)</span>}
        </td>
        <td style={{ padding: '8px 6px', whiteSpace: 'nowrap' }}>
          {group.taskId && (
            <span
              onClick={(e) => { e.stopPropagation(); onFilterByTask(group.taskId!) }}
              title={`仅看此任务`}
              style={{
                fontSize: 10,
                padding: '1px 5px',
                background: 'rgba(99,102,241,0.12)',
                color: '#6366f1',
                borderRadius: 3,
                fontFamily: 'monospace',
                cursor: 'pointer',
              }}
            >
              🔗 {group.taskId.slice(0, 6)}
            </span>
          )}
        </td>
        <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          {formatTime(group.earliestStartedAt)}
        </td>
        <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {formatDuration(group.totalDurationMs)}
        </td>
        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
          <TokenUsageCell usage={group.totalUsage} />
        </td>
        <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-secondary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {group.totalSpans}
        </td>
      </tr>
      {expanded && group.members.map((m) => (
        <tr
          key={m.trace_id}
          onClick={() => onSelectTrace(m.trace_id)}
          style={{
            cursor: 'pointer',
            background: selectedTraceId === m.trace_id ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : undefined,
            borderBottom: '1px solid var(--border)',
          }}
        >
          <td style={{ padding: '6px 10px', paddingLeft: 28, whiteSpace: 'nowrap' }}>
            <span style={{ color: '#9ca3af', marginRight: 4 }}>└</span>
            <StatusDot status={m.status} />
          </td>
          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
            <TriggerBadge type={m.trigger_type} />
          </td>
          <td
            style={{
              padding: '6px 10px',
              maxWidth: 320,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              color: 'var(--text-secondary)',
            }}
            title={m.trigger_summary}
          >
            {m.trigger_summary || <span style={{ color: '#9ca3af' }}>(空)</span>}
          </td>
          <td style={{ padding: '6px 6px', whiteSpace: 'nowrap' }}>
            {m.parent_trace_id && (
              <span
                onClick={(e) => { e.stopPropagation(); onJumpToTrace(m.parent_trace_id!) }}
                title={`父 trace ${m.parent_trace_id}`}
                style={{
                  fontSize: 10,
                  padding: '1px 5px',
                  background: 'rgba(236,72,153,0.12)',
                  color: '#ec4899',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                ↑ parent
              </span>
            )}
          </td>
          <td style={{ padding: '6px 10px', fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
            {formatTime(m.started_at)}
          </td>
          <td style={{ padding: '6px 10px', fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {formatDuration(m.duration_ms)}
          </td>
          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
            <TokenUsageCell usage={m.total_usage} />
          </td>
          <td style={{ padding: '6px 10px', fontSize: 11, color: '#9ca3af', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {m.span_count}
          </td>
        </tr>
      ))}
    </>
  )
}

// ============================================================================
// 子组件：TraceChip — 关联 trace 小徽章（供 TraceDetailPanel 使用）
// ============================================================================

export function TraceChip({
  entry,
  current,
  onClick,
}: {
  entry: TraceIndexEntry
  current: boolean
  onClick: () => void
}) {
  return (
    <span
      onClick={current ? undefined : onClick}
      title={`${entry.trigger_summary || '(空)'}\n状态：${entry.status}\n${entry.trace_id}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        background: current ? statusColor(entry.status) : 'transparent',
        color: current ? '#fff' : statusColor(entry.status),
        border: `1px solid ${statusColor(entry.status)}`,
        borderRadius: 10,
        fontSize: 11,
        fontFamily: 'monospace',
        cursor: current ? 'default' : 'pointer',
        fontWeight: current ? 600 : 500,
      }}
    >
      {entry.trace_id.slice(0, 6)}
      {current && <span style={{ fontSize: 9 }}>● 当前</span>}
    </span>
  )
}
