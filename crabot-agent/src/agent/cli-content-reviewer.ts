/**
 * CLI 内容审核器
 *
 * 当某个 CLI 命令（目前仅 `schedule add`）属于 REQUIRES_CONTENT_REVIEW 时，
 * 在 hook 层放行前调一次 LLM 判断：该 schedule 跑起来后让 worker 执行的事
 * 是否仍落在发起人 effective_permissions 的工具范围内。
 *
 * **Fail-closed**：LLM 调用失败 / 超时 / 返回非法格式 → 一律 deny。
 */

import type { ResolvedPermissions } from '../types.js'
import type { LLMAdapter } from '../engine/llm-adapter-types.js'
import { callNonStreaming, extractText } from '../engine/llm-adapter-types.js'
import type { EngineUserMessage } from '../engine/types.js'

export interface ReviewParams {
  readonly effectivePermissions: ResolvedPermissions
  readonly commandText: string
  readonly adapter: LLMAdapter
  readonly modelId: string
  readonly timeoutMs?: number
}

export interface ReviewResult {
  readonly verdict: 'approve' | 'deny'
  readonly reason: string
}

const DEFAULT_TIMEOUT_MS = 8_000

const SYSTEM_PROMPT = `你是 Crabot 的命令安全审核员。给定一条 \`crabot schedule add\` 命令以及发起人的 effective permissions，
判断该 schedule 触发后让 worker 执行的事，是否仍落在 effective permissions 的工具范围内。

判定标准（严格）：
1. 若 schedule 描述需要 worker 调用的工具类别（如 shell / file_io / browser / desktop / remote_exec）超出 tool_access 允许的范围 → deny
2. 若描述含明显破坏意图（rm -rf、curl|bash、删库、外发凭证等）→ deny
3. 否则 → approve

只输出一个 JSON 对象（可被 \`\`\`json 围栏包裹），不要解释、不要多余文本：
{"verdict":"approve"|"deny","reason":"<≤80 字理由>"}`

export async function reviewCliContent(params: ReviewParams): Promise<ReviewResult> {
  const userPrompt = buildUserPrompt(params)
  const userMessage: EngineUserMessage = {
    id: `review-${Date.now()}`,
    role: 'user',
    content: userPrompt,
    timestamp: Date.now(),
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await callNonStreaming(params.adapter, {
      messages: [userMessage],
      systemPrompt: SYSTEM_PROMPT,
      tools: [],
      model: params.modelId,
      maxTokens: 200,
      signal: controller.signal,
    })
    const text = extractText(response.content)
    const parsed = parseVerdict(text)
    if (!parsed) {
      return {
        verdict: 'deny',
        reason: '审核服务返回非法格式（fail-closed）',
      }
    }
    return parsed
  } catch (err) {
    return {
      verdict: 'deny',
      reason: `审核服务不可用（fail-closed）: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

function buildUserPrompt(params: ReviewParams): string {
  const allowed = formatPerms(params.effectivePermissions)
  return `Effective permissions:\n${allowed}\n\nCommand:\n${params.commandText}\n\n请审核。`
}

function formatPerms(p: ResolvedPermissions): string {
  const ta = Object.entries(p.tool_access)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join(', ')
  const ca = Object.entries(p.cli_access)
    .filter(([, v]) => v !== 'none')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  return `tool_access: ${ta || '(none)'}\ncli_access: ${ca || '(none)'}`
}

function parseVerdict(text: string): ReviewResult | null {
  // 1. 剥 markdown 围栏 ```json ... ``` 或 ``` ... ```
  let body = text.trim()
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/)
  if (fence) body = fence[1]!.trim()

  // 2. 用 bracket-balance 找第一个完整 JSON object（避免 reason 内含 `}` 时 lazy regex 截断）
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let end = -1
  let inStr = false
  let escape = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (escape) { escape = false; continue }
      if (c === '\\') { escape = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return null

  try {
    const obj = JSON.parse(body.slice(start, end + 1)) as { verdict?: string; reason?: string }
    if (obj.verdict !== 'approve' && obj.verdict !== 'deny') return null
    return { verdict: obj.verdict, reason: String(obj.reason ?? '') }
  } catch {
    return null
  }
}
