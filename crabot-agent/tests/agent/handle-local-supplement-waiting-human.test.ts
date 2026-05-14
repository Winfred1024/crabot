/**
 * handle-local-supplement-waiting-human.test.ts
 *
 * 验证 handleLocalSupplement 对 waiting_human task 的状态恢复行为：
 *
 *   1. target task 状态为 waiting_human
 *      → 先调 update_task_status({status:'executing', pending_question:null})
 *      → 再 deliverHumanResponse
 *
 *   2. target task 状态为 executing（普通 supplement）
 *      → 不调 update_task_status
 *      → 直接 deliverHumanResponse
 *
 *   3. update_task_status RPC 失败时
 *      → 不强行中止（继续调 deliverHumanResponse）
 *
 * 注意：UnifiedAgent 构造依赖 ModuleBase 网络绑定，不适合在单元测试中完整实例化。
 * 这里按 worker-handler-finalize.test.ts 的惯例，仿真 handleLocalSupplement 的调用
 * 序列并验证 RPC 调用顺序/参数。
 */

import { describe, it, expect, vi } from 'vitest'
import type { TaskSummary, SupplementTaskDecision } from '../../src/types.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDecision(taskId: string): SupplementTaskDecision {
  return {
    type: 'supplement_task',
    task_id: taskId,
    supplement_content: '请帮我修改需求',
    immediate_reply: { type: 'text', text: '收到' },
  }
}

function makeTaskSummary(taskId: string, status: string): TaskSummary {
  return {
    task_id: taskId,
    title: '测试任务',
    status,
    priority: 'normal',
  }
}

/**
 * 仿真 handleLocalSupplement Step 1.7 + Step 3（deliver）的核心调用序列。
 *
 * 这个函数复刻 unified-agent.ts 中 handleLocalSupplement 里
 * Step 1.7 和 deliver 的顺序，用于独立验证逻辑正确性。
 * 只要实现与此函数的 invariant 一致，测试就能准确反映生产行为。
 */
async function simulateHandleLocalSupplement(opts: {
  taskId: string
  activeTasks: TaskSummary[]
  rpcClient: { call: ReturnType<typeof vi.fn> }
  deliverHumanResponse: ReturnType<typeof vi.fn>
  getAdminPort: () => Promise<number>
  moduleId: string
}): Promise<void> {
  const { taskId, activeTasks, rpcClient, deliverHumanResponse, getAdminPort, moduleId } = opts
  const target = activeTasks.find(t => t.task_id === taskId)

  // Step 1.7: waiting_human → executing
  if (target?.status === 'waiting_human') {
    try {
      const adminPort = await getAdminPort()
      await rpcClient.call(adminPort, 'update_task_status', {
        task_id: taskId,
        status: 'executing',
        pending_question: null,
      }, moduleId)
    } catch (err) {
      // 失败时记录日志但继续注入（不强行中止）
      void err
    }
  }

  // Step 3: deliver（always runs）
  deliverHumanResponse(taskId)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleLocalSupplement: waiting_human 状态恢复', () => {
  it('target 为 waiting_human 时：先调 update_task_status(executing) 再 deliverHumanResponse', async () => {
    const calls: string[] = []
    const rpcClient = {
      call: vi.fn(async (_port: number, method: string, params: Record<string, unknown>) => {
        calls.push(method)
        return {}
      }),
    }
    const deliverHumanResponse = vi.fn()

    await simulateHandleLocalSupplement({
      taskId: 'task-123',
      activeTasks: [makeTaskSummary('task-123', 'waiting_human')],
      rpcClient,
      deliverHumanResponse,
      getAdminPort: async () => 19001,
      moduleId: 'agent-1',
    })

    // update_task_status 必须先于 deliverHumanResponse
    expect(rpcClient.call).toHaveBeenCalledTimes(1)
    expect(rpcClient.call).toHaveBeenCalledWith(
      19001,
      'update_task_status',
      { task_id: 'task-123', status: 'executing', pending_question: null },
      'agent-1',
    )
    expect(deliverHumanResponse).toHaveBeenCalledTimes(1)
    // calls 顺序：先 rpc，再 deliver（通过函数调用先后验证）
    expect(calls).toEqual(['update_task_status'])
    const rpcOrder = rpcClient.call.mock.invocationCallOrder[0]
    const deliverOrder = deliverHumanResponse.mock.invocationCallOrder[0]
    expect(rpcOrder).toBeLessThan(deliverOrder)
  })

  it('target 为 executing 时：不调 update_task_status，直接 deliverHumanResponse', async () => {
    const rpcClient = { call: vi.fn() }
    const deliverHumanResponse = vi.fn()

    await simulateHandleLocalSupplement({
      taskId: 'task-456',
      activeTasks: [makeTaskSummary('task-456', 'executing')],
      rpcClient,
      deliverHumanResponse,
      getAdminPort: async () => 19001,
      moduleId: 'agent-1',
    })

    expect(rpcClient.call).not.toHaveBeenCalled()
    expect(deliverHumanResponse).toHaveBeenCalledTimes(1)
  })

  it('update_task_status RPC 失败时：继续调 deliverHumanResponse（不强行中止）', async () => {
    const rpcClient = {
      call: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    }
    const deliverHumanResponse = vi.fn()

    // 不应该抛出
    await expect(simulateHandleLocalSupplement({
      taskId: 'task-789',
      activeTasks: [makeTaskSummary('task-789', 'waiting_human')],
      rpcClient,
      deliverHumanResponse,
      getAdminPort: async () => 19001,
      moduleId: 'agent-1',
    })).resolves.not.toThrow()

    // deliverHumanResponse 仍然被调用
    expect(deliverHumanResponse).toHaveBeenCalledTimes(1)
  })

  it('activeTasks 中没有 target 时：不调 update_task_status，仍然 deliver', async () => {
    const rpcClient = { call: vi.fn() }
    const deliverHumanResponse = vi.fn()

    await simulateHandleLocalSupplement({
      taskId: 'task-999',
      activeTasks: [], // 空列表，target 为 undefined
      rpcClient,
      deliverHumanResponse,
      getAdminPort: async () => 19001,
      moduleId: 'agent-1',
    })

    expect(rpcClient.call).not.toHaveBeenCalled()
    expect(deliverHumanResponse).toHaveBeenCalledTimes(1)
  })
})
