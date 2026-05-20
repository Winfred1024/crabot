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
  type TraceIndexEntry,
  type SearchTracesParams,
} from '../../services/trace'
import {
  PAGE_SIZE,
  LIST_REFRESH_MS,
  DETAIL_REFRESH_MS,
  rangeToISO,
  groupEntries,
  formatDateTimeLocal,
  formatDuration,
  formatTokens,
  statusColor,
  DEFAULT_FILTER,
  type FilterState,
} from './utils'
import { FilterBar } from './FilterBar'
import { PaginationBar } from './PaginationBar'
import { StatusDot, TriggerBadge, TraceTableRow, GroupedTableRow, TraceChip, TraceLink } from './TraceTable'
import { SpanTree } from './SpanTree'
import { StatusBar } from './StatusBar'
import { ManualCleanupDialog, AutoCleanupSettingsDialog } from './CleanupDialogs'

// ============================================================================
// 本地 type（仅主组件用）
// ============================================================================

type ViewMode = 'flat' | 'grouped'

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

  const [manualCleanupOpen, setManualCleanupOpen] = useState(false)
  const [autoCleanupOpen, setAutoCleanupOpen] = useState(false)
  const [statusRefreshKey, setStatusRefreshKey] = useState(0)

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
