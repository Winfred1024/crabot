import { describe, it, expect } from 'vitest'
import { reflectStructuredOutcome } from '../../src/orchestration/structured-outcome-reflector.js'
import type { EngineMessage } from '../../src/engine/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

function makeAdapter(responses: string[]): LLMAdapter {
  let i = 0
  return {
    stream: async function* () {
      yield* chunksFromContent(
        [{ type: 'text' as const, text: responses[i++] ?? '' }],
        'end_turn',
        { inputTokens: 100, outputTokens: 50 },
      )
    },
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

const FALLBACK_TEXT = '执行完毕，结果已发给用户。'

describe('reflectStructuredOutcome', () => {
  it('正常路径：LLM 一次性输出合法 JSON', async () => {
    const adapter = makeAdapter([
      '```json\n{"outcome_brief":"完成任务 X","process_highlights":["亮点 1"]}\n```',
    ])
    const r = await reflectStructuredOutcome({
      messages: [] as EngineMessage[],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
    })
    expect(r.outcome_brief).toBe('完成任务 X')
    expect(r.process_highlights).toEqual(['亮点 1'])
    expect(r.retries).toBe(0)
    expect(r.fellBackToLastText).toBe(false)
  })

  it('JSON 错时 retry，第二次成功', async () => {
    const adapter = makeAdapter([
      '我不打算输出 JSON',
      '```json\n{"outcome_brief":"修正后","process_highlights":[]}\n```',
    ])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
    })
    expect(r.outcome_brief).toBe('修正后')
    expect(r.retries).toBe(1)
    expect(r.fellBackToLastText).toBe(false)
  })

  it('JSON 错 + 重试上限耗尽后 fallback 到 lastAssistantText.slice(0,200)', async () => {
    const adapter = makeAdapter(['bad', 'still bad', 'still bad again'])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
      maxRetries: 2,
    })
    expect(r.outcome_brief).toBe(FALLBACK_TEXT)
    expect(r.process_highlights).toEqual([])
    expect(r.fellBackToLastText).toBe(true)
  })

  it('字段类型错（highlights 不是数组）→ 走 fallback', async () => {
    const adapter = makeAdapter([
      '```json\n{"outcome_brief":"x","process_highlights":"not an array"}\n```',
      '```json\n{"outcome_brief":"x","process_highlights":"still not array"}\n```',
    ])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
      maxRetries: 1,
    })
    expect(r.fellBackToLastText).toBe(true)
  })

  it('outcome_brief 超 200 字自动截断', async () => {
    const long = '甲'.repeat(500)
    const adapter = makeAdapter([
      `\`\`\`json\n{"outcome_brief":"${long}","process_highlights":[]}\n\`\`\``,
    ])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
    })
    expect(r.outcome_brief).toHaveLength(200)
  })

  it('highlights 超 3 条 / 单条超 80 字 自动截断', async () => {
    const longH = '亮'.repeat(120)
    const adapter = makeAdapter([
      `\`\`\`json\n{"outcome_brief":"x","process_highlights":["${longH}","a","b","c","d"]}\n\`\`\``,
    ])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
    })
    expect(r.process_highlights).toHaveLength(3)
    expect(r.process_highlights[0]).toHaveLength(80)
  })

  it('lastAssistantText 也截断到 200 字以内（fallback 时）', async () => {
    const adapter = makeAdapter(['bad', 'bad'])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: '长'.repeat(500),
      maxRetries: 1,
    })
    expect(r.outcome_brief).toHaveLength(200)
  })
})
