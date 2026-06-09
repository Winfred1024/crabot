import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { Tooltip } from '../../components/Common/Tooltip'
import { useToast } from '../../contexts/ToastContext'
import {
  traceService,
  totalPromptTokens,
  cacheHitRate,
  type AgentTrace,
  type TraceIndexEntry,
  type SearchTracesParams,
  type ConversationUnit,
  type ListConversationUnitsParams,
} from '../../services/trace'
import {
  PAGE_SIZE,
  LIST_REFRESH_MS,
  DETAIL_REFRESH_MS,
  rangeToISO,
  formatDateTimeLocal,
  formatDuration,
  formatTime,
  formatTokens,
  statusColor,
  DEFAULT_FILTER,
  type FilterState,
} from './utils'
import { FilterBar } from './FilterBar'
import { PaginationBar } from './PaginationBar'
import { StatusDot, TriggerBadge, AuditBadge, TraceTableRow, TraceChip, TraceLink } from './TraceTable'
import { SpanTree } from './SpanTree'
import { StatusBar } from './StatusBar'
import { ManualCleanupDialog, AutoCleanupSettingsDialog } from './CleanupDialogs'

// ============================================================================
// 本地 type（仅主组件用）
// ============================================================================

/**
 * spec 2026-06-09-task-trace-tool-unification.md §4.3:
 * 主视图按 task 维度合并（含孤儿 dispatcher 时间序合并）；'flat' 保留作 power-user fallback 看 trace 散平视图。
 */
type ViewMode = 'tasks' | 'flat'

interface TraceTreeData {
  fronts: TraceIndexEntry[]
  worker: TraceIndexEntry | null
  subagents: TraceIndexEntry[]
}

// ============================================================================
// 子组件：RelatedTraceTree — 同 task_id 的 fronts/worker/sub-agents 关联视图
// ============================================================================

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
      <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
        加载关联链路中...
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--error)' }}>
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
        background: 'var(--primary-subtle)',
        border: '1px solid rgba(217,124,74,0.2)',
        borderRadius: 4,
        marginTop: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--primary-light)', fontWeight: 600 }}>
        <span>🔗 关联链路</span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontFamily: 'var(--font-mono)' }}>
          task {taskId.slice(0, 12)}
        </span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· 共 {total} trace</span>
      </div>
      {renderRole('Dispatch', '#3b82f6', tree.fronts)}
      {tree.worker && renderRole('Task', '#8b5cf6', [tree.worker])}
      {renderRole('Sub-agent', '#ec4899', tree.subagents)}
    </div>
  )
}

// ============================================================================
// 子组件：UsageStat
// ============================================================================

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
    <Tooltip content={hint}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', letterSpacing: 0.3 }}>
        {label}
      </span>
      <span style={{ fontSize: 16, color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {suffix ? `${value}${suffix}` : formatTokens(value)}
      </span>
    </div>
    </Tooltip>
  )
}

// ============================================================================
// 子组件：TraceDetailPanel
// ============================================================================

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
      <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
        从左侧表格选择一条 Trace 查看详情
      </div>
    )
  }

  const usage = trace.total_usage

  return (
    <div style={{ height: '100%', overflow: 'auto', position: 'relative' }}>
      {loading && (
        <div style={{ position: 'absolute', top: 8, right: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          加载中...
        </div>
      )}

      {/* 顶部：trace 元信息 */}
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <TriggerBadge type={trace.trigger.type} />
          <AuditBadge taskType={trace.trigger.task_type} />
          <span
            style={{
              background: statusColor(trace.status),
              color: 'var(--text-on-primary)',
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
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {trace.trace_id.slice(0, 8)}
          </span>
        </div>

        {trace.parent_trace_id && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
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
              background: trace.outcome.error ? 'var(--error-glow)' : 'var(--success-glow)',
              borderLeft: `3px solid ${trace.outcome.error ? 'var(--error)' : 'var(--success)'}`,
              fontSize: 12,
              color: trace.outcome.error ? 'var(--error)' : 'var(--text-primary)',
            }}
          >
            <div>
              <strong>结果:</strong> {trace.outcome.summary}
            </div>
            {trace.outcome.error && (
              <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
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
              background: 'var(--bg-primary)',
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
          <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 13 }}>暂无 Span 数据</div>
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

// ============================================================================
// 子组件：ConversationUnitRow — spec 2026-06-09 §4.3 异构行渲染
// task 行 + orphan_dispatcher 行用同一组件按 kind 分支
// ============================================================================

function ConversationUnitRow({
  unit,
  selectedTraceId,
  onSelectTask,
  onSelectTrace,
  onDeleteTask,
}: {
  unit: ConversationUnit
  selectedTraceId: string | null
  /** 点击 task 行 → 自动 filter by task_id + 切 flat 视图看该 task 关联所有 trace */
  onSelectTask: (taskId: string) => void
  /** 点击孤儿 dispatcher 行 → 加载 trace detail */
  onSelectTrace: (traceId: string) => void
  /** 点击删除按钮 → confirm 后永久删除 task（活跃 task 后端会拒绝） */
  onDeleteTask: (taskId: string, title: string) => void
}) {
  const cellStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: '1px solid var(--border)',
    verticalAlign: 'middle',
    fontSize: 12,
  }

  if (unit.kind === 'task') {
    const t = unit.task
    const channelLabel = t.source.channel_id
      ? `${t.source.channel_id.slice(0, 16)}${t.source.session_id ? ' / ' + t.source.session_id.slice(0, 8) : ''}`
      : '-'
    const isTerminal = t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
    return (
      <tr
        style={{ cursor: 'pointer', background: 'transparent' }}
        onClick={() => onSelectTask(t.id)}
      >
        <td style={cellStyle}>
          <span
            style={{
              background: '#8b5cf6',
              color: 'var(--text-on-primary)',
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 3,
              fontWeight: 500,
            }}
          >
            Task
          </span>
        </td>
        <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          {t.id.slice(0, 12)}
        </td>
        <td style={{ ...cellStyle, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <Tooltip content={t.title}>
            <span>{t.title}</span>
          </Tooltip>
        </td>
        <td style={cellStyle}>
          <span
            style={{
              background: isTerminal ? statusColor(t.status === 'completed' ? 'completed' : 'failed') : '#f59e0b',
              color: 'var(--text-on-primary)',
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 3,
              fontWeight: 600,
              textTransform: 'uppercase',
            }}
          >
            {t.status}
          </span>
        </td>
        <td style={{ ...cellStyle, fontSize: 11, color: 'var(--text-muted)' }}>{channelLabel}</td>
        <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
          {formatTime(t.created_at)}
        </td>
        <td style={{ ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span>{t.messages?.length ?? 0}</span>
            <Tooltip content={isTerminal ? '永久删除此任务（trace 数据不受影响）' : '活跃 task 不能直接删除，请先 cancel 或等待完成'}>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteTask(t.id, t.title) }}
                disabled={!isTerminal}
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: isTerminal ? 'pointer' : 'not-allowed',
                  color: isTerminal ? 'var(--error)' : 'var(--text-muted)',
                  fontSize: 14,
                  padding: '0 4px',
                  opacity: isTerminal ? 0.6 : 0.3,
                }}
                onMouseEnter={(e) => { if (isTerminal) e.currentTarget.style.opacity = '1' }}
                onMouseLeave={(e) => { if (isTerminal) e.currentTarget.style.opacity = '0.6' }}
              >
                ✕
              </button>
            </Tooltip>
          </span>
        </td>
      </tr>
    )
  }

  // orphan_dispatcher
  const tr = unit.trace
  const isSelected = selectedTraceId === tr.trace_id
  return (
    <tr
      style={{
        cursor: 'pointer',
        background: isSelected ? 'var(--bg-highlight, rgba(59,130,246,0.08))' : 'transparent',
      }}
      onClick={() => onSelectTrace(tr.trace_id)}
    >
      <td style={cellStyle}>
        <Tooltip content="孤儿 dispatcher trace — dispatcher 决策为 reply / silent / forward_to_existing 等不创建 task 的动作">
          <span
            style={{
              background: '#6b7280',
              color: 'var(--text-on-primary)',
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 3,
              fontWeight: 500,
            }}
          >
            对话
          </span>
        </Tooltip>
      </td>
      <td style={{ ...cellStyle, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
        {tr.trace_id.slice(0, 6)}
      </td>
      <td style={{ ...cellStyle, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <Tooltip content={tr.trigger_summary}>
          <span>{tr.trigger_summary || '(空)'}</span>
        </Tooltip>
      </td>
      <td style={cellStyle}>
        <span
          style={{
            background: statusColor(tr.status),
            color: 'var(--text-on-primary)',
            fontSize: 10,
            padding: '1px 6px',
            borderRadius: 3,
            fontWeight: 600,
            textTransform: 'uppercase',
          }}
        >
          {tr.status}
        </span>
      </td>
      <td style={{ ...cellStyle, fontSize: 11, color: 'var(--text-muted)' }}>-</td>
      <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>
        {formatTime(tr.started_at)}
      </td>
      <td style={{ ...cellStyle, textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>—</td>
    </tr>
  )
}

// ============================================================================
// 主页面
// ============================================================================

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

export const Traces: React.FC = () => {
  const toast = useToast()

  // spec 2026-06-09 §4.3: 默认 'tasks' 视图（task 维度合并）；'flat' 保留作 trace 散平 fallback
  const [viewMode, setViewMode] = useState<ViewMode>('tasks')
  const [filter, setFilter] = useState<FilterState>(() => {
    // URL ?task_id 支持：刷新页面时保留 task 过滤（人类从 agent log grep 出来的 task_id 直接粘贴 URL）
    const url = new URL(window.location.href)
    const urlTaskId = url.searchParams.get('task_id') ?? ''
    return urlTaskId ? { ...DEFAULT_FILTER, taskId: urlTaskId } : DEFAULT_FILTER
  })
  const [page, setPage] = useState(1)

  const [entries, setEntries] = useState<TraceIndexEntry[]>([])  // flat view 用
  const [units, setUnits] = useState<ConversationUnit[]>([])      // tasks view 用
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [serviceError, setServiceError] = useState('')

  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)
  const [selectedTrace, setSelectedTrace] = useState<AgentTrace | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [autoRefresh, setAutoRefresh] = useState(true)
  const [clearing, setClearing] = useState(false)

  const [manualCleanupOpen, setManualCleanupOpen] = useState(false)
  const [autoCleanupOpen, setAutoCleanupOpen] = useState(false)
  const [statusRefreshKey, setStatusRefreshKey] = useState(0)

  const isFiltered =
    filter.keyword !== '' || filter.status !== '' || filter.range !== 'all' || filter.taskId !== ''

  // 自动刷新策略：第 1 页 + 无筛选时才刷新（避免被翻页或正在查特定 task 时打扰）
  const shouldAutoRefresh = autoRefresh && !isFiltered && page === 1

  const loadList = useCallback(async () => {
    setListLoading(true)
    try {
      const range = rangeToISO(filter.range, filter.customStart, filter.customEnd)
      if (viewMode === 'tasks') {
        // spec §4.3: 按 task 维度合并（task + 孤儿 dispatcher 按时间排序）
        const params: ListConversationUnitsParams = {
          page,
          page_size: PAGE_SIZE,
          ...(filter.status || filter.keyword || range.start || range.end || filter.taskId ? {
            filter: {
              ...(filter.status ? { status: filter.status } : {}),
              ...(filter.keyword ? { search: filter.keyword } : {}),
              ...(range.start ? { created_after: range.start } : {}),
              ...(range.end ? { created_before: range.end } : {}),
              // taskId 在 tasks 视图意味着"只看这一个 task"——通过 search 字段实现（含 task_id 的部分匹配）
            },
          } : {}),
        }
        const result = await traceService.listConversationUnits(params)
        // 如果有 taskId filter，admin 侧没原生 task_id filter，前端二次过滤
        const filteredItems = filter.taskId
          ? result.items.filter((u) => u.kind === 'task' && u.task.id === filter.taskId)
          : result.items
        setUnits(filteredItems)
        setTotal(filter.taskId ? filteredItems.length : result.pagination.total_items)
        setEntries([])
      } else {
        // 'flat' 模式仍用旧 search_traces 拿 trace 散平视图（power-user fallback）
        const params: SearchTracesParams = {
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
          ...(filter.taskId ? { task_id: filter.taskId } : {}),
          ...(filter.keyword ? { keyword: filter.keyword } : {}),
          ...(filter.status ? { status: filter.status } : {}),
          ...(range.start ? { start: range.start } : {}),
          ...(range.end ? { end: range.end } : {}),
        }
        const result = await traceService.searchTraces(params)
        setEntries(result.traces)
        setTotal(result.total)
        setUnits([])
      }
      setServiceError('')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setServiceError(`服务未响应: ${msg}`)
      setEntries([])
      setUnits([])
      setTotal(0)
    } finally {
      setListLoading(false)
    }
  }, [filter, page, viewMode])

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
    // spec §4.3 ID 一致性补丁：URL 同步 ?task_id=...，方便用户从 agent log 复制粘贴 + 浏览器后退
    const url = new URL(window.location.href)
    if (taskId) url.searchParams.set('task_id', taskId)
    else url.searchParams.delete('task_id')
    window.history.replaceState({}, '', url.toString())
  }, [])

  // 点击 task 行专用：filter by task_id + 自动切到 flat 视图（看该 task 关联所有 trace）
  // 用户体验：tasks 视图选 task → 自动跳 flat 看 trace 细节；想回去看其他 task 切回 tasks 即可
  const handleSelectTask = useCallback((taskId: string) => {
    setFilter({ ...DEFAULT_FILTER, taskId })
    setViewMode('flat')
    setPage(1)
    const url = new URL(window.location.href)
    url.searchParams.set('task_id', taskId)
    window.history.replaceState({}, '', url.toString())
  }, [])

  // 永久删除单条 task（用于清理"测试消息"堆积）。活跃 task 后端会拒绝。
  const handleDeleteTask = useCallback(async (taskId: string, title: string) => {
    if (!confirm(`永久删除任务「${title}」？\n（trace 数据不受影响）`)) return
    try {
      await traceService.deleteTask(taskId)
      toast.success('已删除')
      await loadList()
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [toast, loadList])

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
    // 清 URL ?task_id
    const url = new URL(window.location.href)
    url.searchParams.delete('task_id')
    window.history.replaceState({}, '', url.toString())
  }, [])

  // 自动刷新指示文案
  const refreshStatusText = useMemo(() => {
    if (!autoRefresh) return '已暂停自动刷新'
    if (page > 1) return `第 ${page} 页 · 已暂停（翻页时不刷新）`
    if (isFiltered) return '已筛选 · 已暂停（筛选时不刷新）'
    return `自动刷新中（${LIST_REFRESH_MS / 1000}s）`
  }, [autoRefresh, page, isFiltered])

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
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            观察 Dispatch / Task / Sub-agent 的执行链路与 Token 用量
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

        {/* 磁盘占用状态栏 */}
        <StatusBar
          refreshKey={statusRefreshKey}
          onOpenManualCleanup={() => setManualCleanupOpen(true)}
          onOpenAutoCleanupSettings={() => setAutoCleanupOpen(true)}
        />
        <ManualCleanupDialog
          open={manualCleanupOpen}
          onClose={() => setManualCleanupOpen(false)}
          onDeleted={() => {
            setStatusRefreshKey((k) => k + 1)
            void loadList()
          }}
        />
        <AutoCleanupSettingsDialog
          open={autoCleanupOpen}
          onClose={() => setAutoCleanupOpen(false)}
        />

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
              onClick={() => { setViewMode('tasks'); setPage(1) }}
              style={{
                padding: '6px 12px',
                background: viewMode === 'tasks' ? 'var(--primary)' : 'transparent',
                color: viewMode === 'tasks' ? '#1a0d06' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
                fontWeight: viewMode === 'tasks' ? 600 : 400,
              }}
            >
              <Tooltip content="spec 2026-06-09 §4.3：按 task 维度合并（含孤儿 dispatcher 时间序合并）+ 原生分页">
                <span>🗂 按任务</span>
              </Tooltip>
            </button>
            <button
              onClick={() => { setViewMode('flat'); setPage(1) }}
              style={{
                padding: '6px 12px',
                background: viewMode === 'flat' ? 'var(--primary)' : 'transparent',
                color: viewMode === 'flat' ? '#1a0d06' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
                borderLeft: '1px solid var(--border)',
                fontWeight: viewMode === 'flat' ? 600 : 400,
              }}
            >
              <Tooltip content="按时间倒序的扁平 trace 列表，支持分页">
                <span>📄 扁平 + 分页</span>
              </Tooltip>
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
              background: 'var(--error-glow)',
              border: '1px solid var(--error)',
              borderRadius: 6,
              color: 'var(--error)',
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
              {/* spec 2026-06-09 §4.3: empty 状态判断按 viewMode（'tasks' 用 units / 'flat' 用 entries） */}
              {(() => {
                const isEmpty = viewMode === 'tasks' ? units.length === 0 : entries.length === 0
                const emptyLabel = viewMode === 'tasks' ? '暂无任务' : '暂无 Trace 数据'
                if (listLoading && isEmpty) {
                  return <div style={{ padding: 24 }}><Loading /></div>
                }
                if (isEmpty) {
                  return (
                    <div style={{ padding: 32, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
                      {emptyLabel}{isFiltered && '（清除筛选试试？）'}
                    </div>
                  )
                }
                return null
              })()}
              {(viewMode === 'tasks' ? units.length > 0 : entries.length > 0) && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr
                      style={{
                        position: 'sticky',
                        top: 0,
                        background: 'var(--bg-secondary)',
                        zIndex: 1,
                      }}
                    >
                      {viewMode === 'tasks' ? (
                        <>
                          <th style={thStyle}>类型</th>
                          <th style={thStyle}>标识</th>
                          <th style={thStyle}>标题 / 摘要</th>
                          <th style={thStyle}>状态</th>
                          <th style={thStyle}>渠道</th>
                          <th style={thStyle}>时间</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>消息</th>
                        </>
                      ) : (
                        <>
                          <th style={thStyle}></th>
                          <th style={thStyle}>类型</th>
                          <th style={thStyle}>触发摘要</th>
                          <th style={thStyle}>关联</th>
                          <th style={thStyle}>开始时间</th>
                          <th style={thStyle}>耗时</th>
                          <th style={thStyle}>Tokens</th>
                          <th style={{ ...thStyle, textAlign: 'right' }}>Spans</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {viewMode === 'tasks'
                      ? units.map((u) => (
                          <ConversationUnitRow
                            key={u.kind === 'task' ? `t-${u.task.id}` : `o-${u.trace.trace_id}`}
                            unit={u}
                            selectedTraceId={selectedTraceId}
                            onSelectTask={handleSelectTask}
                            onSelectTrace={handleSelectTrace}
                            onDeleteTask={handleDeleteTask}
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
            <PaginationBar
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onChange={setPage}
            />
            {viewMode === 'tasks' && (
              <div
                style={{
                  padding: '6px 12px',
                  borderTop: '1px solid var(--border)',
                  background: 'var(--bg-secondary)',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                }}
              >
                spec §4.3 task 维度：点击 task 行只看该 task 的所有 trace（URL ?task_id 同步）；
                "类型 = 对话" 表示孤儿 dispatcher（dispatcher 决策 reply/silent 不创建 task）
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
