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

    const tools = buildMessagingTools({
      rpcClient: {
        call: vi.fn().mockImplementation(async (_port: number, method: string, params: unknown) => {
          rpcCalls.push({ method, params })
          if (method === 'update_task_status') return { task: { id: 't1', status: 'waiting_human' } }
          if (method === 'send_message') return { platform_message_id: 'm1', sent_at: '2026-05-14T00:00:00Z' }
          return {}
        }),
      } as never,
      moduleId: 'worker-test',
      getAdminPort: async () => 19001,
      resolveChannelPort: async () => 19009,
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue }),
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
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue }),
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
    expect(text.toLowerCase()).toContain('ask_human')
    expect(text.toLowerCase()).toContain('error')
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
      getTaskContext: () => ({ taskId: 't1', humanQueue: queue }),
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
})
