import { describe, it, expect, vi } from 'vitest'
import { DecisionDispatcher } from '../../src/orchestration/decision-dispatcher.js'

/**
 * Phase 2: dispatcher 把 worker summary 末尾的 ```json``` 块解析为
 * outcome_brief / process_highlights 写入短期记忆，sendReplyToUser 时把契约块剥掉。
 *
 * 关键不变量：
 *   1. memoryWriter.writeTaskFinished 收到 outcome_brief / process_highlights（来自 JSON 块），
 *      不再有 summary 字段
 *   2. admin update_task_status 仍然收到原始 summary（含 JSON 块；系统层证据）
 *   3. sendReplyToUser 收到的文本不含 ```json``` fence
 */

const ADMIN_PORT = 19001
const CHANNEL_PORT = 19010

const SUMMARY_WITH_JSON = `已修复 /fav 500 接口，根因是 vod_ids 未校验。

\`\`\`json
{
  "outcome_brief": "已修复 /fav 500，根因 vod_ids 未校验",
  "process_highlights": [
    "用 grep 定位到 FavHandler",
    "缺 vod_ids 校验导致 nil deref"
  ]
}
\`\`\``

function makeDispatcher(opts: { resultSummary: string; finalReplyText: string }) {
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

  const executeTaskFn = vi.fn(async () => ({
    task_id: 't_smoke_001',
    outcome: 'completed' as const,
    summary: opts.resultSummary,
    final_reply: { type: 'text' as const, text: opts.finalReplyText },
  }))

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

describe('DecisionDispatcher - worker summary JSON 块解析', () => {
  it('把 JSON 块解析为 outcome_brief / process_highlights 写入 writeTaskFinished', async () => {
    const { dispatcher, memoryWriter } = makeDispatcher({
      resultSummary: SUMMARY_WITH_JSON,
      finalReplyText: SUMMARY_WITH_JSON,
    })

    await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: '修复 /fav 500',
        task_description: '修复',
        immediate_reply: { type: 'text', text: '收到' },
      },
      {
        channel_id: 'telegram-001',
        session_id: 'sess-x',
        messages: [{
          platform_message_id: 'm1',
          session: { channel_id: 'telegram-001', session_id: 'sess-x', type: 'group' as const },
          sender: { friend_id: 'f_wu', platform_user_id: 'u1', platform_display_name: 'Mr.Wu' },
          content: { type: 'text' as const, text: '修一下 /fav' },
          features: { is_mention_crab: true },
          platform_timestamp: new Date().toISOString(),
        }],
        senderFriend: { id: 'f_wu', display_name: 'Mr.Wu' } as any,
        memoryPermissions: { write_visibility: 'internal', write_scopes: [] } as any,
      },
    )

    // 等待后台任务跑完
    await new Promise(r => setTimeout(r, 30))

    expect(memoryWriter.writeTaskFinished).toHaveBeenCalledTimes(1)
    const args = memoryWriter.writeTaskFinished.mock.calls[0][0]
    expect(args.outcome_brief).toBe('已修复 /fav 500，根因 vod_ids 未校验')
    expect(args.process_highlights).toEqual([
      '用 grep 定位到 FavHandler',
      '缺 vod_ids 校验导致 nil deref',
    ])
    // 已经移除 summary 字段
    expect(args).not.toHaveProperty('summary')
  })

  it('admin update_task_status 仍收到原始 summary（系统层证据，含 JSON 块）', async () => {
    const { dispatcher, rpcCalls } = makeDispatcher({
      resultSummary: SUMMARY_WITH_JSON,
      finalReplyText: '',
    })

    await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: 'T',
        task_description: 'D',
        immediate_reply: { type: 'text', text: '' },
      },
      {
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
      },
    )

    await new Promise(r => setTimeout(r, 30))

    // 找 status=completed 那一发 update_task_status
    const finalUpdate = rpcCalls.find(
      c => c.method === 'update_task_status' && c.params?.status === 'completed',
    )
    expect(finalUpdate).toBeDefined()
    expect(finalUpdate!.params.result.summary).toBe(SUMMARY_WITH_JSON)
    expect(finalUpdate!.params.result.summary).toContain('```json')
  })

  it('sendReplyToUser 收到的文本剥掉了 ```json``` 块', async () => {
    const { dispatcher, rpcCalls } = makeDispatcher({
      resultSummary: SUMMARY_WITH_JSON,
      finalReplyText: SUMMARY_WITH_JSON,
    })

    await dispatcher.dispatch(
      {
        type: 'create_task',
        task_title: 'T',
        task_description: 'D',
        immediate_reply: { type: 'text', text: '' },
      },
      {
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
      },
    )

    await new Promise(r => setTimeout(r, 30))

    // 任务最终回复（task_completed reply）— 注意第一发 send_message 是 ack，
    // 任务结果要找最后一发 send_message
    const replyCalls = rpcCalls.filter(
      c => c.method === 'send_message' && c.port === CHANNEL_PORT,
    )
    expect(replyCalls.length).toBeGreaterThanOrEqual(1)
    const finalReply = replyCalls[replyCalls.length - 1]
    const text = finalReply.params.content.text
    expect(text).not.toContain('```json')
    expect(text).not.toContain('outcome_brief')
    expect(text).toBe('已修复 /fav 500 接口，根因是 vod_ids 未校验。')
  })
})
