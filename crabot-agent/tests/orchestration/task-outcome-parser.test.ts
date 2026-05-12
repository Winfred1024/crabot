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

  it('fence 外为空时 stripped_summary 退到 brief，避免用户面 0 chars', () => {
    // 2026-05-12 b05db23a 事故：worker 把整段内容都塞进 fence、fence 外什么都没写。
    // 修复前 stripped_summary = ''，dispatcher 把空串发给 telegram → "0 chars" 静默失败。
    const summary = `\`\`\`json
{
  "outcome_brief": "完成 Crypto 信号增强三方向研究",
  "process_highlights": ["RSI 增强行情分类极差 36.5pp"]
}
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.outcome_brief).toBe('完成 Crypto 信号增强三方向研究')
    expect(r.process_highlights).toEqual(['RSI 增强行情分类极差 36.5pp'])
    // 关键：stripped_summary 不再是空串，而是退到 brief
    expect(r.stripped_summary).toBe('完成 Crypto 信号增强三方向研究')
  })

  it('fence 外只有空白时也走 brief 兜底', () => {
    const summary = `\n\n   \n\`\`\`json
{ "outcome_brief": "ok", "process_highlights": [] }
\`\`\``
    const r = extractTaskOutcome(summary, 200)
    expect(r.stripped_summary).toBe('ok')
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
