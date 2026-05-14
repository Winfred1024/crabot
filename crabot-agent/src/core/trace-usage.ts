/**
 * Token usage 转换：adapter 层用驼峰 LLMTokenUsage，trace 协议用蛇形 TokenUsage。
 * 同时提供多个 LlmCallDetails.usage 的聚合（trace-store 持久化时用）。
 */

import type { LLMTokenUsage } from '../engine/types.js'
import type { TokenUsage, AgentSpan, LlmCallDetails } from '../types.js'

export function llmUsageToTrace(u: LLMTokenUsage): TokenUsage {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    ...(u.cacheCreationTokens !== undefined ? { cache_creation_tokens: u.cacheCreationTokens } : {}),
    ...(u.cacheReadTokens !== undefined ? { cache_read_tokens: u.cacheReadTokens } : {}),
  }
}

/** 把 trace 内所有 llm_call span 的 usage 求和，得到 trace 的 total_usage。 */
export function aggregateUsage(spans: ReadonlyArray<AgentSpan>): TokenUsage | undefined {
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreation = 0
  let cacheRead = 0
  let any = false
  let anyCacheCreation = false
  let anyCacheRead = false

  for (const span of spans) {
    if (span.type !== 'llm_call') continue
    const usage = (span.details as LlmCallDetails).usage
    if (!usage) continue
    any = true
    inputTokens += usage.input_tokens ?? 0
    outputTokens += usage.output_tokens ?? 0
    if (typeof usage.cache_creation_tokens === 'number') {
      cacheCreation += usage.cache_creation_tokens
      anyCacheCreation = true
    }
    if (typeof usage.cache_read_tokens === 'number') {
      cacheRead += usage.cache_read_tokens
      anyCacheRead = true
    }
  }

  if (!any) return undefined
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(anyCacheCreation ? { cache_creation_tokens: cacheCreation } : {}),
    ...(anyCacheRead ? { cache_read_tokens: cacheRead } : {}),
  }
}
