import type { EngineMessageLike } from '../../services/trace'

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

export interface ToolIO {
  input: Record<string, unknown> | undefined
  output: string | undefined
  isError: boolean
}

/** 按 tool_use_id 从 messages 取该工具的完整入参(tool_use 块)与结果(toolResults)。找不到返回 null。 */
export function findToolIO(
  messages: ReadonlyArray<EngineMessageLike>,
  toolUseId: string,
): ToolIO | null {
  let input: Record<string, unknown> | undefined
  let output: string | undefined
  let isError = false
  let found = false
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_use' && b.id === toolUseId) {
          input = (b.input as Record<string, unknown>) ?? {}
          found = true
        }
      }
    }
    if (Array.isArray(m.toolResults)) {
      for (const tr of m.toolResults as Array<Record<string, unknown>>) {
        if (tr.tool_use_id === toolUseId) {
          output = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content, null, 2)
          isError = Boolean(tr.is_error)
          found = true
        }
      }
    }
  }
  return found ? { input, output, isError } : null
}

export interface AssistantOutput {
  /** assistant 文本块拼接(保序)。 */
  text: string
  /** 本轮调用的工具名(按出现序)。 */
  toolNames: string[]
}

/** 从 llm 轮切片里只取 assistant 的文本块与所调工具名,丢弃 tool_result。 */
export function extractAssistantOutput(
  slice: ReadonlyArray<EngineMessageLike>,
): AssistantOutput {
  const texts: string[] = []
  const toolNames: string[] = []
  for (const m of slice) {
    if (m.role !== 'assistant') continue
    if (typeof m.content === 'string') {
      if (m.content) texts.push(m.content)
    } else if (Array.isArray(m.content)) {
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text) texts.push(b.text)
        else if (b.type === 'tool_use' && typeof b.name === 'string') toolNames.push(b.name)
      }
    }
  }
  return { text: texts.join('\n\n'), toolNames }
}
