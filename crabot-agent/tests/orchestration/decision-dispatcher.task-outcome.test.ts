import { describe, it, expect, vi } from 'vitest'
import { DecisionDispatcher } from '../../src/orchestration/decision-dispatcher.js'

/**
 * Task 10 后的新架构验证：
 *
 * 成功路径由 worker-handler 内部完成：
 *   - update_task_status / update_task_outcome → worker-handler.finalizeTask
 *   - send_message（用户回复）→ worker 主动调 send_message tool
 *   - writeTaskFinished / quickCapture → worker-handler.finalizeMemoryWrite
 *   dispatcher 不再重复这些操作。
 *
 * 崩溃兜底路径（worker-handler 自身 throw）：
 *   - dispatcher 仍调 update_task_status(failed) + sendReplyToUser + finalizeTaskMemory
 */

const ADMIN_PORT = 19001
const CHANNEL_PORT = 19010

function makeDispatcher(opts: {
  /** undefined = 成功（不 throw）；string = worker throw 该 message */
  workerError?: string
}) {
  const memoryWriter = {
    reportTaskFeedback: vi.fn(async () => undefined),
    listRecentLessons: vi.fn(async () => []),
    markValidationOutcome: vi.fn(async () => undefined),
    writeTaskCreated: vi.fn(async () => undefined),
    writeTaskFinished: vi.fn(async () => undefined),
    writeTriageDecision: vi.fn(async () => undefined),
    quickCapture: vi.fn(async () => undefined),
  } as any

  const rpcCalls: Array<{ port: number; method: string; params: any }> = []
  const rpcClient = {
    call: vi.fn(async (port: number, method: string, params: any) => {
      rpcCalls.push({ port, method, params })
      if (method === 'create_task') {
        return { task: { id: 't_smoke_001', title: params.title, description: params.description, priority: 'medium' } }
      }
      return {}
    }),
  } as any

  const contextAssembler = {
    assembleWorkerContext: vi.fn(async () => ({})),
  } as any

  const executeTaskFn = vi.fn(async () => {
    if (opts.workerError) {
      throw new Error(opts.workerError)
    }
    // 成功：返回简化结构（Task 10 后 ExecuteTaskResult 无 summary / final_reply）
    return {
      task_id: 't_smoke_001',
      outcome: 'completed' as const,
    }
  })

  const dispatcher = new DecisionDispatcher(
    rpcClient,
    'agent-test',
    contextAssembler,
    memoryWriter,
    async () => ADMIN_PORT,
    async (_channelId: string) => CHANNEL_PORT,
    executeTaskFn,
  )

  dispatcher.setWorkerHandler({
    executeTask: vi.fn(),
    hasActiveTask: vi.fn(() => true),
    deliverHumanResponse: vi.fn(),
  } as any)

  return { dispatcher, rpcClient, rpcCalls, memoryWriter, executeTaskFn }
}

const BASE_PARAMS = {
  channel_id: 'telegram-001',
  session_id: 'sess-x',
  messages: [{
    platform_message_id: 'm1',
    session: { channel_id: 'telegram-001', session_id: 'sess-x', type: 'group' as const },
    sender: { friend_id: 'f_wu', platform_user_id: 'u1', platform_display_name: 'Mr.Wu' },
    content: { type: 'text' as const, text: 'go' },
    features: { is_mention_crab: true },
    platform_timestamp: new Date().toISOString(),
  }],
  senderFriend: { id: 'f_wu', display_name: 'Mr.Wu' } as any,
  memoryPermissions: { write_visibility: 'internal', write_scopes: [] } as any,
}

describe('DecisionDispatcher - Task 10 重构后行为', () => {
  it('成功路径：dispatcher 不再调 update_task_status(completed)，不发 send_message 给用户', async () => {
    const { dispatcher, rpcCalls } = makeDispatcher({})

    await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: '修复 /fav 500',
        task_description: '修复',
        immediate_reply: { type: 'text', text: '收到' },
      },
      BASE_PARAMS,
    )

    await new Promise(r => setTimeout(r, 30))

    // planning/executing 状态推进还在（不在成功路径删除范围内）
    const statusCalls = rpcCalls.filter(c => c.method === 'update_task_status')
    const planningCall = statusCalls.find(c => c.params?.status === 'planning')
    const executingCall = statusCalls.find(c => c.params?.status === 'executing')
    expect(planningCall).toBeDefined()
    expect(executingCall).toBeDefined()

    // dispatcher 不再调 completed 状态更新（worker-handler 负责）
    const completedCall = statusCalls.find(c => c.params?.status === 'completed')
    expect(completedCall).toBeUndefined()

    // dispatcher 不再主动发 task 完成回复（worker 主动调 send_message tool 发回复）；
    // 只有 immediate_reply ack（一发）
    const sendMessageCalls = rpcCalls.filter(
      c => c.method === 'send_message' && c.port === CHANNEL_PORT,
    )
    // 只有 immediate_reply ack，没有 task 完成回复（task 完成回复由 worker 发）
    expect(sendMessageCalls.length).toBe(1) // 只有 ack
    expect(sendMessageCalls[0].params.content.text).toBe('收到') // 只是 ack
  })

  it('成功路径：dispatcher 不再调 writeTaskFinished（worker-handler 负责）', async () => {
    const { dispatcher, memoryWriter } = makeDispatcher({})

    await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: '修复任务',
        task_description: '修',
        immediate_reply: { type: 'text', text: '好的' },
      },
      BASE_PARAMS,
    )

    await new Promise(r => setTimeout(r, 30))

    expect(memoryWriter.writeTaskFinished).not.toHaveBeenCalled()
  })

  it('崩溃兜底路径：worker throw 时 dispatcher 调 update_task_status(failed) + sendReplyToUser + writeTaskFinished', async () => {
    const { dispatcher, rpcCalls, memoryWriter } = makeDispatcher({
      workerError: 'worker 内部崩溃',
    })

    await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: '修复任务',
        task_description: '修',
        immediate_reply: { type: 'text', text: '好的' },
      },
      BASE_PARAMS,
    )

    await new Promise(r => setTimeout(r, 30))

    // 失败状态更新
    const failedCall = rpcCalls.find(
      c => c.method === 'update_task_status' && c.params?.status === 'failed',
    )
    expect(failedCall).toBeDefined()

    // 兜底回复
    const sendMessageCalls = rpcCalls.filter(
      c => c.method === 'send_message' && c.port === CHANNEL_PORT,
    )
    expect(sendMessageCalls.length).toBeGreaterThanOrEqual(1)
    const replyCall = sendMessageCalls[sendMessageCalls.length - 1]
    expect(replyCall.params.content.text).toContain('失败')

    // 失败记忆写入
    expect(memoryWriter.writeTaskFinished).toHaveBeenCalledTimes(1)
    const memArgs = memoryWriter.writeTaskFinished.mock.calls[0][0]
    expect(memArgs.outcome).toBe('failed')
    expect(memArgs.outcome_brief).toContain('worker 内部崩溃')
  })
})
