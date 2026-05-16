import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'

function makeAdapter(responses: Array<{ text: string; stopReason: 'end_turn' | 'tool_use' }>): LLMAdapter {
  let i = 0
  return {
    complete: vi.fn(async () => {
      const r = responses[i++] ?? responses[responses.length - 1]
      return {
        content: [{ type: 'text' as const, text: r.text }],
        stopReason: r.stopReason,
        usage: { inputTokens: 100, outputTokens: 50 },
      }
    }),
    stream: async function* () { /* unused */ },
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

describe('query-loop overdue: end_turn 路径注入', () => {
  it('elapsed 超过 timeout + 未注入过 → onOverdue 返回文本 → 注入 user message 续 loop', async () => {
    const adapter = makeAdapter([
      { text: '准备结束', stopReason: 'end_turn' },
      { text: '收到提醒，已发送状态告知', stopReason: 'end_turn' },
    ])

    // startedAtMs 设为 2 秒前，timeoutMs 1 秒 → 第一个 end_turn 时已经超期
    const onOverdue = vi.fn(() => '请先 send_message 告知用户正在处理')

    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test',
        overdueConfig: {
          timeoutMs: 1000,
          startedAtMs: Date.now() - 2000,
          onOverdue,
        },
      },
    })

    // 两次 LLM 调用：第一次 end_turn 被超期提醒截胡，第二次才真正结束
    expect((adapter.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    expect(onOverdue).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('收到提醒，已发送状态告知')
    expect(result.overdueInjected).toBe(true)
  })
})
