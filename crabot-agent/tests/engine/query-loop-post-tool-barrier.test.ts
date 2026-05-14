import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'

function makeAdapter(responses: Array<{ text: string; stopReason: 'end_turn' | 'tool_use'; toolId?: string; toolName?: string }>): LLMAdapter {
  let i = 0
  return {
    complete: vi.fn(async () => {
      const r = responses[i++] ?? responses[responses.length - 1]
      if (r.stopReason === 'tool_use' && r.toolId && r.toolName) {
        return {
          content: [{ type: 'tool_use' as const, id: r.toolId, name: r.toolName, input: {} }],
          stopReason: r.stopReason,
          usage: { inputTokens: 20, outputTokens: 10 },
        }
      }
      return {
        content: [{ type: 'text' as const, text: r.text }],
        stopReason: r.stopReason,
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    }),
    stream: async function* () { /* unused */ },
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

describe('query-loop: post-tool barrier check', () => {
  it('waits for barrier after a tool sets it; resumes on push', async () => {
    const queue = new HumanMessageQueue()

    const askTool = {
      name: 'ask',
      description: 'ask human',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: false,
      call: async () => {
        // 设 60s barrier，但测试会在 50ms 后 push 解除
        queue.setBarrier(60 * 1000)
        return { content: 'asked', isError: false }
      },
    }

    const adapter = makeAdapter([
      { text: '', stopReason: 'tool_use', toolId: 'tu1', toolName: 'ask' },
      { text: '收到回复', stopReason: 'end_turn' },
    ])

    // 异步 50ms 后 push supplement，触发 clearBarrier
    setTimeout(() => queue.push('用户回复：继续'), 50)

    const startMs = Date.now()
    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [askTool],
        systemPrompt: '',
        model: 'test-model',
      },
    })
    const elapsed = Date.now() - startMs

    const callCount = (adapter.complete as ReturnType<typeof vi.fn>).mock.calls.length
    expect(callCount).toBe(2)  // 第二轮 LLM 在 barrier 释放后执行
    expect(result.outcome).toBe('completed')
    expect(elapsed).toBeGreaterThanOrEqual(40)     // 至少等了 ~50ms
    expect(elapsed).toBeLessThan(60 * 1000)        // 远 < barrier timeout
  })

  it('no barrier set by tool → proceeds normally without waiting', async () => {
    const queue = new HumanMessageQueue()

    const simpleTool = {
      name: 'simple',
      description: 'simple tool',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: true,
      call: async () => {
        // 不设 barrier
        return { content: 'done', isError: false }
      },
    }

    const adapter = makeAdapter([
      { text: '', stopReason: 'tool_use', toolId: 'tu2', toolName: 'simple' },
      { text: '完成', stopReason: 'end_turn' },
    ])

    const startMs = Date.now()
    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [simpleTool],
        systemPrompt: '',
        model: 'test-model',
      },
    })
    const elapsed = Date.now() - startMs

    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('完成')
    // 没有 barrier，不应等待太久
    expect(elapsed).toBeLessThan(500)
  })
})
