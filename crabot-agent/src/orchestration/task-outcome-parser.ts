/**
 * Phase 2：从 worker 任务最终 summary 末尾的 ```json {...}``` 块解析结构化输出。
 *
 * Worker prompt 要求在最终回复末尾追加一个 ```json fence 块，含：
 *   { "outcome_brief": "...", "process_highlights": ["..", "..", ".."] }
 *
 * - 解析成功 → 返回结构化字段 + stripped_summary（去除 JSON 块的纯文本）
 * - 无 fence 块 → fallback：brief = summary.slice(0, maxLen), highlights = [],
 *   stripped_summary = summary 原文
 * - fence 块存在但内容坏了（语法错 / 字段缺失）→ fallback：brief / stripped 都从
 *   summary 里把 fence 块剥掉再返回，避免无效 ```json``` 噪声泄到用户面
 *
 * 失败不抛异常 — 调用方拿到的字段总是合法可用。
 */

const MAX_HIGHLIGHTS = 3
const MAX_HIGHLIGHT_LEN = 80

export interface TaskOutcomeFields {
  outcome_brief: string
  process_highlights: string[]
  stripped_summary: string
  parsed: boolean
}

const JSON_FENCE_RE = /\n*```json\s*\n([\s\S]*?)\n```\s*$/

export function extractTaskOutcome(summary: string, maxBriefLen: number): TaskOutcomeFields {
  const match = summary.match(JSON_FENCE_RE)

  // 即使 JSON 块解析失败，也应把 fence 块从 brief / stripped 里剥掉，
  // 避免用户面文本里残留无效的 ```json ...```（worker 还是按契约附带了块，
  // 只是内容坏了 — 不应让用户看到这个噪声）。
  const fallbackText = match ? summary.slice(0, match.index!).trimEnd() : summary
  const fallback = (): TaskOutcomeFields => ({
    outcome_brief: fallbackText.slice(0, maxBriefLen),
    process_highlights: [],
    stripped_summary: fallbackText,
    parsed: false,
  })

  if (!match) return fallback()

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return fallback()
  }

  if (typeof parsed !== 'object' || parsed === null) return fallback()
  const obj = parsed as Record<string, unknown>

  const brief = obj['outcome_brief']
  const highlights = obj['process_highlights']

  if (typeof brief !== 'string' || !Array.isArray(highlights)) return fallback()
  if (!highlights.every((h) => typeof h === 'string')) return fallback()

  const trimmedBrief = brief.slice(0, maxBriefLen)
  const trimmedHighlights = (highlights as string[])
    .slice(0, MAX_HIGHLIGHTS)
    .map((h) => h.slice(0, MAX_HIGHLIGHT_LEN))

  const strippedSummary = summary.slice(0, match.index!).trimEnd()

  return {
    outcome_brief: trimmedBrief,
    process_highlights: trimmedHighlights,
    stripped_summary: strippedSummary,
    parsed: true,
  }
}
