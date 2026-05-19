import { describe, it, expect, vi } from 'vitest'
import { dispatch } from '../../src/dispatcher/dispatcher.js'
import type { DispatchContext, DispatchAction } from '../../src/dispatcher/dispatcher-types.js'
import type { LLMAdapter, LLMStreamParams, LLMCallResponse } from '../../src/engine/llm-adapter-types.js'

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    messages: [],
    activeTasks: [],
    sessionType: 'private',
    channelId: 'ch-test',
    sessionId: 'sess-test',
    senderFriend: {
      id: 'fr-1' as never,
      display_name: 'tester',
      permission: 'master',
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    traceId: 'trace-test',
    ...overrides,
  }
}

function makeMockAdapter(responseText: string): LLMAdapter {
  return {
    stream: async function* () { /* not used */ },
    complete: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: responseText }],
      stopReason: 'end_turn',
    } satisfies LLMCallResponse),
    updateConfig: () => {},
  }
}

describe('dispatch', () => {
  it('LLM 返回单个 supplement 动作时正确解析', async () => {
    const adapter = makeMockAdapter(JSON.stringify({
      actions: [{ kind: 'supplement', target_task_id: 'task-A', text: '只看红米' }],
    }))
    const { actions } = await dispatch(makeCtx(), { adapter, modelId: 'm', sendErrorToUser: vi.fn() })
    expect(actions).toEqual<DispatchAction[]>([
      { kind: 'supplement', target_task_id: 'task-A', text: '只看红米' },
    ])
  })

  it('LLM 返回多个动作（拆分）时按顺序输出', async () => {
    const adapter = makeMockAdapter(JSON.stringify({
      actions: [
        { kind: 'new_task', text: '查 github 早报' },
        { kind: 'supplement', target_task_id: 'task-A', text: '对比 CPU' },
      ],
    }))
    const { actions } = await dispatch(makeCtx(), { adapter, modelId: 'm', sendErrorToUser: vi.fn() })
    expect(actions).toHaveLength(2)
    expect(actions[0].kind).toBe('new_task')
    expect(actions[1].kind).toBe('supplement')
  })

  it('LLM 返回的动作数超过 MAX_ACTIONS_PER_DISPATCH 时截断', async () => {
    const tooMany = Array.from({ length: 10 }, (_, i) => ({ kind: 'new_task' as const, text: `task ${i}` }))
    const adapter = makeMockAdapter(JSON.stringify({ actions: tooMany }))
    const { actions } = await dispatch(makeCtx(), { adapter, modelId: 'm', sendErrorToUser: vi.fn() })
    expect(actions.length).toBeLessThanOrEqual(5)
  })

  it('LLM 输出格式错误 → 重试用完后 sendErrorToUser 被调', async () => {
    const adapter: LLMAdapter = {
      stream: async function* () { /* not used */ },
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'this is not json at all' }],
        stopReason: 'end_turn',
      } satisfies LLMCallResponse),
      updateConfig: () => {},
    }
    const sendErrorToUser = vi.fn().mockResolvedValue(undefined)
    const { actions } = await dispatch(
      makeCtx(),
      { adapter, modelId: 'm', sendErrorToUser, maxParseRetries: 1 },
    )
    expect(actions).toEqual([])
    expect(sendErrorToUser).toHaveBeenCalledTimes(1)
    expect(sendErrorToUser.mock.calls[0][0]).toContain('系统出错')
  })

  it('私聊场景下 LLM 误输出 stay_silent → 校验失败 retry', async () => {
    let callCount = 0
    const adapter: LLMAdapter = {
      stream: async function* () { /* not used */ },
      complete: vi.fn().mockImplementation(async (_params: LLMStreamParams): Promise<LLMCallResponse> => {
        callCount++
        const text = callCount === 1
          ? JSON.stringify({ actions: [{ kind: 'stay_silent', reason: '...' }] })
          : JSON.stringify({ actions: [{ kind: 'new_task', text: 'hi' }] })
        return { content: [{ type: 'text', text }], stopReason: 'end_turn' }
      }),
      updateConfig: () => {},
    }
    const { actions } = await dispatch(
      makeCtx({ sessionType: 'private' }),
      { adapter, modelId: 'm', sendErrorToUser: vi.fn(), maxParseRetries: 3 },
    )
    expect(actions[0].kind).toBe('new_task')
    expect(callCount).toBe(2)
  })
})
