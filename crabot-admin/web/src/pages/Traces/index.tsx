import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import {
  traceService,
  totalPromptTokens,
  cacheHitRate,
  type AgentTrace,
  type AgentSpan,
  type AgentSpanType,
  type TraceIndexEntry,
  type TokenUsage,
  type SearchTracesParams,
} from '../../services/trace'

// ============================================================================
// 常量与格式化
// ============================================================================

const PAGE_SIZE = 20
const LIST_REFRESH_MS = 10_000      // 列表轮询：10s
const DETAIL_REFRESH_MS = 3_000     // 详情轮询（仅 running trace）：3s

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}m${s}s`
}

function formatTokens(n?: number): string {
  if (n === undefined || n === null || n === 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatTime(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour12: false })
  }
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatDateTimeLocal(iso?: string): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function spanTypeLabel(type: AgentSpanType): string {
  const map: Record<AgentSpanType, string> = {
    agent_loop: 'loop',
    llm_call: 'llm',
    tool_call: 'tool',
    sub_agent_call: 'sub-agent',
    decision: 'decision',
    context_assembly: 'ctx',
    context_fetch: 'fetch',
    memory_write: 'mem-w',
    rpc_call: 'rpc',
    bg_entity_exit: 'bg-exit',
    bg_entity_spawn: 'bg-spawn',
    bg_entity_output: 'bg-out',
    bg_entity_kill: 'bg-kill',
    llm_retry: 'retry',
  }
  return map[type] ?? type
}

function spanTypeBg(type: AgentSpanType): string {
  const map: Record<AgentSpanType, string> = {
    agent_loop: '#3b82f6',
    llm_call: '#8b5cf6',
    tool_call: '#f59e0b',
    sub_agent_call: '#ec4899',
    decision: '#10b981',
    context_assembly: '#0ea5e9',
    context_fetch: '#06b6d4',
    memory_write: '#14b8a6',
    rpc_call: '#6366f1',
    bg_entity_exit: '#84cc16',
    bg_entity_spawn: '#84cc16',
    bg_entity_output: '#84cc16',
    bg_entity_kill: '#84cc16',
    llm_retry: '#fb923c',
  }
  return map[type] ?? '#6b7280'
}

function statusColor(status: string): string {
  if (status === 'completed') return '#10b981'
  if (status === 'failed') return '#ef4444'
  return '#f59e0b'
}

const triggerTypeLabel: Record<string, string> = {
  message: 'Front',
  task: 'Worker',
  sub_agent_call: 'Sub-agent',
  schedule: 'Schedule',
}

const triggerTypeColor: Record<string, string> = {
  message: '#3b82f6',
  task: '#8b5cf6',
  sub_agent_call: '#ec4899',
  schedule: '#10b981',
}

// ============================================================================
// 子组件：TokenUsageBadge — 紧凑显示 token 用量
// ============================================================================

function TokenUsageCell({ usage }: { usage?: TokenUsage }) {
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

function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
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

function TriggerBadge({ type }: { type: string }) {
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
// 子组件：FilterBar
// ============================================================================

interface FilterState {
  keyword: string
  status: '' | 'running' | 'completed' | 'failed'
  range: 'all' | 'today' | '24h' | '7d' | 'custom'
  customStart: string
  customEnd: string
  /** 仅看某个任务的所有 trace（fronts / worker / sub-agents） */
  taskId: string
}

const DEFAULT_FILTER: FilterState = {
  keyword: '',
  status: '',
  range: 'all',
  customStart: '',
  customEnd: '',
  taskId: '',
}

function rangeToISO(range: FilterState['range'], customStart: string, customEnd: string): { start?: string; end?: string } {
  const now = new Date()
  if (range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return { start: start.toISOString() }
  }
  if (range === '24h') {
    return { start: new Date(now.getTime() - 24 * 3600_000).toISOString() }
  }
  if (range === '7d') {
    return { start: new Date(now.getTime() - 7 * 24 * 3600_000).toISOString() }
  }
  if (range === 'custom') {
    return {
      ...(customStart ? { start: new Date(customStart).toISOString() } : {}),
      ...(customEnd ? { end: new Date(customEnd).toISOString() } : {}),
    }
  }
  return {}
}

function FilterBar({
  filter,
  onChange,
  onReset,
}: {
  filter: FilterState
  onChange: (next: FilterState) => void
  onReset: () => void
}) {
  const isFiltered =
    filter.keyword !== '' ||
    filter.status !== '' ||
    filter.range !== 'all' ||
    filter.taskId !== ''

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '8px 12px',
        background: 'var(--bg-secondary, #f9fafb)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        flexWrap: 'wrap',
      }}
    >
      {filter.taskId && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            background: 'rgba(99,102,241,0.12)',
            color: '#6366f1',
            borderRadius: 4,
            fontSize: 12,
            fontFamily: 'monospace',
          }}
        >
          🔗 task: {filter.taskId.slice(0, 12)}
          <button
            onClick={() => onChange({ ...filter, taskId: '' })}
            title="移除任务筛选"
            style={{ marginLeft: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: '#6366f1', fontSize: 14, lineHeight: 1, padding: 0 }}
          >
            ×
          </button>
        </span>
      )}
      <input
        type="text"
        placeholder="🔍 关键字（trigger / outcome）"
        value={filter.keyword}
        onChange={(e) => onChange({ ...filter, keyword: e.target.value })}
        style={{
          flex: '1 1 240px',
          minWidth: 200,
          padding: '6px 10px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 13,
          background: 'var(--bg-primary, #fff)',
        }}
      />
      <select
        value={filter.status}
        onChange={(e) => onChange({ ...filter, status: e.target.value as FilterState['status'] })}
        style={{
          padding: '6px 10px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 13,
          background: 'var(--bg-primary, #fff)',
          cursor: 'pointer',
        }}
      >
        <option value="">全部状态</option>
        <option value="running">运行中</option>
        <option value="completed">完成</option>
        <option value="failed">失败</option>
      </select>
      <select
        value={filter.range}
        onChange={(e) => onChange({ ...filter, range: e.target.value as FilterState['range'] })}
        style={{
          padding: '6px 10px',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 13,
          background: 'var(--bg-primary, #fff)',
          cursor: 'pointer',
        }}
      >
        <option value="all">所有时间</option>
        <option value="today">今天</option>
        <option value="24h">最近 24 小时</option>
        <option value="7d">最近 7 天</option>
        <option value="custom">自定义</option>
      </select>
      {filter.range === 'custom' && (
        <>
          <input
            type="datetime-local"
            value={filter.customStart}
            onChange={(e) => onChange({ ...filter, customStart: e.target.value })}
            style={{
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 13,
            }}
          />
          <span style={{ color: '#9ca3af', fontSize: 13 }}>至</span>
          <input
            type="datetime-local"
            value={filter.customEnd}
            onChange={(e) => onChange({ ...filter, customEnd: e.target.value })}
            style={{
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 13,
            }}
          />
        </>
      )}
      {isFiltered && (
        <button
          onClick={onReset}
          style={{
            padding: '6px 12px',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 12,
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
          }}
        >
          清除筛选
        </button>
      )}
    </div>
  )
}

// ============================================================================
// 子组件：PaginationBar
// ============================================================================

function PaginationBar({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const canPrev = page > 1
  const canNext = page < totalPages
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)

  const btn = (label: string, onClick: () => void, disabled = false) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '4px 10px',
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: disabled ? 'var(--bg-secondary, #f3f4f6)' : 'var(--bg-primary, #fff)',
        color: disabled ? '#9ca3af' : 'var(--text-primary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 12,
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-secondary, #f9fafb)',
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--text-secondary)' }}>
        {total === 0 ? '无数据' : `${from}-${to} / 共 ${total} 条`}
      </span>
      <span style={{ flex: 1 }} />
      {btn('« 首页', () => onChange(1), !canPrev)}
      {btn('‹ 上一页', () => onChange(page - 1), !canPrev)}
      <span style={{ color: 'var(--text-primary)', padding: '0 6px', fontVariantNumeric: 'tabular-nums' }}>
        第 {page} / {totalPages} 页
      </span>
      {btn('下一页 ›', () => onChange(page + 1), !canNext)}
      {btn('末页 »', () => onChange(totalPages), !canNext)}
    </div>
  )
}

// ============================================================================
// 子组件：TraceTableRow
// ============================================================================

function TraceTableRow({
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
// 子组件：SpanDetailPanel — 单个 span 的详情展开
// ============================================================================

function TraceLink({ traceId, onNavigate }: { traceId: string; onNavigate?: (id: string) => void }) {
  return (
    <span
      style={{ color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' }}
      onClick={() => onNavigate?.(traceId)}
    >
      {traceId.slice(0, 8)}... →
    </span>
  )
}

const SpanDetailPanel: React.FC<{
  span: AgentSpan
  onNavigateTrace?: (traceId: string) => void
}> = ({ span, onNavigateTrace }) => {
  const d = span.details as Record<string, unknown>
  const rows: { label: string; value: string | React.ReactNode; monospace?: boolean }[] = []

  if (span.type === 'agent_loop') {
    if (d.loop_label) rows.push({ label: 'Label', value: String(d.loop_label) })
    if (d.model) rows.push({ label: 'Model', value: String(d.model) })
    if (d.iteration_count !== undefined) rows.push({ label: 'Iterations', value: String(d.iteration_count) })
    if (Array.isArray(d.tools) && d.tools.length > 0) {
      rows.push({ label: 'Tools', value: (d.tools as string[]).join(', ') })
    }
    if (Array.isArray(d.mcp_servers) && d.mcp_servers.length > 0) {
      rows.push({
        label: 'MCP Servers',
        value: (d.mcp_servers as Array<{ name: string; status: string }>)
          .map(s => `${s.name}(${s.status})`).join(', '),
      })
    }
    if (Array.isArray(d.skills) && d.skills.length > 0) {
      rows.push({ label: 'Skills', value: (d.skills as string[]).join(', ') })
    }
    if (d.system_prompt) rows.push({ label: 'System Prompt', value: String(d.system_prompt), monospace: true })
  }

  if (span.type === 'llm_call') {
    if (d.iteration !== undefined) rows.push({ label: 'Iteration', value: String(d.iteration) })
    if (d.attempt !== undefined) rows.push({ label: 'Attempt', value: String(d.attempt) })
    if (d.stop_reason) rows.push({ label: 'Stop Reason', value: String(d.stop_reason) })
    if (d.tool_calls_count !== undefined) rows.push({ label: 'Tool Calls', value: String(d.tool_calls_count) })
    const usage = d.usage as TokenUsage | undefined
    if (usage) {
      const cacheRead = usage.cache_read_tokens ?? 0
      const cacheCreate = usage.cache_creation_tokens ?? 0
      const total = totalPromptTokens(usage)
      const hitPct = Math.round(cacheHitRate(usage) * 100)
      rows.push({
        label: 'Tokens',
        value: (
          <div style={{ fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>
            <div>
              <span title="未命中输入">{formatTokens(usage.input_tokens)}</span>
              <span style={{ color: '#9ca3af', margin: '0 4px' }}>未命中 in →</span>
              <span title="输出">{formatTokens(usage.output_tokens)}</span>
              <span style={{ color: '#9ca3af', marginLeft: 4 }}>out</span>
            </div>
            {(cacheRead > 0 || cacheCreate > 0) && (
              <div style={{ color: '#6b7280' }}>
                {cacheRead > 0 && (
                  <span style={{ color: '#10b981' }} title="缓存命中（享受折扣）">
                    cache 命中 {formatTokens(cacheRead)}
                  </span>
                )}
                {cacheRead > 0 && cacheCreate > 0 && <span> · </span>}
                {cacheCreate > 0 && (
                  <span style={{ color: '#0ea5e9' }} title="本次写入缓存">
                    写入 {formatTokens(cacheCreate)}
                  </span>
                )}
                <span style={{ marginLeft: 8, color: '#9ca3af' }}>
                  全量 {formatTokens(total)}
                  {cacheRead > 0 && ` · 命中 ${hitPct}%`}
                </span>
              </div>
            )}
          </div>
        ),
      })
    }
    if (d.input_summary) rows.push({ label: 'Input', value: String(d.input_summary), monospace: true })
    if (d.output_summary) rows.push({ label: 'Output', value: String(d.output_summary), monospace: true })
  }

  if (span.type === 'tool_call') {
    if (d.tool_name) rows.push({ label: 'Tool', value: String(d.tool_name) })
    if (d.input_summary) rows.push({ label: 'Input', value: String(d.input_summary), monospace: true })
    if (d.output_summary) rows.push({ label: 'Output', value: String(d.output_summary), monospace: true })
    if (d.error) rows.push({ label: 'Error', value: String(d.error), monospace: true })
    if (d.child_trace_id) {
      rows.push({
        label: 'Sub Trace',
        value: <TraceLink traceId={String(d.child_trace_id)} onNavigate={onNavigateTrace} />,
      })
    }
  }

  if (span.type === 'decision') {
    if (d.decision_type) rows.push({ label: 'Type', value: String(d.decision_type) })
    if (d.summary) rows.push({ label: 'Summary', value: String(d.summary) })
  }

  if (span.type === 'sub_agent_call') {
    if (d.target_module_id) rows.push({ label: 'Target', value: String(d.target_module_id) })
    if (d.method) rows.push({ label: 'Method', value: String(d.method) })
    if (d.task_id) rows.push({ label: 'Task ID', value: String(d.task_id) })
    if (d.child_trace_id) {
      rows.push({
        label: 'Child Trace',
        value: <TraceLink traceId={String(d.child_trace_id)} onNavigate={onNavigateTrace} />,
      })
    }
  }

  if (span.type === 'context_assembly' || span.type === 'context_fetch') {
    if (d.context_type) rows.push({ label: 'Context Type', value: String(d.context_type) })
    if (d.channel_id) rows.push({ label: 'Channel', value: String(d.channel_id) })
    if (d.session_id) rows.push({ label: 'Session', value: String(d.session_id) })
  }

  if (span.type === 'memory_write') {
    if (d.friend_id) rows.push({ label: 'Friend', value: String(d.friend_id) })
    if (d.channel_id) rows.push({ label: 'Channel', value: String(d.channel_id) })
  }

  if (span.type === 'rpc_call') {
    if (d.target_module) rows.push({ label: 'Target', value: String(d.target_module) })
    if (d.method) rows.push({ label: 'Method', value: String(d.method) })
    if (d.target_port) rows.push({ label: 'Port', value: String(d.target_port) })
    if (d.request_summary) rows.push({ label: 'Request', value: String(d.request_summary), monospace: true })
    if (d.response_summary) rows.push({ label: 'Response', value: String(d.response_summary), monospace: true })
    if (d.status_code) rows.push({ label: 'Status Code', value: String(d.status_code) })
    if (d.error) rows.push({ label: 'Error', value: String(d.error), monospace: true })
  }

  rows.push({ label: 'Started', value: formatDateTimeLocal(span.started_at) })
  if (span.ended_at) {
    rows.push({ label: 'Ended', value: formatDateTimeLocal(span.ended_at) })
    rows.push({ label: 'Duration', value: formatDuration(span.duration_ms) })
  }
  rows.push({ label: 'Status', value: span.status })

  return (
    <div
      style={{
        padding: '10px 14px 10px 36px',
        background: 'var(--bg-secondary, #f9fafb)',
        borderBottom: '1px solid var(--border)',
        fontSize: 12,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td
                style={{
                  width: 110,
                  padding: '2px 8px 2px 0',
                  color: '#6b7280',
                  verticalAlign: 'top',
                  fontWeight: 500,
                }}
              >
                {row.label}:
              </td>
              <td
                style={{
                  padding: '2px 0',
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: row.monospace ? 'monospace' : undefined,
                  maxWidth: 600,
                }}
              >
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ============================================================================
// 子组件：SpanRow / SpanTree
// ============================================================================

function detailSummary(span: AgentSpan): string {
  const d = span.details as Record<string, unknown>
  if (span.type === 'agent_loop') {
    const label = d.loop_label ? `"${d.loop_label}"` : ''
    const iters = d.iteration_count ? ` ${d.iteration_count} iters` : ''
    return `${label}${iters}`.trim()
  }
  if (span.type === 'llm_call') {
    const iter = d.iteration ? `iter=${d.iteration}` : ''
    const stop = d.stop_reason ? ` stop:${d.stop_reason}` : ''
    return `${iter}${stop}`
  }
  if (span.type === 'tool_call') return String(d.tool_name ?? '')
  if (span.type === 'sub_agent_call') return `→ ${d.target_module_id ?? ''}`
  if (span.type === 'decision') return String(d.decision_type ?? '')
  if (span.type === 'context_assembly' || span.type === 'context_fetch') return `${d.context_type ?? ''} context`
  if (span.type === 'memory_write') return `→ ${d.channel_id ?? ''}`
  if (span.type === 'rpc_call') return `${d.target_module ?? ''}::${d.method ?? ''}`
  if (span.type === 'bg_entity_exit') {
    const id = String(d.entity_id ?? '?')
    const status = String(d.status ?? '?')
    const exitCode = d.exit_code !== undefined ? `, exit=${d.exit_code}` : ''
    const runtimeMs = typeof d.runtime_ms === 'number' ? d.runtime_ms : 0
    return `${id} → ${status}${exitCode}, ran ${formatDuration(runtimeMs)}`
  }
  if (span.type === 'bg_entity_spawn') {
    const id = String(d.entity_id ?? '?')
    const mode = d.mode ? ` (${d.mode})` : ''
    return `${id}${mode}`
  }
  if (span.type === 'bg_entity_output' || span.type === 'bg_entity_kill') {
    return String(d.entity_id ?? '?')
  }
  if (span.type === 'llm_retry') {
    const attempt = d.attempt ?? '?'
    const max = d.max_attempts ?? '?'
    const reason = String(d.error ?? '').slice(0, 80)
    return `attempt ${attempt}/${max}: ${reason}`
  }
  return ''
}

interface SpanRowProps {
  span: AgentSpan
  spans: AgentSpan[]
  depth: number
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
}

const SpanRow: React.FC<SpanRowProps> = ({ span, spans, depth, expandedDetails, toggleDetail, onNavigateTrace }) => {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = spans.some((s) => s.parent_span_id === span.span_id)
  const showDetail = expandedDetails.has(span.span_id)

  const usage = (span.details as Record<string, unknown>).usage as TokenUsage | undefined

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 0',
          paddingLeft: `${depth * 18 + 8}px`,
          borderBottom: '1px solid var(--border)',
          fontSize: 12,
          fontFamily: 'monospace',
        }}
      >
        <span
          style={{
            width: 14,
            color: '#9ca3af',
            marginRight: 4,
            cursor: hasChildren ? 'pointer' : 'default',
            userSelect: 'none',
          }}
          onClick={() => hasChildren && setExpanded(!expanded)}
        >
          {hasChildren ? (expanded ? '▼' : '▶') : ' '}
        </span>
        <span
          style={{
            background: spanTypeBg(span.type),
            color: '#fff',
            borderRadius: 3,
            padding: '1px 5px',
            fontSize: 10,
            marginRight: 6,
            minWidth: 56,
            textAlign: 'center',
            flexShrink: 0,
          }}
        >
          {spanTypeLabel(span.type)}
        </span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-primary)',
            cursor: 'pointer',
          }}
          onClick={(e) => { e.stopPropagation(); toggleDetail(span.span_id) }}
          title="点击查看详情"
        >
          {detailSummary(span)}
          {showDetail && <span style={{ marginLeft: 6, color: '#9ca3af' }}>▲ 收起</span>}
        </span>
        {usage && (
          <span style={{ marginLeft: 8, fontSize: 10, color: '#6b7280', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {formatTokens(usage.input_tokens)}↦{formatTokens(usage.output_tokens)}
          </span>
        )}
        <span
          style={{
            marginLeft: 8,
            color: span.duration_ms === undefined ? '#9ca3af' : 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
            minWidth: 50,
            textAlign: 'right',
          }}
        >
          {formatDuration(span.duration_ms)}
        </span>
        <span
          style={{
            marginLeft: 8,
            color: statusColor(span.status),
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {span.status === 'completed' ? '✓' : span.status === 'failed' ? '✗' : '…'}
        </span>
      </div>
      {showDetail && <SpanDetailPanel span={span} onNavigateTrace={onNavigateTrace} />}
      {expanded && hasChildren && (
        <SpanTree
          spans={spans}
          parentSpanId={span.span_id}
          depth={depth + 1}
          expandedDetails={expandedDetails}
          toggleDetail={toggleDetail}
          onNavigateTrace={onNavigateTrace}
        />
      )}
    </>
  )
}

const SpanTree: React.FC<{
  spans: AgentSpan[]
  parentSpanId?: string
  depth?: number
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
}> = ({ spans, parentSpanId, depth = 0, expandedDetails, toggleDetail, onNavigateTrace }) => {
  const children = spans.filter((s) => s.parent_span_id === parentSpanId)
  if (children.length === 0) return null
  return (
    <>
      {children.map((span) => (
        <SpanRow
          key={span.span_id}
          span={span}
          spans={spans}
          depth={depth}
          expandedDetails={expandedDetails}
          toggleDetail={toggleDetail}
          onNavigateTrace={onNavigateTrace}
        />
      ))}
    </>
  )
}

// ============================================================================
// 子组件：TraceDetail
// ============================================================================

// ============================================================================
// 列表分组：按 related_task_id 把 fronts/worker/sub-agents 归到同一组
// ============================================================================

type ViewMode = 'flat' | 'grouped'

interface TraceGroup {
  taskId: string | null            // null = 孤儿（无 related_task_id）
  primary: TraceIndexEntry         // 首行用的 trace（fronts[0] > worker > 任意）
  members: TraceIndexEntry[]       // 包含 primary，按时间排
  status: 'running' | 'completed' | 'failed'
  earliestStartedAt: string
  latestEndedAt?: string
  totalDurationMs?: number
  totalSpans: number
  totalUsage?: TokenUsage
}

function aggregateGroupUsage(members: TraceIndexEntry[]): TokenUsage | undefined {
  let any = false
  let input = 0, output = 0, cacheR = 0, cacheC = 0
  let anyCacheR = false, anyCacheC = false
  for (const m of members) {
    const u = m.total_usage
    if (!u) continue
    any = true
    input += u.input_tokens
    output += u.output_tokens
    if (u.cache_read_tokens !== undefined) { cacheR += u.cache_read_tokens; anyCacheR = true }
    if (u.cache_creation_tokens !== undefined) { cacheC += u.cache_creation_tokens; anyCacheC = true }
  }
  if (!any) return undefined
  return {
    input_tokens: input,
    output_tokens: output,
    ...(anyCacheR ? { cache_read_tokens: cacheR } : {}),
    ...(anyCacheC ? { cache_creation_tokens: cacheC } : {}),
  }
}

function aggregateGroupStatus(members: TraceIndexEntry[]): TraceGroup['status'] {
  if (members.some((m) => m.status === 'running')) return 'running'
  if (members.some((m) => m.status === 'failed')) return 'failed'
  return 'completed'
}

function groupEntries(entries: TraceIndexEntry[]): TraceGroup[] {
  const buckets = new Map<string, TraceIndexEntry[]>()
  const orphans: TraceIndexEntry[] = []

  for (const e of entries) {
    if (e.related_task_id) {
      const list = buckets.get(e.related_task_id)
      if (list) list.push(e)
      else buckets.set(e.related_task_id, [e])
    } else {
      orphans.push(e)
    }
  }

  const triggerOrder: Record<string, number> = { message: 0, task: 1, sub_agent_call: 2, schedule: 3 }
  const groups: TraceGroup[] = []

  for (const [taskId, members] of buckets) {
    const sorted = [...members].sort((a, b) => {
      const orderDiff = (triggerOrder[a.trigger_type] ?? 9) - (triggerOrder[b.trigger_type] ?? 9)
      if (orderDiff !== 0) return orderDiff
      return new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
    })
    const fronts = sorted.filter((m) => m.trigger_type === 'message')
    const worker = sorted.find((m) => m.trigger_type === 'task')
    const primary = fronts[0] ?? worker ?? sorted[0]
    const earliest = sorted.reduce((min, m) =>
      new Date(m.started_at).getTime() < new Date(min).getTime() ? m.started_at : min,
      sorted[0].started_at,
    )
    const ends = sorted.map((m) => m.ended_at).filter((x): x is string => Boolean(x))
    const latestEnd = ends.length > 0
      ? ends.reduce((max, x) => new Date(x).getTime() > new Date(max).getTime() ? x : max)
      : undefined
    groups.push({
      taskId,
      primary,
      members: sorted,
      status: aggregateGroupStatus(sorted),
      earliestStartedAt: earliest,
      ...(latestEnd ? { latestEndedAt: latestEnd } : {}),
      ...(latestEnd ? { totalDurationMs: new Date(latestEnd).getTime() - new Date(earliest).getTime() } : {}),
      totalSpans: sorted.reduce((sum, m) => sum + m.span_count, 0),
      ...(aggregateGroupUsage(sorted) ? { totalUsage: aggregateGroupUsage(sorted) } : {}),
    })
  }

  for (const orphan of orphans) {
    groups.push({
      taskId: null,
      primary: orphan,
      members: [orphan],
      status: orphan.status,
      earliestStartedAt: orphan.started_at,
      ...(orphan.ended_at ? { latestEndedAt: orphan.ended_at } : {}),
      ...(orphan.duration_ms !== undefined ? { totalDurationMs: orphan.duration_ms } : {}),
      totalSpans: orphan.span_count,
      ...(orphan.total_usage ? { totalUsage: orphan.total_usage } : {}),
    })
  }

  // 按"组内最新活动时间"倒序
  groups.sort((a, b) => {
    const aT = new Date(a.latestEndedAt ?? a.earliestStartedAt).getTime()
    const bT = new Date(b.latestEndedAt ?? b.earliestStartedAt).getTime()
    return bT - aT
  })

  return groups
}

// ============================================================================
// 子组件：GroupedTableRow — 聚合视图的折叠组
// ============================================================================

function GroupedTableRow({
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
// 子组件：RelatedTraceTree — 同 task_id 的 fronts/worker/sub-agents 关联视图
// ============================================================================

interface TraceTreeData {
  fronts: TraceIndexEntry[]
  worker: TraceIndexEntry | null
  subagents: TraceIndexEntry[]
}

function TraceChip({
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

function RelatedTraceTree({
  taskId,
  currentTraceId,
  onJumpToTrace,
}: {
  taskId: string
  currentTraceId: string
  onJumpToTrace?: (traceId: string) => void
}) {
  const [tree, setTree] = useState<TraceTreeData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    traceService
      .getTraceTree(taskId)
      .then((result) => {
        if (cancelled) return
        setTree(result.tree)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [taskId])

  if (loading && !tree) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 11, color: '#9ca3af' }}>
        加载关联链路中...
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 11, color: '#ef4444' }}>
        关联链路加载失败：{error}
      </div>
    )
  }
  if (!tree) return null

  const total = tree.fronts.length + (tree.worker ? 1 : 0) + tree.subagents.length

  const renderRole = (label: string, color: string, items: TraceIndexEntry[]) => {
    if (items.length === 0) return null
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 10,
            color,
            fontWeight: 600,
            letterSpacing: 0.3,
            textTransform: 'uppercase',
            minWidth: 64,
          }}
        >
          {label} ({items.length})
        </span>
        {items.map((e) => (
          <TraceChip
            key={e.trace_id}
            entry={e}
            current={e.trace_id === currentTraceId}
            onClick={() => onJumpToTrace?.(e.trace_id)}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'rgba(99,102,241,0.05)',
        border: '1px solid rgba(99,102,241,0.2)',
        borderRadius: 4,
        marginTop: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6366f1', fontWeight: 600 }}>
        <span>🔗 关联链路</span>
        <span style={{ color: '#9ca3af', fontWeight: 400, fontFamily: 'monospace' }}>
          task {taskId.slice(0, 12)}
        </span>
        <span style={{ color: '#9ca3af', fontWeight: 400 }}>· 共 {total} trace</span>
      </div>
      {renderRole('Front', '#3b82f6', tree.fronts)}
      {tree.worker && renderRole('Worker', '#8b5cf6', [tree.worker])}
      {renderRole('Sub-agent', '#ec4899', tree.subagents)}
    </div>
  )
}

function TraceDetailPanel({
  trace,
  loading,
  onNavigateTrace,
}: {
  trace: AgentTrace | null
  loading: boolean
  onNavigateTrace?: (traceId: string) => void
}) {
  const [expandedDetails, setExpandedDetails] = useState<Set<string>>(new Set())

  // 切换 trace 时清空展开状态
  useEffect(() => {
    setExpandedDetails(new Set())
  }, [trace?.trace_id])

  const toggleDetail = useCallback((spanId: string) => {
    setExpandedDetails(prev => {
      const next = new Set(prev)
      if (next.has(spanId)) next.delete(spanId)
      else next.add(spanId)
      return next
    })
  }, [])

  if (!trace) {
    return (
      <div style={{ padding: 32, color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>
        从左侧表格选择一条 Trace 查看详情
      </div>
    )
  }

  const usage = trace.total_usage

  return (
    <div style={{ height: '100%', overflow: 'auto', position: 'relative' }}>
      {loading && (
        <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 11, color: '#9ca3af' }}>
          加载中...
        </div>
      )}

      {/* 顶部：trace 元信息 */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary, #f9fafb)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <TriggerBadge type={trace.trigger.type} />
          <span
            style={{
              background: statusColor(trace.status),
              color: '#fff',
              borderRadius: 3,
              padding: '2px 8px',
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 0.3,
            }}
          >
            {trace.status}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {formatDateTimeLocal(trace.started_at)} · {formatDuration(trace.duration_ms)}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>
            {trace.trace_id.slice(0, 8)}
          </span>
        </div>

        {trace.parent_trace_id && (
          <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>
            父 trace: <TraceLink traceId={trace.parent_trace_id} onNavigate={onNavigateTrace} />
          </div>
        )}

        <div style={{ marginTop: 6, fontSize: 13, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
          {trace.trigger.summary}
        </div>

        {trace.related_task_id && (
          <RelatedTraceTree
            taskId={trace.related_task_id}
            currentTraceId={trace.trace_id}
            onJumpToTrace={onNavigateTrace}
          />
        )}

        {trace.outcome && (
          <div
            style={{
              marginTop: 8,
              padding: '6px 10px',
              borderRadius: 4,
              background: trace.outcome.error ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)',
              borderLeft: `3px solid ${trace.outcome.error ? '#ef4444' : '#10b981'}`,
              fontSize: 12,
              color: trace.outcome.error ? '#dc2626' : 'var(--text-primary)',
            }}
          >
            <div>
              <strong>结果:</strong> {trace.outcome.summary}
            </div>
            {trace.outcome.error && (
              <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 11 }}>
                {trace.outcome.error}
              </div>
            )}
          </div>
        )}

        {/* Token 统计区 */}
        {usage && (
          <div
            style={{
              marginTop: 10,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
              gap: 8,
              padding: '10px 12px',
              background: 'var(--bg-primary, #fff)',
              border: '1px solid var(--border)',
              borderRadius: 4,
            }}
          >
            <UsageStat
              label="未命中输入"
              value={usage.input_tokens}
              color="#3b82f6"
              hint="实际计费的 prompt 部分"
            />
            <UsageStat
              label="输出"
              value={usage.output_tokens}
              color="#8b5cf6"
            />
            {(usage.cache_read_tokens ?? 0) > 0 && (
              <UsageStat
                label="缓存命中"
                value={usage.cache_read_tokens!}
                color="#10b981"
                hint="享受缓存折扣价"
              />
            )}
            {(usage.cache_creation_tokens ?? 0) > 0 && (
              <UsageStat
                label="缓存写入"
                value={usage.cache_creation_tokens!}
                color="#0ea5e9"
                hint="本次请求写入缓存的 token（贵 25%）"
              />
            )}
            <UsageStat
              label="全量 prompt"
              value={totalPromptTokens(usage)}
              color="var(--text-secondary)"
              hint="未命中 + 命中 + 写入"
            />
            {((usage.cache_read_tokens ?? 0) > 0 || (usage.cache_creation_tokens ?? 0) > 0) && (
              <UsageStat
                label="命中率"
                value={Math.round(cacheHitRate(usage) * 100)}
                color={cacheHitRate(usage) > 0.5 ? '#10b981' : '#f59e0b'}
                suffix="%"
                hint="命中 token / 全量 prompt"
              />
            )}
          </div>
        )}
      </div>

      {/* Span 树 */}
      <div>
        {trace.spans.length === 0 ? (
          <div style={{ padding: 16, color: '#9ca3af', fontSize: 13 }}>暂无 Span 数据</div>
        ) : (
          <SpanTree
            spans={trace.spans}
            parentSpanId={undefined}
            depth={0}
            expandedDetails={expandedDetails}
            toggleDetail={toggleDetail}
            onNavigateTrace={onNavigateTrace}
          />
        )}
      </div>
    </div>
  )
}

function UsageStat({
  label,
  value,
  color,
  hint,
  suffix,
}: {
  label: string
  value: number
  color: string
  hint?: string
  suffix?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} title={hint}>
      <span style={{ fontSize: 10, color: '#9ca3af', letterSpacing: 0.3 }}>
        {label}
      </span>
      <span style={{ fontSize: 16, color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {suffix ? `${value}${suffix}` : formatTokens(value)}
      </span>
    </div>
  )
}

// ============================================================================
// 主页面
// ============================================================================

export const Traces: React.FC = () => {
  const toast = useToast()

  const [viewMode, setViewMode] = useState<ViewMode>('grouped')
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER)
  const [page, setPage] = useState(1)

  const [entries, setEntries] = useState<TraceIndexEntry[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [serviceError, setServiceError] = useState('')

  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [selectedTrace, setSelectedTrace] = useState<AgentTrace | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [autoRefresh, setAutoRefresh] = useState(true)
  const [clearing, setClearing] = useState(false)

  const isFiltered =
    filter.keyword !== '' || filter.status !== '' || filter.range !== 'all' || filter.taskId !== ''

  // 自动刷新策略：聚合视图（无分页）/扁平视图第 1 页 + 都要求无筛选
  const shouldAutoRefresh =
    autoRefresh && !isFiltered && (viewMode === 'grouped' || page === 1)

  // 聚合视图一次性拉更多 trace（分组后行数会少很多），扁平视图按页拉
  const effectiveLimit = viewMode === 'grouped' ? 100 : PAGE_SIZE
  const effectiveOffset = viewMode === 'grouped' ? 0 : (page - 1) * PAGE_SIZE

  const loadList = useCallback(async () => {
    setListLoading(true)
    try {
      const range = rangeToISO(filter.range, filter.customStart, filter.customEnd)
      const params: SearchTracesParams = {
        limit: effectiveLimit,
        offset: effectiveOffset,
        ...(filter.taskId ? { task_id: filter.taskId } : {}),
        ...(filter.keyword ? { keyword: filter.keyword } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(range.start ? { start: range.start } : {}),
        ...(range.end ? { end: range.end } : {}),
      }
      const result = await traceService.searchTraces(params)
      setEntries(result.traces)
      setTotal(result.total)
      setServiceError('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setServiceError(`Agent 未响应: ${msg}`)
      setEntries([])
      setTotal(0)
    } finally {
      setListLoading(false)
    }
  }, [filter, effectiveLimit, effectiveOffset])

  // 聚合视图下从 entries 派生组
  const groups = useMemo(
    () => (viewMode === 'grouped' ? groupEntries(entries) : []),
    [viewMode, entries],
  )

  const loadDetail = useCallback(async (traceId: string, silent = false) => {
    if (!silent) setDetailLoading(true)
    try {
      const result = await traceService.getTrace(traceId)
      setSelectedTrace(result.trace)
    } catch {
      if (!silent) toast.error('无法加载 Trace 详情')
    } finally {
      if (!silent) setDetailLoading(false)
    }
  }, [toast])

  // 列表初次加载
  useEffect(() => { loadList() }, [loadList])

  // 列表自动轮询
  useEffect(() => {
    if (!shouldAutoRefresh) return
    const id = setInterval(loadList, LIST_REFRESH_MS)
    return () => clearInterval(id)
  }, [shouldAutoRefresh, loadList])

  // 详情自动轮询（仅 running trace）
  useEffect(() => {
    if (!selectedTrace || selectedTrace.status !== 'running' || !autoRefresh) return
    const id = setInterval(() => {
      if (selectedTraceId) loadDetail(selectedTraceId, true)
    }, DETAIL_REFRESH_MS)
    return () => clearInterval(id)
  }, [selectedTrace, selectedTraceId, autoRefresh, loadDetail])

  const handleSelectTrace = useCallback(async (traceId: string) => {
    setSelectedTraceId(traceId)
    setSelectedTrace(null)
    await loadDetail(traceId)
  }, [loadDetail])

  const handleNavigateTrace = useCallback(async (traceId: string) => {
    handleSelectTrace(traceId)
  }, [handleSelectTrace])

  const handleFilterByTask = useCallback((taskId: string) => {
    setFilter({ ...DEFAULT_FILTER, taskId })
    setPage(1)
  }, [])

  const handleClear = useCallback(async () => {
    if (!confirm('确认清理全部 Trace？\n（仅清空内存 ring buffer，磁盘 JSONL 不受影响）')) return
    setClearing(true)
    try {
      const result = await traceService.clearTraces()
      toast.success(`已清理 ${result.cleared_count} 条内存 Trace`)
      await loadList()
      setSelectedTrace(null)
      setSelectedTraceId(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`清理失败: ${msg}`)
    } finally {
      setClearing(false)
    }
  }, [toast, loadList])

  const handleFilterChange = useCallback((next: FilterState) => {
    setFilter(next)
    setPage(1) // 改筛选时回到第 1 页
  }, [])

  const handleResetFilter = useCallback(() => {
    setFilter(DEFAULT_FILTER)
    setPage(1)
  }, [])

  // 自动刷新指示文案
  const refreshStatusText = useMemo(() => {
    if (!autoRefresh) return '已暂停自动刷新'
    if (viewMode === 'flat' && page > 1) return `第 ${page} 页 · 已暂停（翻页时不刷新）`
    if (isFiltered) return '已筛选 · 已暂停（筛选时不刷新）'
    return `自动刷新中（${LIST_REFRESH_MS / 1000}s）`
  }, [autoRefresh, page, isFiltered, viewMode])

  return (
    <MainLayout>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 12,
          padding: '8px 24px 16px',
        }}
      >
        {/* 顶部工具栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Agent Traces</h2>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            观察 Front / Worker / Sub-agent 的执行链路与 Token 用量
          </span>
          <span style={{ flex: 1 }} />
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-secondary)',
              padding: '4px 8px',
              background: shouldAutoRefresh ? 'rgba(16,185,129,0.08)' : 'var(--bg-secondary, #f3f4f6)',
              borderRadius: 4,
            }}
          >
            <StatusDot status={shouldAutoRefresh ? 'completed' : 'failed'} size={6} />
            {refreshStatusText}
          </span>
          <Button
            variant="secondary"
            onClick={() => setAutoRefresh((v) => !v)}
          >
            {autoRefresh ? '⏸ 暂停' : '▶ 恢复'}
          </Button>
          <Button variant="secondary" onClick={loadList} disabled={listLoading}>
            {listLoading ? '加载中...' : '🔄 刷新'}
          </Button>
          <Button variant="danger" onClick={handleClear} disabled={clearing}>
            {clearing ? '清理中...' : '清理内存'}
          </Button>
        </div>

        {/* 视图切换 + 筛选栏 */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div
            style={{
              display: 'inline-flex',
              border: '1px solid var(--border)',
              borderRadius: 4,
              overflow: 'hidden',
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => { setViewMode('grouped'); setPage(1) }}
              style={{
                padding: '6px 12px',
                background: viewMode === 'grouped' ? '#6366f1' : 'transparent',
                color: viewMode === 'grouped' ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: viewMode === 'grouped' ? 600 : 400,
              }}
              title="按 task_id 把 fronts/worker/sub-agents 折叠成树（最近 100 条 trace）"
            >
              🌳 按任务聚合
            </button>
            <button
              onClick={() => { setViewMode('flat'); setPage(1) }}
              style={{
                padding: '6px 12px',
                background: viewMode === 'flat' ? '#6366f1' : 'transparent',
                color: viewMode === 'flat' ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
                borderLeft: '1px solid var(--border)',
                fontWeight: viewMode === 'flat' ? 600 : 400,
              }}
              title="按时间倒序的扁平 trace 列表，支持分页"
            >
              📄 扁平 + 分页
            </button>
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <FilterBar filter={filter} onChange={handleFilterChange} onReset={handleResetFilter} />
          </div>
        </div>

        {serviceError && (
          <div
            style={{
              padding: '10px 16px',
              background: '#fef2f2',
              border: '1px solid #fca5a5',
              borderRadius: 6,
              color: '#dc2626',
              fontSize: 13,
            }}
          >
            {serviceError}
          </div>
        )}

        {/* 主内容：左列表 + 右详情 */}
        <div style={{ display: 'flex', flex: 1, gap: 12, overflow: 'hidden', minHeight: 0 }}>
          {/* 左侧 Trace 表格 */}
          <div
            className="card"
            style={{
              width: 620,
              flexShrink: 0,
              overflow: 'hidden',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ flex: 1, overflow: 'auto' }}>
              {listLoading && entries.length === 0 ? (
                <div style={{ padding: 24 }}><Loading /></div>
              ) : entries.length === 0 ? (
                <div style={{ padding: 32, color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>
                  暂无 Trace 数据{isFiltered && '（清除筛选试试？）'}
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr
                      style={{
                        position: 'sticky',
                        top: 0,
                        background: 'var(--bg-secondary, #f9fafb)',
                        zIndex: 1,
                      }}
                    >
                      <th style={thStyle}></th>
                      <th style={thStyle}>类型</th>
                      <th style={thStyle}>触发摘要</th>
                      <th style={thStyle}>关联</th>
                      <th style={thStyle}>开始时间</th>
                      <th style={thStyle}>耗时</th>
                      <th style={thStyle}>Tokens</th>
                      <th style={{ ...thStyle, textAlign: 'right' }}>Spans</th>
                    </tr>
                  </thead>
                  <tbody>
                    {viewMode === 'grouped'
                      ? groups.map((g) => (
                          <GroupedTableRow
                            key={g.taskId ?? `orphan-${g.primary.trace_id}`}
                            group={g}
                            selectedTraceId={selectedTraceId}
                            onSelectTrace={handleSelectTrace}
                            onFilterByTask={handleFilterByTask}
                            onJumpToTrace={handleNavigateTrace}
                            defaultExpanded={!!filter.taskId}
                          />
                        ))
                      : entries.map((entry) => (
                          <TraceTableRow
                            key={entry.trace_id}
                            entry={entry}
                            isSelected={selectedTraceId === entry.trace_id}
                            onClick={() => handleSelectTrace(entry.trace_id)}
                            onFilterByTask={handleFilterByTask}
                            onJumpToTrace={handleNavigateTrace}
                          />
                        ))}
                  </tbody>
                </table>
              )}
            </div>
            {viewMode === 'flat' ? (
              <PaginationBar
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                onChange={setPage}
              />
            ) : (
              <div
                style={{
                  padding: '8px 12px',
                  borderTop: '1px solid var(--border)',
                  background: 'var(--bg-secondary, #f9fafb)',
                  fontSize: 12,
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <span>🌳 聚合视图：</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {groups.length} 组 / 最近 {entries.length} trace（共 {total} 条）
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 11, color: '#9ca3af' }}>
                  想看更早的 → 切到「扁平 + 分页」
                </span>
              </div>
            )}
          </div>

          {/* 右侧详情 */}
          <div className="card" style={{ flex: 1, overflow: 'hidden', padding: 0 }}>
            <TraceDetailPanel
              trace={selectedTrace}
              loading={detailLoading}
              onNavigateTrace={handleNavigateTrace}
            />
          </div>
        </div>
      </div>
    </MainLayout>
  )
}

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
}
