/**
 * Post-tool drain 在 send_message 进缓冲场景跳过.
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.2
 *
 * 若本 turn 含 send_message 工具且 tool_result 含 `"buffered":true` 字符串：
 *   → 跳过 humanQueue.drainPending()（防 supplement 在 turn 边界打乱 info+end_turn 组合判定）
 *   → barrier wait 仍执行
 *
 * 被跳过的 supplement 留在 humanQueue 里，会在下一 turn end_turn 收口前自然 drain
 * （query-loop.ts line 221）。Task 8 之后端 audit 路径接住，由 audit 路径 drain。
 *
 * 本测试关注两个观察点：
 *   (1) 在 buffered send_message turn 之后、下一 turn LLM 调用之前，supplement 不被注入；
 *   (2) 非 buffered（普通 send_message / Bash 等）的 post-tool drain 行为不变。
 */

import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'

type AdapterStep =
  | { kind: 'tool'; toolId: string; toolName: string; input?: Record<string, unknown> }
  | { kind: 'end_turn'; text: string }

function makeAdapter(steps: ReadonlyArray<AdapterStep>): LLMAdapter {
  let i = 0
  return {
    complete: vi.fn(async () => {
      const s = steps[i++] ?? steps[steps.length - 1]
      if (s.kind === 'tool') {
        return {
          content: [
            {
              type: 'tool_use' as const,
              id: s.toolId,
              name: s.toolName,
              input: s.input ?? {},
            },
          ],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 20, outputTokens: 10 },
        }
      }
      return {
        content: [{ type: 'text' as const, text: s.text }],
        stopReason: 'end_turn' as const,
        usage: { inputTokens: 10, outputTokens: 5 },
      }
    }),
    stream: async function* () { /* unused */ },
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

describe('query-loop: post-tool drain skip when send_message buffered', () => {
  it('SKIPS drainPending after buffered send_message turn (supplement not drained between turns)', async () => {
    const queue = new HumanMessageQueue()
    queue.push('pending supplement')

    const sendMessageBuffered = {
      name: 'mcp__crab-messaging__send_message',
      description: 'send message (mock buffered)',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: false,
      call: async () => ({
        // Task 6 缓冲分支返回的 content；必须含 "buffered":true 子串
        output: JSON.stringify({ buffered: true, sent_at: null, intent: 'info' }),
        isError: false,
      }),
    }

    const followupTool = {
      name: 'noop',
      description: 'noop continuation',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    }

    // 注意：让 turn 1 也是 tool_use，避免落到 line 221 end_turn supplement drain。
    // 这样 supplement 是否被 drain 只由 post-tool drain 路径决定。
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'mcp__crab-messaging__send_message' },
      { kind: 'tool', toolId: 'tu2', toolName: 'noop' },
      { kind: 'end_turn', text: '完毕' },
    ])

    const injectionsAfterTurn: Array<{ turnNumber: number; type: string; text: string }> = []

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [sendMessageBuffered, followupTool],
        systemPrompt: '',
        model: 'test-model',
        onSystemInjection: (e) =>
          injectionsAfterTurn.push({ turnNumber: e.turnNumber, type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')

    // 关键断言：turn 1 (totalTurns=1，第一个 tool_use 完成后的 post-tool 阶段)
    // 不应该有 supplement 注入。如果代码没跳过 drain，这里会出现 turnNumber=1。
    const turn1Supplements = injectionsAfterTurn.filter(
      (e) => e.type === 'supplement' && e.turnNumber === 1
    )
    expect(turn1Supplements).toHaveLength(0)
  })

  it('DRAINS normally when send_message NOT buffered (output 不含 buffered:true)', async () => {
    const queue = new HumanMessageQueue()
    queue.push('pending supplement')

    const sendMessageNormal = {
      name: 'mcp__crab-messaging__send_message',
      description: 'send message (mock non-buffered)',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: false,
      call: async () => ({
        // 非缓冲：返回 platform_message_id / sent_at（无 "buffered":true）
        output: JSON.stringify({ platform_message_id: 'm1', sent_at: '2026-06-07T00:00:00Z' }),
        isError: false,
      }),
    }

    const followupTool = {
      name: 'noop',
      description: 'noop continuation',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: true,
      call: async () => ({ output: 'ok', isError: false }),
    }

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu2a', toolName: 'mcp__crab-messaging__send_message' },
      { kind: 'tool', toolId: 'tu2b', toolName: 'noop' },
      { kind: 'end_turn', text: '完毕' },
    ])

    const injectionsAfterTurn: Array<{ turnNumber: number; type: string; text: string }> = []

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [sendMessageNormal, followupTool],
        systemPrompt: '',
        model: 'test-model',
        onSystemInjection: (e) =>
          injectionsAfterTurn.push({ turnNumber: e.turnNumber, type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')

    // post-tool drain 正常工作：turn 1 post-tool 阶段 supplement 被注入
    const turn1Supplements = injectionsAfterTurn.filter(
      (e) => e.type === 'supplement' && e.turnNumber === 1
    )
    expect(turn1Supplements).toHaveLength(1)
    expect(turn1Supplements[0].text).toBe('pending supplement')

    expect(queue.hasPending).toBe(false)
  })

  it('DRAINS normally when no send_message in turn (Bash tool only)', async () => {
    const queue = new HumanMessageQueue()
    queue.push('pending supplement')

    const bashTool = {
      name: 'Bash',
      description: 'bash mock',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: false,
      call: async () => ({ output: 'ok', isError: false }),
    }

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu3', toolName: 'Bash' },
      { kind: 'end_turn', text: 'done' },
    ])

    const injectionsAfterTurn: Array<{ turnNumber: number; type: string; text: string }> = []

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [bashTool],
        systemPrompt: '',
        model: 'test-model',
        onSystemInjection: (e) =>
          injectionsAfterTurn.push({ turnNumber: e.turnNumber, type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')

    // 没有 send_message，drain 照常：turn 1 post-tool 阶段注入 supplement
    const turn1Supplements = injectionsAfterTurn.filter(
      (e) => e.type === 'supplement' && e.turnNumber === 1
    )
    expect(turn1Supplements).toHaveLength(1)
    expect(turn1Supplements[0].text).toBe('pending supplement')

    expect(queue.hasPending).toBe(false)
  })

  it('barrier wait 仍执行（buffered send_message 不跳过 barrier）', async () => {
    // 假设极端场景：工具内部既缓冲又设了 barrier（实际两者互斥，但需验证 barrier wait 不被跳）
    const queue = new HumanMessageQueue()

    const sendMessageBufferedSetsBarrier = {
      name: 'mcp__crab-messaging__send_message',
      description: 'send message (mock buffered + sets barrier)',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: false,
      call: async () => {
        queue.setBarrier(60 * 1000)
        return {
          output: JSON.stringify({ buffered: true, sent_at: null, intent: 'info' }),
          isError: false,
        }
      },
    }

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu4', toolName: 'mcp__crab-messaging__send_message' },
      { kind: 'end_turn', text: '完毕' },
    ])

    // 50ms 后 push 解除 barrier（push 会自动 clearBarrier）
    setTimeout(() => queue.push('用户回复：继续'), 50)

    const startMs = Date.now()
    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [sendMessageBufferedSetsBarrier],
        systemPrompt: '',
        model: 'test-model',
      },
    })
    const elapsed = Date.now() - startMs

    expect(result.outcome).toBe('completed')
    // 至少等 ~50ms（barrier wait 没被跳过）
    expect(elapsed).toBeGreaterThanOrEqual(40)
    // 远小于 barrier timeout（说明被 push 唤醒了，不是超时返回）
    expect(elapsed).toBeLessThan(60 * 1000)
  })
})
