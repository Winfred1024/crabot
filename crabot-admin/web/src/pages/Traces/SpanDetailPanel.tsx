import React from 'react'
import {
  type AgentSpan,
  type TokenUsage,
  totalPromptTokens,
  cacheHitRate,
} from '../../services/trace'
import { formatDateTimeLocal, formatDuration, formatTokens } from './utils'
import { TraceLink } from './TraceTable'

// ============================================================================
// 子组件：SpanDetailPanel — 单个 span 的详情展开
// ============================================================================

export const SpanDetailPanel: React.FC<{
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
