/**
 * set_task_goal 改 goal 成功后 abort 当前 audit + 丢 outboundBuffer.
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.7
 *
 * 两层验证：
 *   1. set_task_goal 工具行为：admin RPC 成功 → 调 deps.abortAudit('goal_revised')
 *      admin RPC 失败 → 不调（goal 没真改成，audit 不该 abort）
 *      首次设 goal（无既有 goal）→ 仍调（no-op，因 activeAuditId 为空）
 *   2. abortAudit helper 语义（在 agent-handler runWorkerLoop 闭包构造）：
 *      - no active audit → no-op
 *      - active audit → controller.abort + 清 outboundBuffer + 清 activeAuditId + push aborted marker
 *      - controller 缺失（已 finally 清掉） → fail-soft 不抛
 */

import { describe, it, expect, vi } from 'vitest'
import { createSetTaskGoalTool } from '../../src/agent/goal-tools.js'
import { buildAuditAbortedMarker, parseSystemMarker } from '../../src/agent/audit-result-marker.js'
import type { WorkerTaskState } from '../../src/types.js'
import type { OutboundBufferEntry } from '../../src/agent/outbound-flush.js'
import { TodoStore } from '../../src/agent/worker-todo-store.js'

function makeTaskState(overrides: Partial<WorkerTaskState> = {}): WorkerTaskState {
  return {
    taskId: 'task-1',
    status: 'executing',
    startedAt: new Date().toISOString(),
    abortController: { signal: { aborted: false }, abort: () => {} },
    pendingHumanMessages: [],
    todoStore: new TodoStore(),
    outboundBuffer: [],
    activeAuditId: undefined,
    activeAsyncSubagentIds: new Set<string>(),
    ...overrides,
  }
}

function makeBufferEntry(content: string): OutboundBufferEntry {
  return {
    channel_id: 'wechat:bot:1',
    session_id: 's-1',
    content,
    intent: 'info',
    sent_at_attempt_ms: Date.now(),
  }
}

/**
 * 仿照 agent-handler.ts runWorkerLoop 内部 abortAudit 闭包构造。
 * 测试这一构造模式不依赖 runWorkerLoop 整体 spin-up。
 */
function makeAbortAudit(
  taskState: WorkerTaskState,
  agentAbortControllers: Map<string, AbortController>,
  humanQueue: { push: (content: string) => void },
): (reason: string) => void {
  return (reason: string): void => {
    const id = taskState.activeAuditId
    if (!id) return
    const controller = agentAbortControllers.get(id)
    if (controller) {
      try { controller.abort() } catch (err) {
        console.warn('[abortAudit] controller.abort failed:', err instanceof Error ? err.message : String(err))
      }
    }
    taskState.outboundBuffer.length = 0
    taskState.activeAuditId = undefined
    try {
      humanQueue.push(buildAuditAbortedMarker({ auditId: id, reason }))
    } catch (err) {
      console.warn('[abortAudit] push marker failed:', err instanceof Error ? err.message : String(err))
    }
  }
}

describe('abortAudit helper', () => {
  it('no active audit → no-op（不调 controller、不 push marker）', () => {
    const taskState = makeTaskState({ activeAuditId: undefined })
    const controllers = new Map<string, AbortController>()
    const push = vi.fn()
    const abort = makeAbortAudit(taskState, controllers, { push })

    abort('goal_revised')

    expect(push).not.toHaveBeenCalled()
    expect(taskState.activeAuditId).toBeUndefined()
  })

  it('active audit → controller.abort + 清 state + push aborted marker', () => {
    const abortSpy = vi.fn()
    const controller = { abort: abortSpy, signal: { aborted: false } } as unknown as AbortController
    const controllers = new Map<string, AbortController>([['audit-xyz', controller]])
    const taskState = makeTaskState({ activeAuditId: 'audit-xyz' })
    taskState.outboundBuffer.push(makeBufferEntry('msg-1'), makeBufferEntry('msg-2'))
    const pushed: string[] = []
    const abort = makeAbortAudit(taskState, controllers, {
      push: (c) => { pushed.push(String(c)) },
    })

    abort('goal_revised')

    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(taskState.activeAuditId).toBeUndefined()
    expect(taskState.outboundBuffer.length).toBe(0)
    expect(pushed.length).toBe(1)
    const marker = parseSystemMarker(pushed[0])
    expect(marker?.type).toBe('audit_aborted')
    if (marker?.type === 'audit_aborted') {
      expect(marker.auditId).toBe('audit-xyz')
      expect(marker.reason).toBe('goal_revised')
    }
  })

  it('controller 缺失（已 finally 清掉）→ fail-soft 仍清 state + push marker', () => {
    const taskState = makeTaskState({ activeAuditId: 'audit-missing' })
    taskState.outboundBuffer.push(makeBufferEntry('lingering'))
    const controllers = new Map<string, AbortController>()  // 没注册
    const push = vi.fn()
    const abort = makeAbortAudit(taskState, controllers, { push })

    expect(() => abort('goal_revised')).not.toThrow()
    expect(taskState.activeAuditId).toBeUndefined()
    expect(taskState.outboundBuffer.length).toBe(0)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('idempotent：重复调 abortAudit 第二次 no-op', () => {
    const abortSpy = vi.fn()
    const controller = { abort: abortSpy, signal: { aborted: false } } as unknown as AbortController
    const controllers = new Map<string, AbortController>([['audit-a', controller]])
    const taskState = makeTaskState({ activeAuditId: 'audit-a' })
    const push = vi.fn()
    const abort = makeAbortAudit(taskState, controllers, { push })

    abort('goal_revised')
    abort('goal_revised')

    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('controller.abort 内抛错 → fail-soft，state 仍清 + marker 仍 push', () => {
    const controller = {
      abort: () => { throw new Error('boom') },
      signal: { aborted: false },
    } as unknown as AbortController
    const controllers = new Map<string, AbortController>([['audit-x', controller]])
    const taskState = makeTaskState({ activeAuditId: 'audit-x' })
    taskState.outboundBuffer.push(makeBufferEntry('m'))
    const push = vi.fn()
    const abort = makeAbortAudit(taskState, controllers, { push })

    expect(() => abort('goal_revised')).not.toThrow()
    expect(taskState.activeAuditId).toBeUndefined()
    expect(taskState.outboundBuffer.length).toBe(0)
    expect(push).toHaveBeenCalledTimes(1)
  })
})

describe('set_task_goal 触发 abortAudit', () => {
  it('admin RPC 成功 → 调 abortAudit("goal_revised")', async () => {
    const abortAudit = vi.fn()
    const rpcCall = vi.fn().mockResolvedValue({ task: {} })
    const tool = createSetTaskGoalTool({
      taskId: 't1',
      callAdminRpc: rpcCall,
      abortAudit,
    })

    const result = await tool.call!({
      objective: '首次设目标',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)

    expect(result.isError).toBeFalsy()
    expect(abortAudit).toHaveBeenCalledTimes(1)
    expect(abortAudit).toHaveBeenCalledWith('goal_revised')
  })

  it('admin RPC 失败 → 不调 abortAudit（goal 没真改成）', async () => {
    const abortAudit = vi.fn()
    const rpcCall = vi.fn().mockRejectedValue(new Error('admin 拒绝'))
    const tool = createSetTaskGoalTool({
      taskId: 't1',
      callAdminRpc: rpcCall,
      abortAudit,
    })

    const result = await tool.call!({
      objective: 'x',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)

    expect(result.isError).toBe(true)
    expect(abortAudit).not.toHaveBeenCalled()
  })

  it('重设（已有 goal + 持券）成功 → 消费券 + 调 abortAudit', async () => {
    const abortAudit = vi.fn()
    const consume = vi.fn()
    const rpcCall = vi.fn().mockResolvedValue({ task: {} })
    const tool = createSetTaskGoalTool({
      taskId: 't1',
      callAdminRpc: rpcCall,
      hasExistingGoal: () => true,
      hasRevisionToken: () => true,
      consumeRevisionToken: consume,
      abortAudit,
    })

    const result = await tool.call!({
      objective: '换方向',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)

    expect(result.isError).toBeFalsy()
    expect(consume).toHaveBeenCalledTimes(1)
    expect(abortAudit).toHaveBeenCalledWith('goal_revised')
  })

  it('重设无券 → 既不调 admin 也不调 abortAudit', async () => {
    const abortAudit = vi.fn()
    const rpcCall = vi.fn()
    const tool = createSetTaskGoalTool({
      taskId: 't1',
      callAdminRpc: rpcCall,
      hasExistingGoal: () => true,
      hasRevisionToken: () => false,
      consumeRevisionToken: vi.fn(),
      abortAudit,
    })

    const result = await tool.call!({
      objective: '想缩小目标',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)

    expect(result.isError).toBe(true)
    expect(rpcCall).not.toHaveBeenCalled()
    expect(abortAudit).not.toHaveBeenCalled()
  })

  it('abortAudit 抛错 → 工具不冒泡，仍返回成功（fail-soft）', async () => {
    const abortAudit = vi.fn(() => { throw new Error('marker push failed') })
    const rpcCall = vi.fn().mockResolvedValue({ task: {} })
    const tool = createSetTaskGoalTool({
      taskId: 't1',
      callAdminRpc: rpcCall,
      abortAudit,
    })

    const result = await tool.call!({
      objective: 'x',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)

    expect(result.isError).toBeFalsy()
    expect(abortAudit).toHaveBeenCalledTimes(1)
  })

  it('abortAudit deps 未注入 → 工具仍按原行为返回成功（向后兼容）', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ task: {} })
    const tool = createSetTaskGoalTool({
      taskId: 't1',
      callAdminRpc: rpcCall,
      // 没传 abortAudit
    })

    const result = await tool.call!({
      objective: 'x',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)

    expect(result.isError).toBeFalsy()
  })
})
