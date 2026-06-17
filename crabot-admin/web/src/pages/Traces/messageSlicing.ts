/**
 * Worker trace 消息切片工具
 *
 * 从 resume_checkpoint.messages（累积快照）+ 各 llm_call span 的
 * message_count_after 字段，切出"第 i 个 llm_call span 本轮产出的消息"。
 *
 * 切片逻辑：
 *   第 i 个 span 的产出 = messages[prev_count .. cur_count)
 *   其中 prev_count = orderedLlmSpans[i-1].message_count_after ?? 0
 *        cur_count  = orderedLlmSpans[i].message_count_after
 */
export function sliceSpanMessages<T>(
  messages: ReadonlyArray<T>,
  orderedLlmSpans: ReadonlyArray<{ message_count_after?: number }>,
  spanIndex: number,
): T[] {
  const end = orderedLlmSpans[spanIndex]?.message_count_after
  if (end == null) return []
  const prev = spanIndex > 0 ? (orderedLlmSpans[spanIndex - 1]?.message_count_after ?? 0) : 0
  return messages.slice(prev, end) as T[]
}
