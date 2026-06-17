import React, { useState, useCallback } from 'react'
import { traceService, type AgentSpan, type TokenUsage, type EngineMessageLike } from '../../services/trace'
import { Tooltip } from '../../components/Common/Tooltip'
import { spanTypeBg, spanTypeLabel, statusColor, formatDuration, formatTokens, detailSummary } from './utils'
import { SpanDetailPanel } from './SpanDetailPanel'

// ============================================================================
// 子组件：SpanRow / SpanTree
// ============================================================================

type ChildTraceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; spans: AgentSpan[]; subagentName: string }
  | { status: 'error'; error: string }

export interface SpanRowProps {
  span: AgentSpan
  spans: AgentSpan[]
  depth: number
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
  /** Worker trace 累积消息快照（来自 resume_checkpoint.messages）。 */
  messages?: ReadonlyArray<EngineMessageLike>
  /** 所有 llm_call span 按出现顺序排列，带 message_count_after 字段。 */
  orderedLlmSpans?: ReadonlyArray<{ span_id: string; message_count_after?: number }>
}

export const SpanRow: React.FC<SpanRowProps> = ({ span, spans, depth, expandedDetails, toggleDetail, onNavigateTrace, messages, orderedLlmSpans }) => {
  const [expanded, setExpanded] = useState(depth < 2)
  const [childTrace, setChildTrace] = useState<ChildTraceState>({ status: 'idle' })
  const hasChildren = spans.some((s) => s.parent_span_id === span.span_id)
  const showDetail = expandedDetails.has(span.span_id)

  const usage = (span.details as Record<string, unknown>).usage as TokenUsage | undefined
  // 子 trace 展开能力对任何带 child_trace_id 的 span 生效：
  //   - sub_agent_call：details.target_module_id 标注 subagent 名
  //   - tool_call（如 delegate_task）：从 input_summary 里提取 subagent_type 作为名字
  const spanDetails = span.details as {
    child_trace_id?: string
    target_module_id?: string
    tool_name?: string
    input_summary?: string
  }
  const childTraceId = spanDetails.child_trace_id
  // 展开按钮的可见条件：
  //   - sub_agent_call 类型（即使缺 child_trace_id 也显示 disabled 按钮，提示用户数据未关联）
  //   - 其他 span 类型（如 tool_call/delegate_task）必须真有 child_trace_id 才显示
  const isSubAgentCall = span.type === 'sub_agent_call'
  const showExpandButton = isSubAgentCall || Boolean(childTraceId)
  const subagentName = (() => {
    if (spanDetails.target_module_id) return spanDetails.target_module_id
    if (span.type === 'tool_call' && spanDetails.input_summary) {
      try {
        const parsed = JSON.parse(spanDetails.input_summary) as { subagent_type?: unknown }
        if (typeof parsed.subagent_type === 'string' && parsed.subagent_type.length > 0) {
          return parsed.subagent_type
        }
      } catch {
        // input_summary 可能被截断或非 JSON，忽略
      }
    }
    return 'unknown'
  })()

  const toggleChildTrace = useCallback(async () => {
    if (!childTraceId) return
    if (childTrace.status === 'loading') return
    if (childTrace.status === 'loaded') {
      setChildTrace({ status: 'idle' })
      return
    }
    setChildTrace({ status: 'loading' })
    try {
      const res = await traceService.getTrace(childTraceId)
      const childSpans = res.trace?.spans ?? []
      setChildTrace({ status: 'loaded', spans: childSpans, subagentName })
    } catch (err) {
      setChildTrace({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, [childTraceId, childTrace.status, subagentName])

  const childTraceExpanded = childTrace.status === 'loaded'

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
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span
          style={{
            width: 14,
            color: 'var(--text-muted)',
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
            color: 'var(--text-on-primary)',
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
        >
          {detailSummary(span)}
          {showDetail && <span style={{ marginLeft: 6, color: 'var(--text-muted)' }}>▲ 收起</span>}
        </span>
        {showExpandButton && (
          <Tooltip content={childTraceId ? '展开子 trace span 树' : '无子 trace 数据'}>
          <button
            aria-label="展开子 trace"
            disabled={!childTraceId}
            onClick={(e) => {
              e.stopPropagation()
              void toggleChildTrace()
            }}
            style={{
              marginLeft: 4,
              padding: '0 6px',
              background: 'none',
              border: '1px solid #ccc',
              borderRadius: 4,
              cursor: childTraceId ? 'pointer' : 'not-allowed',
              opacity: childTraceId ? 1 : 0.5,
              fontSize: 10,
            }}
          >
            {childTraceExpanded ? '▼' : '▶'} 展开子 trace
          </button>
          </Tooltip>
        )}
        {usage && (
          <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {formatTokens(usage.input_tokens)}↦{formatTokens(usage.output_tokens)}
          </span>
        )}
        <span
          style={{
            marginLeft: 8,
            color: span.duration_ms === undefined ? 'var(--text-muted)' : 'var(--text-secondary)',
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
      {showDetail && (
        <SpanDetailPanel
          span={span}
          onNavigateTrace={onNavigateTrace}
          messages={messages}
          orderedLlmSpans={orderedLlmSpans}
          spanIndexInLlm={
            orderedLlmSpans != null
              ? orderedLlmSpans.findIndex((s) => s.span_id === span.span_id)
              : undefined
          }
        />
      )}
      {expanded && hasChildren && (
        <SpanTree
          spans={spans}
          parentSpanId={span.span_id}
          depth={depth + 1}
          expandedDetails={expandedDetails}
          toggleDetail={toggleDetail}
          onNavigateTrace={onNavigateTrace}
          messages={messages}
          orderedLlmSpans={orderedLlmSpans}
        />
      )}
      {childTrace.status === 'loading' && (
        <div style={{ paddingLeft: (depth + 1) * 18 + 8, color: 'var(--text-muted)', fontSize: 11, paddingTop: 4, paddingBottom: 4, paddingRight: 8 }}>
          加载子 trace…
        </div>
      )}
      {childTrace.status === 'error' && (
        <div style={{ paddingLeft: (depth + 1) * 18 + 8, color: 'var(--error)', fontSize: 11, paddingTop: 4, paddingBottom: 4, paddingRight: 8 }}>
          子 trace 加载失败：{childTrace.error}
        </div>
      )}
      {childTrace.status === 'loaded' && (
        <>
          <div
            data-testid="child-trace-banner"
            style={{
              paddingLeft: (depth + 1) * 18 + 8,
              background: 'var(--surface)',
              paddingTop: 6,
              paddingBottom: 6,
              paddingRight: 12,
              fontSize: 12,
              color: 'var(--text-secondary)',
              borderBottom: '1px solid var(--border)',
            }}
          >
            subagent: <strong>{childTrace.subagentName}</strong>
            {childTrace.spans[0]?.trace_id && (
              <> · child_trace: <code>{childTrace.spans[0].trace_id}</code></>
            )}
          </div>
          <SpanTree
            spans={childTrace.spans}
            depth={depth + 1}
            expandedDetails={expandedDetails}
            toggleDetail={toggleDetail}
            onNavigateTrace={onNavigateTrace}
          />
        </>
      )}
    </>
  )
}

export const SpanTree: React.FC<{
  spans: AgentSpan[]
  parentSpanId?: string
  depth?: number
  expandedDetails: Set<string>
  toggleDetail: (spanId: string) => void
  onNavigateTrace?: (traceId: string) => void
  /** Worker trace 累积消息快照（透传给 SpanRow → SpanDetailPanel）。 */
  messages?: ReadonlyArray<EngineMessageLike>
  /** 所有 llm_call span 按出现顺序排列（透传给 SpanRow → SpanDetailPanel）。 */
  orderedLlmSpans?: ReadonlyArray<{ span_id: string; message_count_after?: number }>
}> = ({ spans, parentSpanId, depth = 0, expandedDetails, toggleDetail, onNavigateTrace, messages, orderedLlmSpans }) => {
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
          messages={messages}
          orderedLlmSpans={orderedLlmSpans}
        />
      ))}
    </>
  )
}
