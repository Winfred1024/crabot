/**
 * 从 worker 最终 summary 末尾的 ```json {...}``` fence 块解析 outcome_brief +
 * process_highlights，并返回剥掉 fence 的 stripped_summary（用户面用）。
 *
 * 解析失败（无 fence / 语法错 / 字段缺失）走 fallback：brief = stripped_summary.slice(0,
 * maxLen)、highlights = []。fence 存在但内容坏时仍剥掉 fence——避免无效 ```json``` 泄到用户面。
 *
 * 不抛异常，调用方拿到的字段总是合法可用。
 */

const MAX_HIGHLIGHTS = 3
const MAX_HIGHLIGHT_LEN = 80

export interface TaskOutcomeFields {
  outcome_brief: string
  process_highlights: string[]
  stripped_summary: string
}

// 锚到 summary 末尾的最后一个 ```json fence。负向预查 (?!```json\s*\n) 保证捕获组
// 不会跨越中间内联的 ```json 例子（worker 在解释 API/config 时可能会写）。
const JSON_FENCE_RE = /\n*```json\s*\n((?:(?!```json\s*\n)[\s\S])*?)\n```\s*$/

export function extractTaskOutcome(summary: string, maxBriefLen: number): TaskOutcomeFields {
  const match = summary.match(JSON_FENCE_RE)
  const strippedSummary = match ? summary.slice(0, match.index!).trimEnd() : summary
  const fallback = (): TaskOutcomeFields => ({
    outcome_brief: strippedSummary.slice(0, maxBriefLen),
    process_highlights: [],
    stripped_summary: strippedSummary,
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

  return {
    outcome_brief: brief.slice(0, maxBriefLen),
    process_highlights: (highlights as string[])
      .slice(0, MAX_HIGHLIGHTS)
      .map((h) => h.slice(0, MAX_HIGHLIGHT_LEN)),
    stripped_summary: strippedSummary,
  }
}
