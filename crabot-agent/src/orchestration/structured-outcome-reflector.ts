import type { EngineMessage } from '../engine/types.js'
import { createUserMessage, createAssistantMessage } from '../engine/types.js'
import type { LLMAdapter } from '../engine/llm-adapter-types.js'
import { callNonStreaming } from '../engine/llm-adapter-types.js'

const MAX_BRIEF_LEN = 200
const MAX_HIGHLIGHTS = 3
const MAX_HIGHLIGHT_LEN = 80
const DEFAULT_MAX_RETRIES = 2

const REFLECT_PROMPT =
  '任务已完成。请用 JSON 格式输出本次任务的反思总结：\n\n' +
  '```json\n' +
  '{\n' +
  '  "outcome_brief": "≤200 字。简述本任务做了什么、是否顺利。",\n' +
  '  "process_highlights": ["≤80 字 / 条，最多 3 条。仅写过程中的【异常 / 兜底切换 / 关键决策】。无亮点传 []。"]\n' +
  '}\n' +
  '```\n\n' +
  '这份总结会进入跨 session 长期记忆，未来你或其他 worker 复盘时会查到。' +
  '只输出 JSON 块，不要其他文字。'

const FIX_PROMPT_HEADER = '上次 JSON 输出有问题：'

const FENCE_RE = /```json\s*\n([\s\S]*?)\n```/

interface ReflectorParams {
  readonly messages: readonly EngineMessage[]
  readonly adapter: LLMAdapter
  readonly model: string
  readonly lastAssistantText: string
  readonly maxRetries?: number
}

export interface ReflectResult {
  readonly outcome_brief: string
  readonly process_highlights: readonly string[]
  readonly retries: number
  readonly fellBackToLastText: boolean
}

type ParseAttempt =
  | { readonly ok: true; readonly value: { outcome_brief: string; process_highlights: string[] } }
  | { readonly ok: false; readonly error: string }

function parseAndValidate(text: string): ParseAttempt {
  const match = text.match(FENCE_RE)
  const raw = match ? match[1] : text.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `JSON 语法错误：${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'JSON 顶层必须是 object' }
  }
  const obj = parsed as Record<string, unknown>
  const brief = obj.outcome_brief
  const highlights = obj.process_highlights
  if (typeof brief !== 'string') {
    return { ok: false, error: 'outcome_brief 必须是 string' }
  }
  if (!Array.isArray(highlights)) {
    return { ok: false, error: 'process_highlights 必须是 array' }
  }
  if (!highlights.every(h => typeof h === 'string')) {
    return { ok: false, error: 'process_highlights 每一项必须是 string' }
  }
  return {
    ok: true,
    value: {
      outcome_brief: brief.slice(0, MAX_BRIEF_LEN),
      process_highlights: (highlights as string[])
        .slice(0, MAX_HIGHLIGHTS)
        .map(h => h.slice(0, MAX_HIGHLIGHT_LEN)),
    },
  }
}

export async function reflectStructuredOutcome(params: ReflectorParams): Promise<ReflectResult> {
  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES
  const workingMessages: EngineMessage[] = [...params.messages, createUserMessage(REFLECT_PROMPT)]

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await callNonStreaming(params.adapter, {
      messages: workingMessages,
      systemPrompt: '',
      tools: [],
      model: params.model,
    })
    const text = response.content
      .filter((b): b is { readonly type: 'text'; readonly text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')

    const parsed = parseAndValidate(text)
    if (parsed.ok) {
      return {
        outcome_brief: parsed.value.outcome_brief,
        process_highlights: parsed.value.process_highlights,
        retries: attempt,
        fellBackToLastText: false,
      }
    }

    if (attempt < maxRetries) {
      workingMessages.push(createAssistantMessage([{ type: 'text', text }], 'end_turn'))
      workingMessages.push(createUserMessage(
        `${FIX_PROMPT_HEADER}${parsed.error}\n请重新按 schema 输出 JSON。`
      ))
    }
  }

  return {
    outcome_brief: params.lastAssistantText.slice(0, MAX_BRIEF_LEN),
    process_highlights: [],
    retries: maxRetries,
    fellBackToLastText: true,
  }
}
