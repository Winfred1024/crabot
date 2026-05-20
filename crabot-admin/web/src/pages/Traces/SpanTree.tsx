import React, { useState, useCallback } from 'react'
import { traceService, type AgentSpan, type TokenUsage } from '../../services/trace'
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
}

export const SpanRow: React.FC<SpanRowProps> = ({ span, spans, depth, expandedDetails, toggleDetail, onNavigateTrace }) => {
  const [expanded, setExpanded] = useState(depth < 2)
  const [childTrace, setChildTrace] = useState<ChildTraceState>({ status: 'idle' })
  const hasChildren = spans.some((s) => s.parent_span_id === span.span_id)
  const showDetail = expandedDetails.has(span.span_id)

  const usage = (span.details as Record<string, unknown>).usage as TokenUsage | undefined
  const isSubAgentCall = span.type === 'sub_agent_call'
  const subAgentDetails = isSubAgentCall
    ? (span.details as { child_trace_id?: string; target_module_id?: string })
    : null
  const childTraceId = subAgentDetails?.child_trace_id
  const subagentName = subAgentDetails?.target_module_id ?? 'unknown'

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
        {isSubAgentCall && (
          <button
            aria-label="展开子 trace"
            disabled={!childTraceId}
            title={childTraceId ? '展开子 trace span 树' : '无子 trace 数据'}
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
        )}
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
      {childTrace.status === 'loading' && (
        <div style={{ paddingLeft: (depth + 1) * 18 + 8, color: '#888', fontSize: 11, paddingTop: 4, paddingBottom: 4, paddingRight: 8 }}>
          加载子 trace…
        </div>
      )}
      {childTrace.status === 'error' && (
        <div style={{ paddingLeft: (depth + 1) * 18 + 8, color: '#cf1322', fontSize: 11, paddingTop: 4, paddingBottom: 4, paddingRight: 8 }}>
          子 trace 加载失败：{childTrace.error}
        </div>
      )}
      {childTrace.status === 'loaded' && (
        <>
          <div
            data-testid="child-trace-banner"
            style={{
              paddingLeft: (depth + 1) * 18 + 8,
              background: '#fafafa',
              paddingTop: 6,
              paddingBottom: 6,
              paddingRight: 12,
              fontSize: 12,
              color: '#555',
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
