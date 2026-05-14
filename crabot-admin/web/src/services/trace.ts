/**
 * Trace 服务 - Agent 执行 Trace 的 REST 调用封装
 * 字段对齐 protocol-agent-v2.md §8
 */

import { api } from './api'

/**
 * 跨 Provider 统一语义：
 *   input_tokens         = 未命中缓存的输入 token（实际计费的 prompt 部分）
 *   cache_read_tokens    = 命中缓存读取的部分（> 0 即代表本次有缓存命中）
 *   cache_creation_tokens = 写入缓存的部分（Anthropic 专属）
 *   全量 prompt size     = input_tokens + (cache_read_tokens ?? 0) + (cache_creation_tokens ?? 0)
 */
export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_tokens?: number
  cache_read_tokens?: number
}

/** 全量 prompt size（含命中和写入）。 */
export function totalPromptTokens(u: TokenUsage): number {
  return u.input_tokens + (u.cache_read_tokens ?? 0) + (u.cache_creation_tokens ?? 0)
}

/** 缓存命中率（0-1）；无缓存返回 0。 */
export function cacheHitRate(u: TokenUsage): number {
  const total = totalPromptTokens(u)
  if (total === 0) return 0
  return (u.cache_read_tokens ?? 0) / total
}

export type AgentSpanType =
  | 'agent_loop'
  | 'llm_call'
  | 'tool_call'
  | 'sub_agent_call'
  | 'decision'
  | 'context_assembly'
  | 'context_fetch'
  | 'memory_write'
  | 'rpc_call'
  | 'bg_entity_spawn'
  | 'bg_entity_output'
  | 'bg_entity_kill'
  | 'bg_entity_exit'
  | 'llm_retry'

export interface AgentSpan {
  span_id: string
  parent_span_id?: string
  trace_id: string
  type: AgentSpanType
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  details: Record<string, unknown>
}

export interface AgentTrace {
  trace_id: string
  parent_trace_id?: string
  parent_span_id?: string
  related_task_id?: string
  module_id: string
  started_at: string
  ended_at?: string
  duration_ms?: number
  status: 'running' | 'completed' | 'failed'
  trigger: {
    type: 'message' | 'task' | 'schedule' | 'sub_agent_call'
    summary: string
    source?: string
    task_type?: string
  }
  spans: AgentSpan[]
  outcome?: {
    summary: string
    error?: string
  }
  total_usage?: TokenUsage
}

/** 列表场景使用的轻量级索引（不含 spans，含汇总 token）。 */
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
  total_usage?: TokenUsage
}

export interface TraceTree {
  task_id: string
  tree: {
    fronts: TraceIndexEntry[]
    worker: TraceIndexEntry | null
    subagents: TraceIndexEntry[]
  }
}

export interface SearchTracesResult {
  traces: TraceIndexEntry[]
  total: number
}

export interface SearchTracesParams {
  task_id?: string
  keyword?: string
  status?: 'running' | 'completed' | 'failed'
  /** ISO 8601；start <= started_at < end */
  start?: string
  end?: string
  limit?: number
  offset?: number
}

export const traceService = {
  /**
   * 列表查询：合并磁盘索引 + 内存中正在运行的 trace，支持分页与过滤。
   * 比 getTraces 轻量（不含 spans），用于 Traces 页主列表。
   */
  async searchTraces(params?: SearchTracesParams): Promise<SearchTracesResult> {
    const qs = new URLSearchParams()
    if (params?.task_id) qs.set('task_id', params.task_id)
    if (params?.keyword) qs.set('keyword', params.keyword)
    if (params?.status) qs.set('status', params.status)
    if (params?.start) qs.set('start', params.start)
    if (params?.end) qs.set('end', params.end)
    if (params?.limit !== undefined) qs.set('limit', String(params.limit))
    if (params?.offset !== undefined) qs.set('offset', String(params.offset))
    const query = qs.toString() ? `?${qs.toString()}` : ''
    return api.get<SearchTracesResult>(`/agent/traces/search${query}`)
  },

  /** 详情：含 spans，按需加载（可能从磁盘 JSONL 回捞） */
  async getTrace(traceId: string): Promise<{ trace: AgentTrace }> {
    return api.get(`/agent/traces/${traceId}`)
  },

  async getTraceTree(taskId: string): Promise<TraceTree> {
    return api.get<TraceTree>(`/agent/trace-tree/${taskId}`)
  },

  async clearTraces(_params?: {
    before?: string
    trace_ids?: string[]
  }): Promise<{ cleared_count: number }> {
    return api.delete(`/agent/traces`)
  },
}
