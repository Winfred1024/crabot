/**
 * Pre-Front Dispatcher 入口。
 *
 * 输入消息批次 + active_tasks，LLM 单次调用输出动作列表。
 * - LLM 通过结构化文本输出 JSON（{"actions": [...]}）
 * - schema 校验失败 / JSON 解析失败 / 不合法动作类型 → 重试
 * - 重试用完 → 调 sendErrorToUser 向人类报错 + 返回空 actions
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §3
 */

import type { LLMAdapter } from '../engine/llm-adapter-types.js'
import { callNonStreaming, extractText } from '../engine/llm-adapter-types.js'
import type { EngineUserMessage } from '../engine/types.js'
import type { DispatchContext, DispatchResult, DispatchAction } from './dispatcher-types.js'
import { MAX_ACTIONS_PER_DISPATCH } from './dispatcher-types.js'
import { assembleDispatcherPrompt } from './dispatcher-prompt.js'

export interface DispatchDeps {
  readonly adapter: LLMAdapter
  readonly modelId: string
  readonly sendErrorToUser: (errorText: string) => Promise<void>
  readonly maxParseRetries?: number
}

const DEFAULT_MAX_PARSE_RETRIES = 3

export async function dispatch(ctx: DispatchContext, deps: DispatchDeps): Promise<DispatchResult> {
  const maxRetries = deps.maxParseRetries ?? DEFAULT_MAX_PARSE_RETRIES
  const systemPrompt = assembleDispatcherPrompt(ctx)
  const userMessage: EngineUserMessage = {
    id: `dispatch-${Date.now()}`,
    role: 'user',
    content: buildUserPrompt(ctx),
    timestamp: Date.now(),
  }

  let lastError = ''
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await callNonStreaming(deps.adapter, {
        messages: [userMessage],
        systemPrompt,
        tools: [],
        model: deps.modelId,
        maxTokens: 1500,
      })
      const text = extractText(response.content)
      const parsed = parseAndValidate(text, ctx)
      if (parsed.ok) {
        return { actions: parsed.actions.slice(0, MAX_ACTIONS_PER_DISPATCH) }
      }
      lastError = parsed.error
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  await deps.sendErrorToUser(`系统出错，未能处理刚才的消息：${lastError.slice(0, 200)}`)
  return { actions: [] }
}

function buildUserPrompt(ctx: DispatchContext): string {
  const lines: string[] = []
  lines.push('## 当前消息批次')
  for (const m of ctx.messages) {
    const text = (m.content.text ?? '[非文本]').slice(0, 2000)
    lines.push(`[${m.sender.platform_display_name}] ${text}`)
  }
  if (ctx.activeTasks.length > 0) {
    lines.push('\n## 活跃任务')
    for (const t of ctx.activeTasks) {
      lines.push(`- [${t.task_id}] "${t.title}" (status: ${t.status})`)
      if (t.latest_progress) lines.push(`  最近进度: ${t.latest_progress}`)
      if (t.pending_question) lines.push(`  正在等回答: ${t.pending_question.slice(0, 200)}`)
    }
  } else {
    lines.push('\n## 活跃任务\n（无）')
  }
  lines.push('\n按 system prompt 描述的 schema 输出 JSON。')
  return lines.join('\n')
}

type ValidationResult =
  | { readonly ok: true; readonly actions: ReadonlyArray<DispatchAction> }
  | { readonly ok: false; readonly error: string }

function parseAndValidate(text: string, ctx: DispatchContext): ValidationResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim()
  let obj: unknown
  try {
    obj = JSON.parse(cleaned)
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof obj !== 'object' || obj === null || !('actions' in obj)) {
    return { ok: false, error: '输出缺少 actions 字段' }
  }
  const actions = (obj as { actions: unknown }).actions
  if (!Array.isArray(actions)) {
    return { ok: false, error: 'actions 不是数组' }
  }
  const validated: DispatchAction[] = []
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i] as Record<string, unknown>
    if (typeof a?.kind !== 'string') return { ok: false, error: `action[${i}].kind 缺失` }
    if (a.kind === 'supplement') {
      if (typeof a.target_task_id !== 'string' || typeof a.text !== 'string') {
        return { ok: false, error: `action[${i}] supplement 缺 target_task_id 或 text` }
      }
      validated.push({ kind: 'supplement', target_task_id: a.target_task_id, text: a.text })
    } else if (a.kind === 'new_task') {
      if (typeof a.text !== 'string') return { ok: false, error: `action[${i}] new_task 缺 text` }
      validated.push({ kind: 'new_task', text: a.text })
    } else if (a.kind === 'stay_silent') {
      if (ctx.sessionType !== 'group') {
        return { ok: false, error: `action[${i}] stay_silent 仅群聊允许` }
      }
      validated.push({ kind: 'stay_silent', reason: typeof a.reason === 'string' ? a.reason : undefined })
    } else {
      return { ok: false, error: `action[${i}].kind 非法: ${a.kind}` }
    }
  }
  return { ok: true, actions: validated }
}
