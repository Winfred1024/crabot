import { describe, it, expect } from 'vitest'
import { extractTaskOutcome } from '../../src/orchestration/task-outcome-parser.js'

describe('extractTaskOutcome', () => {
  it('从末尾 JSON 块提取 brief + highlights，返回 stripped summary', () => {
    const summary = `已修复 /fav 500 接口，根因是 vod_ids 未校验。

\`\`\`json
{
  "outcome_brief": "已修复 /fav 500，根因 vod_ids 未校验",
  "process_highlights": [
    "用 grep 定位到 FavHandler",
    "缺 vod_ids 校验导致 nil deref"
  ]
}
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.outcome_brief).toBe('已修复 /fav 500，根因 vod_ids 未校验')
    expect(r.process_highlights).toEqual([
      '用 grep 定位到 FavHandler',
      '缺 vod_ids 校验导致 nil deref',
    ])
    expect(r.stripped_summary).toBe('已修复 /fav 500 接口，根因是 vod_ids 未校验。')
  })

  it('无 JSON 块 → fallback：brief = summary.slice(0,200), highlights = [], stripped = summary 原文', () => {
    const summary = '简单回复。'
    const r = extractTaskOutcome(summary, 200)
    expect(r.outcome_brief).toBe('简单回复。')
    expect(r.process_highlights).toEqual([])
    expect(r.stripped_summary).toBe('简单回复。')
  })

  it('JSON 块格式错（缺字段）→ fallback', () => {
    const summary = `回复。

\`\`\`json
{ "wrong_field": "x" }
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.outcome_brief).toBe('回复。')
    expect(r.process_highlights).toEqual([])
  })

  it('JSON 块语法错 → fallback', () => {
    const summary = `回复。

\`\`\`json
not valid json {
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.outcome_brief).toBe('回复。')
  })

  it('summary 过长时 fallback brief 截到 maxLen 字', () => {
    const summary = '甲'.repeat(500)
    const r = extractTaskOutcome(summary, 200)
    expect(r.outcome_brief).toHaveLength(200)
  })

  it('截断 highlights：超过 3 条丢弃多余', () => {
    const summary = `done.

\`\`\`json
{
  "outcome_brief": "ok",
  "process_highlights": ["a", "b", "c", "d", "e"]
}
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.process_highlights).toEqual(['a', 'b', 'c'])
  })

  it('截断 highlights：单条超 80 字裁剪', () => {
    const long = '亮'.repeat(120)
    const summary = `done.

\`\`\`json
{
  "outcome_brief": "ok",
  "process_highlights": ["${long}"]
}
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.process_highlights).toHaveLength(1)
    expect(r.process_highlights[0]).toHaveLength(80)
  })

  it('截断 brief：超 maxLen 字截断', () => {
    const long = '简'.repeat(300)
    const summary = `done.

\`\`\`json
{
  "outcome_brief": "${long}",
  "process_highlights": []
}
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.outcome_brief).toHaveLength(200)
  })

  it('summary 中夹带内联 ```json 块时只匹配末尾契约块', () => {
    const summary = `解释：返回值如 \`\`\`json
{"a":1}
\`\`\` 这样。

\`\`\`json
{"outcome_brief":"完成","process_highlights":[]}
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.outcome_brief).toBe('完成')
    expect(r.process_highlights).toEqual([])
    // stripped_summary 应保留前面的解释段（含内联 ```json 例子）
    expect(r.stripped_summary).toContain('解释：返回值如')
    expect(r.stripped_summary).toContain('{"a":1}')
    expect(r.stripped_summary).not.toContain('"outcome_brief"')
  })
})
