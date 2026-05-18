import { describe, it, expect, vi } from 'vitest'
import { buildMessagingTools } from '../../src/mcp/crab-messaging.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

function findTool(tools: ReturnType<typeof buildMessagingTools>, name: string) {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

describe('send_message intent=ask_human', () => {
  it('calls update_task_status with waiting_human + pending_question', async () => {
    const queue = new HumanMessageQueue()
    const rpcCalls: Array<{ method: string; params: unknown }> = []
    const callOrder: string[] = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string, params: unknown) => {
          rpcCalls.push({ method, params })
          callOrder.push(method)
          if (method === 'update_task_status') return { task: { id: 't1', status: 'waiting_human' } }
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '2026-05-14T00:00:00Z' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const }),
    })

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: '你倾向 A、B 还是 C？',
      intent: 'ask_human',
    })

    const updateCall = rpcCalls.find(c => c.method === 'update_task_status')
    expect(updateCall).toBeDefined()
    expect(updateCall!.params).toMatchObject({
      task_id: 't1',
      status: 'waiting_human',
      pending_question: '你倾向 A、B 还是 C？',
    })

    const sendCall = rpcCalls.find(c => c.method === 'send_message')
    expect(sendCall).toBeDefined()  // ask_human 必须继续走原 send 逻辑，不能早 return

    // ordering 断言：send_message 必须在 update_task_status 之前（send-first）
    expect(callOrder.indexOf('send_message')).toBeLessThan(callOrder.indexOf('update_task_status'))

    queue.clearBarrier()
  })

  it('sets barrier on humanQueue after ask_human', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockResolvedValue({ platform_message_id: 'm', sent_at: '' }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const }),
    })

    expect(queue.hasBarrier).toBe(false)
    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'q',
      intent: 'ask_human',
    })
    expect(queue.hasBarrier).toBe(true)
    // cleanup timer to avoid leaking into vitest
    queue.clearBarrier()
  })

  it('returns error when getTaskContext is null', async () => {
    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'front',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => null,
    })
    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'q',
      intent: 'ask_human',
    })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.error).toBeDefined()
    expect(parsed.error).toContain('ask_human')
  })

  it('intent=normal does NOT touch task state or barrier', async () => {
    const queue = new HumanMessageQueue()
    const rpcMethods: string[] = []

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          rpcMethods.push(method)
          return { platform_message_id: 'm', sent_at: '' }
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const }),
    })

    const sendTool = findTool(tools, 'send_message')
    await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'normal message',
    })
    expect(rpcMethods).not.toContain('update_task_status')
    expect(queue.hasBarrier).toBe(false)
  })

  it('scheduled 任务调用 ask_human 时返回拒绝错误，错误消息含明确指引', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildMessagingTools({
      rpcClient: { call: vi.fn() } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'scheduled' as const }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'are you there?',
      intent: 'ask_human',
    })

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.error).toBeDefined()
    expect(parsed.error).toContain('ask_human is not allowed in scheduled tasks')
    expect(parsed.error).toMatch(/intent='?normal'?/)
  })

  it('message 任务调用 ask_human 不在 scheduled 闸门被拒（仍可走后续流程）', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          if (method === 'update_task_status') return { task: { id: 't1', status: 'waiting_human' } }
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'are you there?',
      intent: 'ask_human',
    })

    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    // message 触发的任务不应被第一道闸门（scheduled 拒绝）挡住
    expect(parsed.error ?? '').not.toContain('ask_human is not allowed in scheduled tasks')

    queue.clearBarrier()
  })

  it('does NOT set barrier if update_task_status fails', async () => {
    const queue = new HumanMessageQueue()

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string) => {
          if (method === 'update_task_status') throw new Error('admin unavailable')
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue, triggerType: 'message' as const }),
    })

    const sendTool = findTool(tools, 'send_message')
    const result = await sendTool.handler({
      channel_id: 'telegram-001',
      session_id: 's1',
      content: 'q',
      intent: 'ask_human',
    })

    // barrier 不应被设置，防止 worker 卡死 24h
    expect(queue.hasBarrier).toBe(false)

    // 结果应含 ask_human_state_error 字段，让 worker 感知到状态切换失败
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    const parsed = JSON.parse(text)
    expect(parsed.ask_human_state_error).toBeDefined()
    expect(parsed.ask_human_state_error).toContain('update_task_status')
  })
})
