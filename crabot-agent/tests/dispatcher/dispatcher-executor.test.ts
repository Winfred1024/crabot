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
    expect(ctx.spawnAgentInstance).toHaveBeenCalledWith('follow')
  })
})
