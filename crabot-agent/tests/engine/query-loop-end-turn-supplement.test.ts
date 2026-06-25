import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from './helpers/mock-stream.js'

function makeAdapter(responses: Array<{ text: string; stopReason: 'end_turn' | 'tool_use' }>): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const r = responses[i++] ?? responses[responses.length - 1]
      yield* chunksFromContent(
        [{ type: 'text' as const, text: r.text }],
        r.stopReason,
        { inputTokens: 100, outputTokens: 50 },
      )
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

describe('query-loop: end_turn 收口前再 check humanMessageQueue', () => {
  it('end_turn 前 humanMessageQueue 有 pending → 不结束，注入为 user message 续 loop', async () => {
    const queue = new HumanMessageQueue()
    queue.push('用户突然纠偏：先做 X')

    const adapter = makeAdapter([
      { text: '我准备结束了', stopReason: 'end_turn' },
      { text: '收到，改做 X', stopReason: 'end_turn' },
    ])

    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test',
      },
    })

    // 两次 LLM 调用：第一次 end_turn 但被 supplement 截胡，第二次才真正结束
    expect((adapter.stream as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('收到，改做 X')
    expect(queue.hasPending).toBe(false)
  })

  it('end_turn 时 humanMessageQueue 无 pending → 正常结束', async () => {
    const queue = new HumanMessageQueue()
    const adapter = makeAdapter([
      { text: '结束', stopReason: 'end_turn' },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test',
      },
    })
    expect((adapter.stream as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(result.finalText).toBe('结束')
  })
})
