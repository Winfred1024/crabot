/**
 * TraceStore - Agent 执行 Trace 的 Ring Buffer 存储
 *
 * @see crabot-docs/protocols/protocol-agent-v2.md §8
 */

import * as fs from 'fs'
import * as path from 'path'
import type { AgentTrace, AgentSpan, AgentSpanType, AgentSpanDetails, TokenUsage } from '../types.js'
import { aggregateUsage } from './trace-usage.js'

export interface SpanWithMeta {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: AgentSpanType
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: AgentSpanDetails
  children_count: number
}

export interface TraceTree {
  task_id: string
  tree: {
    fronts: TraceIndexEntry[]
    worker: TraceIndexEntry | null
    subagents: TraceIndexEntry[]
  }
}

export interface TraceIndexEntry {
  trace_id: string
  related_task_id?: string
  parent_trace_id?: string
  trigger_type: string
  trigger_summary: string
  trigger_task_type?: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  outcome_summary?: string
  span_count: number
  /** 全 trace 的 token 用量汇总（持久化时聚合，rebuild 时按 spans 重算） */
  total_usage?: TokenUsage
  file: string
  file_offset: number
}

export class TraceStore {
  private traces: Map<string, AgentTrace> = new Map()
  private order: string[] = []
  private maxSize: number
  private persistDir: string | undefined
  private traceIndex: TraceIndexEntry[] = []
  private taskIndex: Map<string, string[]> = new Map()

  // ── In-flight 定时持久化 ────────────────────────────────
  // status='running' 的 trace 只在 endTrace 时才追加到 traces-{date}.jsonl。
  // 但 agent 被 SIGKILL（health 失败 / OOM / 外部强杀）时根本没机会 endTrace，
  // 整条主 task trace 连带所有 span 永久丢失 —— admin UI 上只能看到已结束的
  // sub-agent / dispatch trace，看不到死前主 loop 在做啥。
  //
  // 解决：定时把所有 in-flight trace 全量覆盖写到独立文件 traces-running.jsonl。
  // 覆盖式（writeFileSync + rename atomic 替换），文件大小有界。
  // 进程重启后 rebuildIndex 把上次 running 的 trace 重新加载到 this.traces，
  // searchTraces 的现有合并逻辑（line 107-112）能直接展示出来。
  private flushTimer?: ReturnType<typeof setInterval>
  private static readonly RUNNING_FLUSH_FILE = 'traces-running.jsonl'

  constructor(maxSize = 100, persistDir?: string) {
    this.maxSize = maxSize
    this.persistDir = persistDir
    if (persistDir) {
      fs.mkdirSync(persistDir, { recursive: true })
      this.rebuildIndex()
      this.loadRunningTraces()
    }
  }

  /**
   * 启动 in-flight trace 的定时全量 flush。caller（UnifiedAgent.onStart）调一次。
   * intervalMs 太短会增加 IO，太长会让"死前的最后状态"丢得多；默认 15s 是经验值。
   */
  startFlushTimer(intervalMs = 15_000): void {
    if (this.flushTimer || !this.persistDir) return
    this.flushTimer = setInterval(() => {
      try {
        this.flushInFlightTraces()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[TraceStore] flushInFlightTraces failed: ${msg}`)
      }
    }, intervalMs)
    this.flushTimer.unref?.()
  }

  stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  private static runningCheckpointFile(taskId: string): string {
    return `traces-running-${taskId}.jsonl`
  }

  /**
   * 把某 worker trace（含 resume_checkpoint）原子写到 per-task running 文件。
   * per-turn 调用；tmp+rename 保证崩在写一半时留下上一份完整旧快照。
   */
  flushWorkerCheckpoint(taskId: string, traceId: string, checkpoint: import('../types.js').ResumeCheckpoint): void {
    if (!this.persistDir) return
    const trace = this.traces.get(traceId)
    if (!trace) return
    trace.resume_checkpoint = checkpoint
    const finalPath = path.join(this.persistDir, TraceStore.runningCheckpointFile(taskId))
    const tmpPath = finalPath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(trace) + '\n', 'utf-8')
    fs.renameSync(tmpPath, finalPath)
  }

  /**
   * 全量重写 traces-running.jsonl —— 当前所有 status='running' 的 trace。
   * 用 tmp + rename 实现 atomic 替换：进程在写中间被杀，旧文件保持完好。
   */
  private flushInFlightTraces(): void {
    if (!this.persistDir) return
    const lines: string[] = []
    for (const trace of this.traces.values()) {
      if (trace.status === 'running') {
        lines.push(JSON.stringify(trace))
      }
    }
    const content = lines.length > 0 ? lines.join('\n') + '\n' : ''
    const finalPath = path.join(this.persistDir, TraceStore.RUNNING_FLUSH_FILE)
    const tmpPath = finalPath + '.tmp'
    fs.writeFileSync(tmpPath, content, 'utf-8')
    fs.renameSync(tmpPath, finalPath)
  }

  /**
   * 启动时加载 traces-running.jsonl —— 上次 agent 死时未结束的 trace。
   * 把这些 trace 标记为 failed（interrupted），写入日期文件，然后清空 running 文件。
   */
  private loadRunningTraces(): void {
    if (!this.persistDir) return
    const filePath = path.join(this.persistDir, TraceStore.RUNNING_FLUSH_FILE)
    if (!fs.existsSync(filePath)) return
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split('\n')) {
        if (!line.trim()) continue
        try {
          const trace = JSON.parse(line) as AgentTrace
          // 已经 endTrace 过的（rebuildIndex 已读到）跳过
          if (this.traceIndex.some(e => e.trace_id === trace.trace_id)) continue
          // 标记为 interrupted，写入日期文件让 UI 正确显示
          const now = new Date()
          trace.status = 'failed'
          if (!trace.ended_at) {
            trace.ended_at = now.toISOString()
            trace.duration_ms = now.getTime() - new Date(trace.started_at).getTime()
          }
          if (!trace.outcome) {
            trace.outcome = { summary: '[interrupted: agent restarted]' }
          }
          this.traces.set(trace.trace_id, trace)
          this.persistTrace(trace)
        } catch { /* skip malformed */ }
      }
      // 清空 running 文件——这些 trace 已落到日期文件
      fs.writeFileSync(filePath, '', 'utf-8')
    } catch (err) {
      console.warn(`[TraceStore] loadRunningTraces failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  private rebuildIndex(): void {
    if (!this.persistDir) return
    try {
      // 排除 traces-running.jsonl —— 那是覆盖式写的 in-flight 文件，没有稳定
      // 字节 offset，不能进 traceIndex（getFullTrace 走 offset 读会乱）。
      // in-flight 由 loadRunningTraces 单独加载到内存 Map。
      const files = fs.readdirSync(this.persistDir)
        .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl') && f !== TraceStore.RUNNING_FLUSH_FILE)
        .sort()

      for (const file of files) {
        const filePath = path.join(this.persistDir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        let offset = 0
        for (const line of content.split('\n')) {
          const lineBytes = Buffer.byteLength(line + '\n', 'utf-8')
          if (!line.trim()) { offset += lineBytes; continue }
          try {
            const trace = JSON.parse(line) as AgentTrace
            const entry = this.traceToIndexEntry(trace, file, offset)
            // 同一 trace_id 可能多次写入（endTrace + appendTraceOutcome），保留最新 offset
            const existingIdx = this.traceIndex.findIndex(e => e.trace_id === trace.trace_id)
            if (existingIdx !== -1) {
              this.traceIndex[existingIdx] = entry
            } else {
              this.traceIndex.push(entry)
            }
            if (trace.related_task_id) {
              this.addToTaskIndex(trace.related_task_id, trace.trace_id)
            }
          } catch { /* skip malformed lines */ }
          offset += lineBytes
        }
      }
    } catch { /* persist dir read failure */ }
  }

  searchTraces(params: {
    task_id?: string
    time_range?: { start: string; end: string }
    keyword?: string
    status?: string
    limit?: number
    offset?: number
  }): { traces: TraceIndexEntry[]; total: number } {
    let results = [...this.traceIndex]

    // Merge running traces from ring buffer not yet persisted
    for (const trace of this.traces.values()) {
      if (trace.status === 'running' && !results.some(e => e.trace_id === trace.trace_id)) {
        results.push(this.traceToIndexEntry(trace, '', 0))
      }
    }

    if (params.task_id) {
      const traceIds = new Set(this.taskIndex.get(params.task_id) ?? [])
      for (const trace of this.traces.values()) {
        if (trace.related_task_id === params.task_id) traceIds.add(trace.trace_id)
      }
      results = results.filter(e => traceIds.has(e.trace_id))
    }

    if (params.time_range) {
      const start = new Date(params.time_range.start).getTime()
      const end = new Date(params.time_range.end).getTime()
      results = results.filter(e => {
        const t = new Date(e.started_at).getTime()
        return t >= start && t < end
      })
    }

    if (params.keyword) {
      const kw = params.keyword.toLowerCase()
      results = results.filter(e =>
        e.trigger_summary.toLowerCase().includes(kw) ||
        (e.outcome_summary?.toLowerCase().includes(kw) ?? false)
      )
    }

    if (params.status) {
      results = results.filter(e => e.status === params.status)
    }

    results.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())

    const total = results.length
    const limit = Math.min(params.limit ?? 20, 100)
    const off = params.offset ?? 0
    return { traces: results.slice(off, off + limit), total }
  }

  startTrace(params: {
    module_id: string
    trigger: AgentTrace['trigger']
    parent_trace_id?: string
    parent_span_id?: string
    related_task_id?: string
  }): AgentTrace {
    const trace: AgentTrace = {
      trace_id: crypto.randomUUID(),
      parent_trace_id: params.parent_trace_id,
      parent_span_id: params.parent_span_id,
      related_task_id: params.related_task_id,
      module_id: params.module_id,
      started_at: new Date().toISOString(),
      status: 'running',
      trigger: params.trigger,
      spans: [],
    }

    // Ring Buffer：超出容量时淘汰最旧的
    if (this.order.length >= this.maxSize) {
      const oldest = this.order.shift()!
      this.traces.delete(oldest)
    }

    this.traces.set(trace.trace_id, trace)
    this.order.push(trace.trace_id)
    return trace
  }

  startSpan(
    traceId: string,
    params: {
      type: AgentSpanType
      parent_span_id?: string
      details: AgentSpanDetails
      /** Back-date from post-hoc callbacks (e.g. agent-handler onTurn fires
       * after LLM + tools complete). Defaults to Date.now(). */
      started_at_ms?: number
    }
  ): AgentSpan {
    const startedAtMs = params.started_at_ms ?? Date.now()
    const span: AgentSpan = {
      span_id: crypto.randomUUID(),
      parent_span_id: params.parent_span_id,
      trace_id: traceId,
      type: params.type,
      started_at: new Date(startedAtMs).toISOString(),
      status: 'running',
      details: params.details,
    }

    const trace = this.traces.get(traceId)
    if (trace) {
      trace.spans.push(span)
    }

    return span
  }

  endSpan(
    traceId: string,
    spanId: string,
    status: 'completed' | 'failed',
    detailsUpdate?: Partial<AgentSpanDetails>,
    /** Back-date from post-hoc callbacks. Defaults to Date.now(). */
    endedAtMs?: number,
  ): void {
    const trace = this.traces.get(traceId)
    if (!trace) return

    const span = trace.spans.find((s) => s.span_id === spanId)
    if (!span) return

    const resolvedEndedAtMs = endedAtMs ?? Date.now()
    span.ended_at = new Date(resolvedEndedAtMs).toISOString()
    span.duration_ms = resolvedEndedAtMs - new Date(span.started_at).getTime()
    span.status = status

    if (detailsUpdate) {
      span.details = { ...span.details, ...detailsUpdate } as AgentSpanDetails
    }
  }

  endTrace(
    traceId: string,
    status: 'completed' | 'failed',
    outcome?: AgentTrace['outcome']
  ): void {
    const trace = this.traces.get(traceId)
    if (!trace) return

    const now = new Date()
    trace.ended_at = now.toISOString()
    trace.duration_ms = now.getTime() - new Date(trace.started_at).getTime()
    trace.status = status
    if (outcome) {
      trace.outcome = outcome
    }
    const totalUsage = aggregateUsage(trace.spans)
    if (totalUsage) {
      trace.total_usage = totalUsage
    }

    this.persistTrace(trace)
  }

  /**
   * Patch trace 顶层 outcome，不动 status / ended_at / duration_ms。
   *
   * 跟 endTrace 区别：endTrace 是 status-changing 操作（重置时间戳），
   * 适合 trace 终结那一刻调用；appendTraceOutcome 是事后 patch 工具，
   * 适合 trace 已 endTrace 后再补充关键 metadata 的场景（如 runGoalAudit
   * 拿到 audit verdict 后回写 audit trace summary）。
   *
   * Spec: 2026-05-26-goal-audit-loop-completion §2.1.1
   */
  appendTraceOutcome(traceId: string, partial: Partial<NonNullable<AgentTrace['outcome']>>): void {
    const trace = this.traces.get(traceId)
    if (!trace) return
    trace.outcome = { summary: '', ...(trace.outcome ?? {}), ...partial }
    this.persistTrace(trace)
  }

  /**
   * 把单次 LLM 调用的完整 prompt 落到 prompts-YYYY-MM-DD.jsonl。
   *
   * 跟 traces-*.jsonl 同目录、按日切片；cleanupOldTraces 会按相同 cutoff 一起清。
   * 写入失败仅 warn，不阻塞主流程。
   *
   * 用途：trace span 里只存 input_summary（task_title 切 150 字），调试"agent
   * 为啥这么干"类问题时无法事后还原模型实际看到的内容。这里存完整 system_prompt
   * + messages 拍照，trace_id / span_id 关联回 trace。
   */
  appendPromptDump(record: {
    trace_id: string
    span_id?: string
    iteration?: number
    attempt?: number
    source: 'dispatcher' | 'worker' | 'subagent'
    model?: string
    system_prompt: string
    messages: ReadonlyArray<unknown>
  }): void {
    if (!this.persistDir) return
    try {
      const timestamp = new Date().toISOString()
      const date = timestamp.slice(0, 10)
      const file = `prompts-${date}.jsonl`
      const filePath = path.join(this.persistDir, file)
      const line = JSON.stringify({
        timestamp,
        trace_id: record.trace_id,
        ...(record.span_id !== undefined ? { span_id: record.span_id } : {}),
        ...(record.iteration !== undefined ? { iteration: record.iteration } : {}),
        ...(record.attempt !== undefined ? { attempt: record.attempt } : {}),
        source: record.source,
        ...(record.model !== undefined ? { model: record.model } : {}),
        system_prompt: record.system_prompt,
        messages: record.messages,
      }) + '\n'
      fs.appendFileSync(filePath, line, 'utf-8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[TraceStore] appendPromptDump failed for ${record.trace_id}: ${msg}`)
    }
  }

  updateTrace(traceId: string, updates: { related_task_id?: string }): void {
    const trace = this.traces.get(traceId)
    if (!trace) return
    if (updates.related_task_id !== undefined) {
      trace.related_task_id = updates.related_task_id
      if (updates.related_task_id) {
        this.addToTaskIndex(updates.related_task_id, traceId)
      }
    }
  }

  getTraces(
    limit = 20,
    offset = 0,
    status?: string
  ): { traces: AgentTrace[]; total: number } {
    let all = this.order
      .map((id) => this.traces.get(id)!)
      .filter(Boolean)
      .reverse() // 最新的在前

    if (status) {
      all = all.filter((t) => t.status === status)
    }

    const total = all.length
    const traces = all.slice(offset, offset + Math.min(limit, 100))
    return { traces, total }
  }

  getTrace(traceId: string): AgentTrace | undefined {
    return this.traces.get(traceId)
  }

  async getFullTrace(traceId: string): Promise<AgentTrace | undefined> {
    // 1. 先查 ring buffer
    const cached = this.traces.get(traceId)
    if (cached) return cached

    // 2. 从索引找到文件位置
    const indexEntry = this.traceIndex.find(e => e.trace_id === traceId)
    if (!indexEntry || !this.persistDir || !indexEntry.file) return undefined

    // 3. 从 JSONL 按需读取——分块循环读直到遇到换行符（容纳任意大小 trace；
    //    历史 bug：固定 64KB buffer 会把 spans 较多的 trace 截断 → JSON parse 失败 → 404）
    try {
      const filePath = path.join(this.persistDir, indexEntry.file)
      const fd = fs.openSync(filePath, 'r')
      try {
        const CHUNK = 64 * 1024 // 64KB per read
        const buf = Buffer.allocUnsafe(CHUNK)
        const chunks: string[] = []
        let position = indexEntry.file_offset
        let foundNewline = false

        while (!foundNewline) {
          const bytesRead = fs.readSync(fd, buf, 0, CHUNK, position)
          if (bytesRead === 0) break // EOF
          const slice = buf.toString('utf-8', 0, bytesRead)
          const nlIdx = slice.indexOf('\n')
          if (nlIdx >= 0) {
            chunks.push(slice.slice(0, nlIdx))
            foundNewline = true
          } else {
            chunks.push(slice)
            position += bytesRead
          }
        }

        const line = chunks.join('')
        if (!line) return undefined
        return JSON.parse(line) as AgentTrace
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return undefined
    }
  }

  getSpansAtDepth(
    traceId: string,
    params: { parent_span_id?: string }
  ): { spans: SpanWithMeta[]; span_total: number } {
    const trace = this.traces.get(traceId)
    if (!trace) return { spans: [], span_total: 0 }

    const allSpans = trace.spans

    // Build children count map in O(n) instead of O(n²)
    const childrenCount = new Map<string, number>()
    for (const s of allSpans) {
      if (s.parent_span_id) {
        childrenCount.set(s.parent_span_id, (childrenCount.get(s.parent_span_id) ?? 0) + 1)
      }
    }

    const targetSpans = params.parent_span_id
      ? allSpans.filter(s => s.parent_span_id === params.parent_span_id)
      : allSpans.filter(s => !s.parent_span_id)

    const result: SpanWithMeta[] = targetSpans.map(span => ({
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      trace_id: span.trace_id,
      type: span.type,
      started_at: span.started_at,
      ended_at: span.ended_at,
      duration_ms: span.duration_ms,
      status: span.status,
      details: span.details,
      children_count: childrenCount.get(span.span_id) ?? 0,
    }))

    return { spans: result, span_total: result.length }
  }

  clearTraces(before?: string, traceIds?: string[]): number {
    let count = 0

    if (traceIds && traceIds.length > 0) {
      for (const id of traceIds) {
        if (this.traces.has(id)) {
          this.traces.delete(id)
          const idx = this.order.indexOf(id)
          if (idx !== -1) this.order.splice(idx, 1)
          count++
        }
      }
      return count
    }

    if (before) {
      const beforeTime = new Date(before).getTime()
      const toDelete = this.order.filter((id) => {
        const trace = this.traces.get(id)
        return trace && new Date(trace.started_at).getTime() < beforeTime
      })
      for (const id of toDelete) {
        this.traces.delete(id)
        const idx = this.order.indexOf(id)
        if (idx !== -1) this.order.splice(idx, 1)
        count++
      }
      return count
    }

    // 清空全部
    count = this.traces.size
    this.traces.clear()
    this.order = []
    return count
  }

  getTraceTree(taskId: string): TraceTree {
    const { traces } = this.searchTraces({ task_id: taskId, limit: 100 })

    const fronts: TraceIndexEntry[] = []
    let worker: TraceIndexEntry | null = null
    const subagents: TraceIndexEntry[] = []

    for (const t of traces) {
      switch (t.trigger_type) {
        case 'message':
          fronts.push(t)
          break
        case 'task':
          worker = t
          break
        case 'sub_agent_call':
          subagents.push(t)
          break
        default:
          fronts.push(t)
      }
    }

    return { task_id: taskId, tree: { fronts, worker, subagents } }
  }

  getDiskUsage(): {
    total_bytes: number
    trace_count: number
    oldest_iso?: string
    newest_iso?: string
  } {
    if (!this.persistDir || !fs.existsSync(this.persistDir)) {
      return { total_bytes: 0, trace_count: 0 }
    }
    let totalBytes = 0
    try {
      // 统计口径必须跟 cleanupOldTraces 一致——它会同时清 traces-* 和 prompts-*，
      // 这里也要把两类都算进去。只统计 traces-* 会让 Admin Web /traces 页面
      // 显示的"占用"严重低估（prompts-*.jsonl 每天 100-700MB，几天就 GB 级），
      // 用户磁盘满了才察觉。
      const files = fs.readdirSync(this.persistDir)
        .filter(f => (f.startsWith('traces-') || f.startsWith('prompts-')) && f.endsWith('.jsonl'))
      for (const file of files) {
        const stat = fs.statSync(path.join(this.persistDir, file))
        totalBytes += stat.size
      }
    } catch (err) {
      console.warn('[TraceStore] getDiskUsage failed:', err instanceof Error ? err.message : err)
    }
    const traceCount = this.traceIndex.length
    let oldestIso: string | undefined
    let newestIso: string | undefined
    if (traceCount > 0) {
      let oldest = Infinity
      let newest = -Infinity
      for (const e of this.traceIndex) {
        const t = new Date(e.started_at).getTime()
        if (Number.isFinite(t)) {
          if (t < oldest) oldest = t
          if (t > newest) newest = t
        }
      }
      if (Number.isFinite(oldest)) oldestIso = new Date(oldest).toISOString()
      if (Number.isFinite(newest)) newestIso = new Date(newest).toISOString()
    }
    return {
      total_bytes: totalBytes,
      trace_count: traceCount,
      ...(oldestIso ? { oldest_iso: oldestIso } : {}),
      ...(newestIso ? { newest_iso: newestIso } : {}),
    }
  }

  /**
   * 按日级粒度清理 JSONL 文件：找 traces-<date>.jsonl 中 date < (today - retentionDays) 的整个文件删除。
   * dryRun=true 时只返回统计不实删。
   */
  cleanupOldTraces(retentionDays: number, dryRun: boolean): {
    affected_count: number
    affected_bytes: number
    deleted_trace_ids: string[]
  } {
    if (!this.persistDir || !Number.isFinite(retentionDays) || retentionDays < 1 || !fs.existsSync(this.persistDir)) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    return this.cleanupTracesBeforeDate(cutoffStr, dryRun)
  }

  /**
   * 按条数清理：保留最近 maxCount 条 trace，多余的按文件粒度近似删除。
   *
   * 由于持久化以 traces-YYYY-MM-DD.jsonl 按天切片，无法精确删除"超出 N 条的尾巴"，
   * 这里按 traceIndex 时间倒序找第 N 条对应的日期，严格更老的整文件删。
   * 同一天文件不切割：实际保留条数 ≥ maxCount。
   */
  cleanupOldTracesByCount(maxCount: number, dryRun: boolean): {
    affected_count: number
    affected_bytes: number
    deleted_trace_ids: string[]
  } {
    if (!this.persistDir || !Number.isFinite(maxCount) || maxCount < 1 || !fs.existsSync(this.persistDir)) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    if (this.traceIndex.length <= maxCount) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    // 时间倒序：第 maxCount 条（1-indexed）是要保留的最后一条；它所在日期及更新的整体保留
    const sortedDesc = [...this.traceIndex].sort(
      (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
    )
    const boundary = sortedDesc[maxCount - 1]
    const keepDateStr = this.extractDateFromFile(boundary.file)
    if (!keepDateStr) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    return this.cleanupTracesBeforeDate(keepDateStr, dryRun)
  }

  private extractDateFromFile(file: string): string | null {
    const prefix = file.startsWith('traces-') ? 'traces-' : file.startsWith('prompts-') ? 'prompts-' : null
    if (!prefix) return null
    const dateStr = file.slice(prefix.length, prefix.length + 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : null
  }

  /**
   * 删除 dateStr 严格小于 cutoffStr 的 traces-*.jsonl 和 prompts-*.jsonl 文件。
   */
  private cleanupTracesBeforeDate(cutoffStr: string, dryRun: boolean): {
    affected_count: number
    affected_bytes: number
    deleted_trace_ids: string[]
  } {
    if (!this.persistDir) {
      return { affected_count: 0, affected_bytes: 0, deleted_trace_ids: [] }
    }
    let affectedTraces = 0
    let affectedBytes = 0
    const deletedIds: string[] = []
    const toDelete: string[] = []

    try {
      // 同时清 traces-YYYY-MM-DD.jsonl 和 prompts-YYYY-MM-DD.jsonl —— 后者是
      // appendPromptDump 写入的 LLM 完整 prompt 拍照，跟 trace 同生命周期。
      const files = fs.readdirSync(this.persistDir)
        .filter(f => (f.startsWith('traces-') || f.startsWith('prompts-')) && f.endsWith('.jsonl'))
      for (const file of files) {
        const prefix = file.startsWith('traces-') ? 'traces-' : 'prompts-'
        const dateStr = file.slice(prefix.length, prefix.length + 10)
        if (dateStr >= cutoffStr) continue
        const filePath = path.join(this.persistDir, file)
        const stat = fs.statSync(filePath)
        affectedBytes += stat.size
        // 只对 traces-* 抓 trace_id 进 deletedIds（语义保持原状：返回的是被删的 trace 数）。
        // prompts-* 文件被一起删，但不计入 affected_count——它的"条数"跟 trace 条数没对位关系。
        if (prefix === 'traces-') {
          const content = fs.readFileSync(filePath, 'utf-8')
          const ids: string[] = []
          for (const line of content.split('\n')) {
            if (!line.trim()) continue
            try {
              const trace = JSON.parse(line) as { trace_id?: string }
              if (trace.trace_id) ids.push(trace.trace_id)
            } catch { /* skip malformed */ }
          }
          affectedTraces += ids.length
          if (!dryRun) {
            deletedIds.push(...ids)
          }
        }
        if (!dryRun) {
          toDelete.push(file)
        }
      }
      if (!dryRun) {
        for (const file of toDelete) {
          try {
            fs.unlinkSync(path.join(this.persistDir, file))
            this.traceIndex = this.traceIndex.filter(e => e.file !== file)
          } catch (err) {
            console.warn(`[TraceStore] cleanupTracesBeforeDate delete failed for ${file}:`, err instanceof Error ? err.message : err)
          }
        }
        if (toDelete.length > 0) {
          this.rebuildTaskIndex()
        }
      }
    } catch (err) {
      console.warn('[TraceStore] cleanupTracesBeforeDate failed:', err instanceof Error ? err.message : err)
    }

    return {
      affected_count: affectedTraces,
      affected_bytes: affectedBytes,
      deleted_trace_ids: deletedIds,
    }
  }

  /**
   * @deprecated 用 cleanupOldTraces 替代；保留是为了不破坏现有调用方。
   * 返回被删文件数（估算：通过会被清理的文件数预计算）。
   */
  cleanupOldFiles(retentionDays: number): number {
    if (!this.persistDir || !Number.isFinite(retentionDays) || retentionDays < 1 || !fs.existsSync(this.persistDir)) return 0
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    let fileCount = 0
    try {
      const files = fs.readdirSync(this.persistDir)
        .filter(f => f.startsWith('traces-') && f.endsWith('.jsonl'))
      fileCount = files.filter(f => f.slice('traces-'.length, 'traces-'.length + 10) < cutoffStr).length
    } catch { /* best effort */ }
    this.cleanupOldTraces(retentionDays, false)
    return fileCount
  }

  private addToTaskIndex(taskId: string, traceId: string): void {
    const existing = this.taskIndex.get(taskId) ?? []
    if (!existing.includes(traceId)) {
      this.taskIndex.set(taskId, [...existing, traceId])
    }
  }

  private traceToIndexEntry(trace: AgentTrace, file: string, fileOffset: number): TraceIndexEntry {
    // total_usage 优先取持久化时计算的值（endTrace 已回填）；rebuild 时若缺失则按 spans 重算。
    const totalUsage = trace.total_usage ?? aggregateUsage(trace.spans ?? [])
    return {
      trace_id: trace.trace_id,
      related_task_id: trace.related_task_id,
      parent_trace_id: trace.parent_trace_id,
      trigger_type: trace.trigger.type,
      trigger_summary: trace.trigger.summary,
      trigger_task_type: trace.trigger.task_type,
      started_at: trace.started_at,
      ended_at: trace.ended_at,
      duration_ms: trace.duration_ms,
      status: trace.status,
      outcome_summary: trace.outcome?.summary,
      span_count: trace.spans?.length ?? 0,
      ...(totalUsage ? { total_usage: totalUsage } : {}),
      file,
      file_offset: fileOffset,
    }
  }

  private rebuildTaskIndex(): void {
    this.taskIndex.clear()
    for (const entry of this.traceIndex) {
      if (entry.related_task_id) {
        this.addToTaskIndex(entry.related_task_id, entry.trace_id)
      }
    }
  }

  private persistTrace(trace: AgentTrace): void {
    if (!this.persistDir) return
    try {
      const date = trace.started_at.slice(0, 10)
      const file = `traces-${date}.jsonl`
      const filePath = path.join(this.persistDir, file)
      const line = JSON.stringify(trace) + '\n'

      let fileOffset = 0
      try { fileOffset = fs.statSync(filePath).size } catch { /* new file */ }

      fs.appendFileSync(filePath, line, 'utf-8')

      // 更新已有 index entry（如 appendTraceOutcome 二次写入），不重复 push
      const newEntry = this.traceToIndexEntry(trace, file, fileOffset)
      const existingIdx = this.traceIndex.findIndex(e => e.trace_id === trace.trace_id)
      if (existingIdx !== -1) {
        this.traceIndex[existingIdx] = newEntry
      } else {
        this.traceIndex.push(newEntry)
      }
      if (trace.related_task_id) {
        this.addToTaskIndex(trace.related_task_id, trace.trace_id)
      }
    } catch (err) {
      // persist failure must not affect main flow
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[TraceStore] persistTrace failed for ${trace.trace_id}: ${msg}`)
    }
  }
}
