/**
 * EngineOptions.flushOutboundBuffer 钩子触发时机.
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 8
 *
 * Engine 在两个时机调 flushOutboundBuffer：
 *   1) stop_reason='tool_use' 续 turn 之前（agent 还在干活，上一轮缓冲的 info 是"过程信息"）
 *   2) endTurnGate 返回 null 之后、buildResult 之前（audit pass / 无 audit / 同步路径完成）
 *
 * 不传 flushOutboundBuffer 时 engine 跳过 flush 不抛错（向后兼容）。
 */

import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
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

const noopTool = {
  name: 'noop',
  description: 'noop',
  inputSchema: { type: 'object' as const, properties: {} },
  isReadOnly: true,
  call: async () => ({ output: 'ok', isError: false }),
}

describe('engine: flushOutboundBuffer hook', () => {
  it('flushes on stop_reason=tool_use continuation (between turn 1 and turn 2)', async () => {
    const flushFn = vi.fn(async () => { /* noop, just track invocation */ })

    // turn 1 = noop tool (tool_use) → 续 turn；turn 2 = end_turn
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'noop' },
      { kind: 'end_turn', text: '完毕' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [noopTool],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushFn,
      },
    })

    expect(result.outcome).toBe('completed')
    // turn 1 tool_use 续 turn 路径调用一次 flush；turn 2 end_turn（无 endTurnGate）再调一次
    expect(flushFn).toHaveBeenCalled()
    // 至少 2 次（tool_use 续 turn + end_turn 之后），具体 2 还是更多取决于实现细节
    expect(flushFn.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('flushes on stop_reason=end_turn after endTurnGate returns null (gate pass path)', async () => {
    const flushFn = vi.fn(async () => { /* noop */ })
    const gateFn = vi.fn(async () => null)  // gate pass

    // turn 1 = end_turn 直接退（无 tool_use）
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(gateFn).toHaveBeenCalledTimes(1)
    // gate 返回 null 后必须 flush 一次再 buildResult
    expect(flushFn).toHaveBeenCalled()
  })

  it('flushes on stop_reason=end_turn when no endTurnGate provided', async () => {
    const flushFn = vi.fn(async () => { /* noop */ })

    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        // 无 endTurnGate → 走 fallthrough flush 分支
        flushOutboundBuffer: flushFn,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(flushFn).toHaveBeenCalled()
  })

  it('does NOT flush when endTurnGate returns a string (gate intercepted, loop continues)', async () => {
    // gate 第一次返回 string 拦截，第二次返回 null 放行
    let gateCall = 0
    const gateFn = vi.fn(async () => {
      gateCall++
      return gateCall === 1 ? '再想想' : null
    })
    const flushFn = vi.fn(async () => { /* noop */ })

    // turn 1 = end_turn (gate 拦截，注入续 loop) → turn 2 = end_turn (gate 放行)
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕 1' },
      { kind: 'end_turn', text: '完毕 2' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        endTurnGate: gateFn,
        flushOutboundBuffer: flushFn,
      },
    })

    expect(result.outcome).toBe('completed')
    expect(gateFn).toHaveBeenCalledTimes(2)
    // gate 拦截路径不应 flush（loop 还在继续，缓冲属于"还没决定好的"内容）；
    // 只有 gate=null 放行那一次后才 flush。
    // 由于 turn 1 是 end_turn 没有 tool_use 续 turn 路径，flush 应只在 gate pass 后被调。
    expect(flushFn).toHaveBeenCalledTimes(1)
  })

  it('does NOT throw when flushOutboundBuffer not provided (backward compat)', async () => {
    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'noop' },
      { kind: 'end_turn', text: '完毕' },
    ])

    // options.flushOutboundBuffer === undefined：engine 应该跳过 flush 分支
    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [noopTool],
        systemPrompt: '',
        model: 'test-model',
        // 不传 flushOutboundBuffer
      },
    })

    expect(result.outcome).toBe('completed')
  })

  it('flush errors propagate from flush callback (caller responsibility to handle internally)', async () => {
    // engine 把 flush error 直接抛出来（caller 在 callback 内部已 try/catch；
    // 若意外抛出，engine 不吞——让上层看到）。
    const flushFn = vi.fn(async () => {
      throw new Error('flush exploded')
    })

    const adapter = makeAdapter([
      { kind: 'end_turn', text: '完毕' },
    ])

    await expect(
      runEngine({
        prompt: 'go',
        adapter,
        options: {
          tools: [],
          systemPrompt: '',
          model: 'test-model',
          flushOutboundBuffer: flushFn,
        },
      }),
    ).rejects.toThrow('flush exploded')
  })

  it('flush is called AFTER post-tool drain on tool_use turn (ordering check)', async () => {
    // 验证 flush 在 post-tool drain 之后调（spec: drain 已发的 supplement，再 flush 缓冲）
    const events: string[] = []
    const flushFn = vi.fn(async () => {
      events.push('flush')
    })

    // 工具自身把 'tool_done' push 到 events——模拟"post-tool 阶段"
    const trackingTool = {
      name: 'tracking',
      description: 'tracks order',
      inputSchema: { type: 'object' as const, properties: {} },
      isReadOnly: true,
      call: async () => {
        events.push('tool_call')
        return { output: 'ok', isError: false }
      },
    }

    const adapter = makeAdapter([
      { kind: 'tool', toolId: 'tu1', toolName: 'tracking' },
      { kind: 'end_turn', text: '完毕' },
    ])

    await runEngine({
      prompt: 'go',
      adapter,
      options: {
        tools: [trackingTool],
        systemPrompt: '',
        model: 'test-model',
        flushOutboundBuffer: flushFn,
      },
    })

    // 期望顺序：tool_call → flush (in turn 1) → flush (in turn 2 end_turn)
    expect(events[0]).toBe('tool_call')
    // tool_call 之后必有 flush（不必判定具体次数，只判定相对顺序）
    expect(events.indexOf('flush')).toBeGreaterThan(events.indexOf('tool_call'))
  })
})
