/**
 * Task 13: audit 跑中 LLM 直接 end_turn 兜底拦截测试.
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.6
 *
 * 异常路径：
 *   - agent 看到 [audit_pending] 不调 wait_for_signal，直接 end_turn
 *   - engine 检测 hasActiveAudit=true + stop_reason 非 tool_use → 注入提示拦截续 loop
 *   - 最多 3 次后放弃：abort active audit + 让 end_turn 通过
 */

import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import { buildAuditResultMarker } from '../../src/agent/audit-result-marker.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from './helpers/mock-stream.js'

type AdapterStep =
  | { kind: 'tool'; toolId: string; toolName: string; input?: Record<string, unknown> }
  | { kind: 'end_turn'; text: string }

function makeAdapter(steps: ReadonlyArray<AdapterStep>): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const s = steps[i++] ?? steps[steps.length - 1]
      if (s.kind === 'tool') {
        yield* chunksFromContent(
          [{ type: 'tool_use' as const, id: s.toolId, name: s.toolName, input: s.input ?? {} }],
          'tool_use',
          { inputTokens: 20, outputTokens: 10 },
        )
        return
      }
      yield* chunksFromContent(
        [{ type: 'text' as const, text: s.text }],
        'end_turn',
        { inputTokens: 10, outputTokens: 5 },
      )
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

describe('query-loop: audit pending end_turn fallback intercept (Task 13)', () => {
  it('拦截前 3 次注入 forced prompt，第 4 次 abort + 放行 end_turn', async () => {
    const abortSpy = vi.fn()
    const injections: Array<{ type: string; text: string; turnNumber: number }> = []
    // 模拟：abort 被调用之后 hasActiveAudit 转为 false，让 fall-through 端走正常 end_turn
    let auditActive = true
    const hasActiveAudit = vi.fn(() => auditActive)
    const abortActiveAudit = (reason: string): void => {
      abortSpy(reason)
      auditActive = false
    }

    // LLM 反复 end_turn 不调 wait_for_signal
    // turn 1: end_turn → intercept #1
    // turn 2: end_turn → intercept #2
    // turn 3: end_turn → intercept #3
    // turn 4: end_turn → 兜底耗尽 → abort + 放行
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '搞定' },
      { kind: 'end_turn', text: '搞定' },
      { kind: 'end_turn', text: '搞定' },
      { kind: 'end_turn', text: '搞定' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: new HumanMessageQueue(),
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit,
        abortActiveAudit,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text, turnNumber: e.turnNumber }),
      },
    })

    expect(result.outcome).toBe('completed')

    // 拦截注入：恰好 3 次 audit_pending_intercept
    const intercepts = injections.filter((e) => e.type === 'audit_pending_intercept')
    expect(intercepts).toHaveLength(3)
    for (const intercept of intercepts) {
      expect(intercept.text).toContain('你不能直接 end_turn')
      expect(intercept.text).toContain('audit 仍在跑')
    }

    // abort 在第 4 次（兜底耗尽）调一次
    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(abortSpy).toHaveBeenCalledWith('end_turn_retries_exhausted')

    // 总轮数：3 次拦截续 turn + 1 次放行 = 至少 4 轮
    expect(result.totalTurns).toBeGreaterThanOrEqual(4)
  })

  it('hasActiveAudit=false 时不拦截，正常 end_turn', async () => {
    const abortSpy = vi.fn()
    const injections: Array<{ type: string; text: string }> = []

    const adapter = makeAdapter([
      { kind: 'end_turn', text: '搞定' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: new HumanMessageQueue(),
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit: () => false,
        abortActiveAudit: abortSpy,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    // 没有拦截
    expect(injections.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(0)
    expect(abortSpy).not.toHaveBeenCalled()
    expect(result.totalTurns).toBe(1)
  })

  it('drain 期间 audit_result(pass) 到达 → hasActiveAudit 转 false → 不拦截', async () => {
    // 模拟 audit 在跑 → drain 拿到 pass result → clearActiveAuditId 让 hasActiveAudit=false
    // engine 后续不拦截，走正常 end_turn 路径（buildResult completed）
    const queue = new HumanMessageQueue()
    const abortSpy = vi.fn()
    const flushSpy = vi.fn(async () => {})
    const dropSpy = vi.fn()
    const injections: Array<{ type: string; text: string }> = []

    let auditActive = true
    // clearActiveAuditId 在 drain 路径里被调，模拟 audit 结束
    const clearActiveAuditId = vi.fn(() => {
      auditActive = false
    })
    const hasActiveAudit = vi.fn(() => auditActive)

    // queue 预先 push 一条 pass marker —— end_turn drain 路径会拿到
    queue.push(
      buildAuditResultMarker({
        auditId: 'audit-mid-1',
        pass: true,
        failedCriteria: [],
        detailedReport: '',
      }),
    )

    const adapter = makeAdapter([
      { kind: 'end_turn', text: '搞定' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit,
        abortActiveAudit: abortSpy,
        flushOutboundBuffer: flushSpy,
        dropOutboundBuffer: dropSpy,
        clearActiveAuditId,
        onSystemInjection: (e) =>
          injections.push({ type: e.type, text: e.text }),
      },
    })

    expect(result.outcome).toBe('completed')
    // drain 调了 clearActiveAuditId（pass 路径）→ 之后 hasActiveAudit=false → 不拦截
    expect(clearActiveAuditId).toHaveBeenCalled()
    expect(flushSpy).toHaveBeenCalled()
    expect(abortSpy).not.toHaveBeenCalled()
    expect(injections.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(0)
  })

  it('counter 是 per-run 的，独立于其他 engine run', async () => {
    // 跑两次独立的 engine —— 第二次的 counter 应该从 0 开始，能拦截 3 次
    let auditActive1 = true
    let auditActive2 = true
    const injections1: Array<{ type: string }> = []
    const injections2: Array<{ type: string }> = []

    const makeOptions = (
      hasAudit: () => boolean,
      abortFn: (reason: string) => void,
      injTarget: Array<{ type: string }>,
    ) => ({
      humanMessageQueue: new HumanMessageQueue(),
      tools: [],
      systemPrompt: '',
      model: 'test-model',
      hasActiveAudit: hasAudit,
      abortActiveAudit: abortFn,
      onSystemInjection: (e: { type: string }) => injTarget.push({ type: e.type }),
    })

    // Run 1: 4 个 end_turn，预期 3 次拦截 + abort
    const adapter1 = makeAdapter([
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
    ])
    const abortSpy1 = vi.fn((_reason: string) => { auditActive1 = false })
    await runEngine({
      prompt: 'p1',
      adapter: adapter1,
      options: makeOptions(() => auditActive1, abortSpy1, injections1),
    })
    expect(injections1.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(3)
    expect(abortSpy1).toHaveBeenCalledTimes(1)

    // Run 2: 同样 4 个 end_turn，counter 应该重置 → 同样 3 次拦截 + abort
    const adapter2 = makeAdapter([
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
    ])
    const abortSpy2 = vi.fn((_reason: string) => { auditActive2 = false })
    await runEngine({
      prompt: 'p2',
      adapter: adapter2,
      options: makeOptions(() => auditActive2, abortSpy2, injections2),
    })
    expect(injections2.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(3)
    expect(abortSpy2).toHaveBeenCalledTimes(1)
  })

  it('callbacks not provided → 不抛错（backward compat）', async () => {
    // hasActiveAudit / abortActiveAudit 都不传时，正常 end_turn 不受影响
    const adapter = makeAdapter([
      { kind: 'end_turn', text: '搞定' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: new HumanMessageQueue(),
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        // hasActiveAudit / abortActiveAudit 都不传
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(1)
  })

  it('abortActiveAudit 缺失 → 兜底耗尽仍 fall-through 放行', async () => {
    // hasActiveAudit 一直 true，没有 abortActiveAudit—— 3 次拦截后 fall-through
    // 不能死循环（因为 hasActiveAudit 一直 true），但 retries 用尽就放行
    const injections: Array<{ type: string }> = []
    const adapter = makeAdapter([
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
      { kind: 'end_turn', text: 'go' },
    ])

    const result = await runEngine({
      prompt: 'go',
      adapter,
      options: {
        humanMessageQueue: new HumanMessageQueue(),
        tools: [],
        systemPrompt: '',
        model: 'test-model',
        hasActiveAudit: () => true,
        // abortActiveAudit 不传——engine 跳过 abort 直接 fall-through
        onSystemInjection: (e) => injections.push({ type: e.type }),
      },
    })

    expect(result.outcome).toBe('completed')
    expect(injections.filter((e) => e.type === 'audit_pending_intercept')).toHaveLength(3)
    // retries 耗尽就 fall-through，不死循环
    expect(result.totalTurns).toBeGreaterThanOrEqual(4)
  })
})
