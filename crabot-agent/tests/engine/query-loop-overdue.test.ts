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

describe('query-loop overdue: 守卫与跳过', () => {
  it('未提供 overdueConfig → 引擎从不调 onOverdue，overdueInjected=false', async () => {
    const adapter = makeAdapter([{ text: '结束', stopReason: 'end_turn' }])

    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test',
        // 故意不传 overdueConfig
      },
    })

    expect(result.overdueInjected).toBe(false)
    expect(result.outcome).toBe('completed')
  })

  it('elapsed 未超 timeout → 不调 onOverdue', async () => {
    const adapter = makeAdapter([{ text: '快速结束', stopReason: 'end_turn' }])
    const onOverdue = vi.fn(() => '不应该被调')

    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test',
        overdueConfig: {
          timeoutMs: 60_000,  // 60s 阈值，单次 LLM mock 调用不可能超
          onOverdue,
        },
      },
    })

    expect(onOverdue).not.toHaveBeenCalled()
    expect(result.overdueInjected).toBe(false)
  })

  it('onOverdue 返回 null → 不注入但仍标记 overdueInjected=true（机会用掉）', async () => {
    const adapter = makeAdapter([
      { text: '我已经在处理', stopReason: 'end_turn' },
    ])
    const onOverdue = vi.fn(() => null)  // caller 判断已 send_message 过

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

    // onOverdue 被调一次（询问），返回 null → 不注入 → engine 直接 end_turn
    expect(onOverdue).toHaveBeenCalledTimes(1)
    expect((adapter.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(result.outcome).toBe('completed')
    expect(result.overdueInjected).toBe(true)
  })

  it('至多一次：第二次超期仍不会再调 onOverdue', async () => {
    const adapter = makeAdapter([
      { text: '准备结束', stopReason: 'end_turn' },              // turn 1：触发注入
      { text: '收到，已 send_message', stopReason: 'end_turn' },   // turn 2：仍超期但不该触发
    ])
    const onOverdue = vi.fn(() => '请先告知人类正在处理')

    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test',
        overdueConfig: {
          timeoutMs: 1000,
          startedAtMs: Date.now() - 5000,  // 远超阈值
          onOverdue,
        },
      },
    })

    expect(onOverdue).toHaveBeenCalledTimes(1)  // 关键断言：只调一次
    expect((adapter.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    expect(result.overdueInjected).toBe(true)
    expect(result.finalText).toBe('收到，已 send_message')
  })
})
