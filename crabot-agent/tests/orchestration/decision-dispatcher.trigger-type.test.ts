import { describe, it, expect, vi } from 'vitest'
import { DecisionDispatcher } from '../../src/orchestration/decision-dispatcher.js'

/**
 * Regression: agent 调用 admin.create_task RPC 时必须在 source 里带上 trigger_type。
 *
 * 历史 bug：handleCreateTask 漏传该字段 → admin 把 task 存为 source.trigger_type=undefined →
 * 下游 prompt 标签判断（front-handler.ts: task.trigger_type === 'scheduled'）和 engine
 * 兜底（unified-agent.handleLocalSupplement / dispatcher.handleSupplementTask 的 scheduled
 * 转 create_task）全部失效。表现：LLM 把用户新需求 supplement 到巡检任务，覆盖巡检本职，
 * 用户期望的新 task 也没起来。
 *
 * 本文件专门钉住 dispatcher 这条路径写入 trigger_type='manual'；
 * scheduled 路径在 unified-agent.ts handleCreateTaskFromSchedule，由该模块测试覆盖。
 */
const ADMIN_PORT = 19001
const CHANNEL_PORT = 19010

function makeDispatcher() {
  const rpcCalls: Array<{ port: number; method: string; params: any }> = []
  const rpcClient = {
    call: vi.fn(async (port: number, method: string, params: any) => {
      rpcCalls.push({ port, method, params })
      if (method === 'create_task') {
        return { task: { id: 't_new', title: params.title, description: params.description, priority: 'medium' } }
      }
      return {}
    }),
  } as any

  const dispatcher = new DecisionDispatcher(
    rpcClient,
    'agent-test',
    { assembleWorkerContext: vi.fn(async () => ({})) } as any,
    {
      reportTaskFeedback: vi.fn(async () => undefined),
      listRecentLessons: vi.fn(async () => []),
      markValidationOutcome: vi.fn(async () => undefined),
      writeTaskCreated: vi.fn(async () => undefined),
      writeTaskFinished: vi.fn(async () => undefined),
      writeTriageDecision: vi.fn(async () => undefined),
      quickCapture: vi.fn(async () => undefined),
    } as any,
    async () => ADMIN_PORT,
    async () => CHANNEL_PORT,
    vi.fn(async () => ({ task_id: 't_new', outcome: 'completed' as const, summary: '', final_reply: { type: 'text' as const, text: '' } })),
  )
  dispatcher.setWorkerHandler({
    executeTask: vi.fn(),
    hasActiveTask: vi.fn(() => true),
    deliverHumanResponse: vi.fn(),
  } as any)
  return { dispatcher, rpcCalls }
}

function findCreateTaskCall(calls: Array<{ method: string; params: any }>) {
  return calls.find(c => c.method === 'create_task')
}

describe('DecisionDispatcher.handleCreateTask 写入 source.trigger_type', () => {
  it('human 来源（用户消息）→ trigger_type=manual', async () => {
    const { dispatcher, rpcCalls } = makeDispatcher()
    await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: 't',
        task_description: 'd',
        immediate_reply: { type: 'text', text: '收到' },
      },
      {
        channel_id: 'telegram-001',
        session_id: 'sess-x',
        messages: [{
          platform_message_id: 'm1',
          session: { channel_id: 'telegram-001', session_id: 'sess-x', type: 'private' as const },
          sender: { friend_id: 'f_wu', platform_user_id: 'u1', platform_display_name: 'Mr.Wu' },
          content: { type: 'text' as const, text: 'go' },
          features: { is_mention_crab: false },
          platform_timestamp: new Date().toISOString(),
        }],
        senderFriend: { id: 'f_wu', display_name: 'Mr.Wu' } as any,
        memoryPermissions: { write_visibility: 'internal', write_scopes: [] } as any,
      },
    )

    const call = findCreateTaskCall(rpcCalls)
    expect(call).toBeDefined()
    expect(call!.params.source.origin).toBe('human')
    expect(call!.params.source.trigger_type).toBe('manual')
  })

  it('admin_chat 来源 → trigger_type=manual', async () => {
    const { dispatcher, rpcCalls } = makeDispatcher()
    await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: 't',
        task_description: 'd',
        immediate_reply: { type: 'text', text: '' },
      },
      {
        channel_id: 'admin-chat',
        session_id: 'admin-sess',
        messages: [{
          platform_message_id: 'm1',
          session: { channel_id: 'admin-chat', session_id: 'admin-sess', type: 'private' as const },
          sender: { friend_id: 'admin', platform_user_id: 'admin', platform_display_name: 'Admin' },
          content: { type: 'text' as const, text: 'go' },
          features: { is_mention_crab: false },
          platform_timestamp: new Date().toISOString(),
        }],
        senderFriend: { id: 'admin', display_name: 'Admin' } as any,
        memoryPermissions: { write_visibility: 'internal', write_scopes: [] } as any,
        admin_chat_callback: { source_module_id: 'crabot-admin', request_id: 'req-1' },
      },
    )

    const call = findCreateTaskCall(rpcCalls)
    expect(call).toBeDefined()
    expect(call!.params.source.origin).toBe('admin_chat')
    expect(call!.params.source.trigger_type).toBe('manual')
  })
})
