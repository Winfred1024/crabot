/**
 * Worker trace 消息切片工具
 *
 * 从 resume_checkpoint.messages（累积快照）+ 各 llm_call span 的
 * message_count_after 字段，切出"第 i 个 llm_call span 本轮产出的消息"。
 *
 * 切片逻辑：
 *   第 i 个 span 的产出 = messages[prev_count .. cur_count)
 *   其中 prev_count = orderedLlmSpans[i-1].message_count_after ?? 0  （i > 0）
 *               或 = 第一条 assistant 消息的下标                       （i = 0）
 *        cur_count  = orderedLlmSpans[i].message_count_after
 *
 * span0 特殊处理：累积快照里 span0 之前可能含触发消息 / resume 恢复历史（均为
 * user/tool_result），这些是输入不是产出。从第一条 assistant 消息起才是本轮产出。
 */
export function sliceSpanMessages<T extends { role?: string }>(
  messages: ReadonlyArray<T>,
  orderedLlmSpans: ReadonlyArray<{ message_count_after?: number }>,
  spanIndex: number,
): T[] {
  const end = orderedLlmSpans[spanIndex]?.message_count_after
  if (end == null) return []
  let prev: number
  if (spanIndex > 0) {
    prev = orderedLlmSpans[spanIndex - 1]?.message_count_after ?? 0
  } else {
    const firstAssistant = messages.findIndex(m => m.role === 'assistant')
    prev = firstAssistant >= 0 ? firstAssistant : 0
  }
  return messages.slice(prev, end) as T[]
}
