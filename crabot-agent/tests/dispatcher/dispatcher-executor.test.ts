import { describe, it, expect, vi } from 'vitest'
import { executeDispatchActions } from '../../src/dispatcher/dispatcher-executor.js'
import type { ExecuteContext, DispatchAction } from '../../src/dispatcher/dispatcher-types.js'

function makeExecCtx(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    dispatchCtx: {
      messages: [], recentMessages: [], activeTasks: [], sessionType: 'private',
      channelId: 'ch', sessionId: 'sess',
      senderFriend: {} as never, traceId: 'trace-1',
    },
    pushSupplement: vi.fn().mockResolvedValue('delivered'),
    spawnAgentInstance: vi.fn().mockResolvedValue({ spawnedTraceId: 'spawn-1' }),
    sendErrorToUser: vi.fn(),
    ...overrides,
  }
}

describe('executeDispatchActions', () => {
  it('单个 supplement 动作调 pushSupplement', async () => {
    const ctx = makeExecCtx()
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'task-A', text: '改成红米' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(ctx.pushSupplement).toHaveBeenCalledWith('task-A', '改成红米')
  })

  it('单个 new_task 动作调 spawnAgentInstance', async () => {
    const ctx = makeExecCtx()
    const actions: DispatchAction[] = [{ kind: 'new_task', text: '查 github' }]
    await executeDispatchActions(actions, ctx)
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('查 github')
  })

  it('stay_silent 动作不调任何回调', async () => {
    const ctx = makeExecCtx()
    const actions: DispatchAction[] = [{ kind: 'stay_silent', reason: 'irrelevant' }]
    await executeDispatchActions(actions, ctx)
    expect(ctx.pushSupplement).not.toHaveBeenCalled()
    expect(ctx.spawnAgentInstance).not.toHaveBeenCalled()
    expect(ctx.sendErrorToUser).not.toHaveBeenCalled()
  })

  it('多动作按顺序执行', async () => {
    const calls: string[] = []
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockImplementation(async () => { calls.push('supp'); return 'delivered' }),
      spawnAgentInstance: vi.fn().mockImplementation(async () => { calls.push('spawn'); return { spawnedTraceId: 's' } }),
    })
    const actions: DispatchAction[] = [
      { kind: 'new_task', text: 'A' },
      { kind: 'supplement', target_task_id: 'T', text: 'B' },
      { kind: 'new_task', text: 'C' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(calls).toEqual(['spawn', 'supp', 'spawn'])
  })

  it('某个动作失败不阻塞后续动作', async () => {
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockRejectedValue(new Error('boom')),
    })
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'T', text: 'x' },
      { kind: 'new_task', text: 'after-failure' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('after-failure')
  })

  it('supplement target not found 返回 fallback，不影响后续', async () => {
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockResolvedValue('fallback'),
    })
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'gone', text: 'x' },
      { kind: 'new_task', text: 'follow' },
    ]
    await executeDispatchActions(actions, ctx)
    // 现在 fallback 会触发降级 → spawnAgentInstance(action.text) + 后续 new_task 各 1 次
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('x')
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('follow')
    expect(ctx.spawnAgentInstance).toHaveBeenCalledTimes(2)
  })

  // ============================================================================
  // Regression: spec §3.6 — supplement_fallback 不再静默吃消息
  // 修复来源：trace db206eaf — LLM 编 task_id，pushSupplement 返回 fallback，
  // 旧实现仅 log warn 就丢消息；现改为自动降级 new_task 并写恢复 span。
  // ============================================================================

  it('supplement → fallback 时降级到 spawnAgentInstance，参数是 action.text', async () => {
    const spawn = vi.fn().mockResolvedValue({ spawnedTraceId: 'spawn-recovered' })
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockResolvedValue('fallback'),
      spawnAgentInstance: spawn,
    })
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'gone', text: '请帮我查 X' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('请帮我查 X')
  })

  it('supplement → delivered 时不调 spawnAgentInstance（不误降级）', async () => {
    const spawn = vi.fn().mockResolvedValue({ spawnedTraceId: 's' })
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockResolvedValue('delivered'),
      spawnAgentInstance: spawn,
    })
    const actions: DispatchAction[] = [
      { kind: 'supplement', target_task_id: 'task-A', text: '改成红米' },
    ]
    await executeDispatchActions(actions, ctx)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('supplement fallback 触发 span outcome=supplement_fallback_recovered 并带 spawned_trace_id', async () => {
    const endSpan = vi.fn()
    const trace = {
      startSpan: vi.fn().mockReturnValue({ span_id: 'sp-1' }),
      endSpan,
    }
    const ctx = makeExecCtx({
      pushSupplement: vi.fn().mockResolvedValue('fallback'),
      spawnAgentInstance: vi.fn().mockResolvedValue({ spawnedTraceId: 'trace-child-9' }),
      trace,
    })
    await executeDispatchActions(
      [{ kind: 'supplement', target_task_id: 'gone', text: 'x' }],
      ctx,
    )
    expect(endSpan).toHaveBeenCalledTimes(1)
    const [, status, details] = endSpan.mock.calls[0]
    expect(status).toBe('completed')
    expect(details).toMatchObject({
      outcome: 'supplement_fallback_recovered',
      recovered_via: 'new_task',
      spawned_trace_id: 'trace-child-9',
      attempted_target_task_id: 'gone',
    })
  })
})
