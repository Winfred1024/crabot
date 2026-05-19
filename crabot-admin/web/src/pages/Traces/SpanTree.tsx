import React, { useState } from 'react'
import { type AgentSpan, type TokenUsage } from '../../services/trace'
import { spanTypeBg, spanTypeLabel, statusColor, formatDuration, formatTokens, detailSummary } from './utils'
import { SpanDetailPanel } from './SpanDetailPanel'

// ============================================================================
// 子组件：SpanRow / SpanTree
// ============================================================================

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
