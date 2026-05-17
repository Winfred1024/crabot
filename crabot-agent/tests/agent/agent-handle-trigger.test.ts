import { describe, it, expect } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type {
  HandleTriggerMessageParams,
  HandleTriggerMessageResult,
} from '../../src/agent/agent-handler.js'

describe('AgentHandler.handleTriggerMessage 类型契约', () => {
  it('方法存在于 AgentHandler 原型上', () => {
    expect(typeof AgentHandler.prototype.handleTriggerMessage).toBe('function')
  })

  it('HandleTriggerMessageParams 类型支持 minimal 字段', () => {
    // 编译期类型校验——如果字段名或可选性变了，下面赋值会编译失败
    const minimal: Pick<
      HandleTriggerMessageParams,
      | 'messages'
      | 'activeTasks'
      | 'isGroup'
      | 'senderFriend'
      | 'triggerArrivedAtMs'
      | 'memoryPermissions'
      | 'resolvedPermissions'
      | 'channelId'
      | 'sessionId'
    > = {
      messages: [],
      activeTasks: [],
      isGroup: false,
      senderFriend: { id: 'f1' } as HandleTriggerMessageParams['senderFriend'],
      triggerArrivedAtMs: Date.now(),
      memoryPermissions: {} as HandleTriggerMessageParams['memoryPermissions'],
      resolvedPermissions: {} as HandleTriggerMessageParams['resolvedPermissions'],
      channelId: 'ch-1',
      sessionId: 'sess-1',
    }
    expect(minimal.isGroup).toBe(false)
  })

  it('HandleTriggerMessageResult 含必要字段', () => {
    const sample: HandleTriggerMessageResult = {
      outcome: 'completed',
      finalText: 'hello',
      sentMessage: true,
      overdueInjected: false,
    }
    expect(sample.outcome).toBe('completed')
  })

  it('HandleTriggerMessageResult 支持 exitToolCall optional', () => {
    const withExit: HandleTriggerMessageResult = {
      outcome: 'completed',
      finalText: '',
      sentMessage: false,
      overdueInjected: false,
      exitToolCall: { name: 'supplement_task', input: { target_task_id: 't1', supplement_text: 'fix' } },
    }
    expect(withExit.exitToolCall?.name).toBe('supplement_task')
  })

  it('HandleTriggerMessageResult 支持 error optional', () => {
    const failed: HandleTriggerMessageResult = {
      outcome: 'failed',
      finalText: '',
      sentMessage: false,
      overdueInjected: false,
      error: 'adapter timeout',
    }
    expect(failed.error).toBe('adapter timeout')
  })

  it('outcome 字段限定为 4 个枚举值', () => {
    // 编译期校验：以下任一无效值赋值会编译失败
    const outcomes: HandleTriggerMessageResult['outcome'][] = [
      'completed', 'failed', 'max_turns', 'aborted',
    ]
    expect(outcomes.length).toBe(4)
  })
})
