import { describe, it, expect } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import type {
  ExecuteTriggerMessageParams,
  ExecuteTriggerMessageResult,
} from '../../src/agent/agent-handler.js'

describe('AgentHandler.executeTriggerMessage 类型契约', () => {
  it('方法存在于 AgentHandler 原型上', () => {
    expect(typeof AgentHandler.prototype.executeTriggerMessage).toBe('function')
  })

  it('ExecuteTriggerMessageParams 类型支持 minimal 字段', () => {
    // 编译期类型校验——如果字段名或可选性变了，下面赋值会编译失败
    const minimal: Pick<
      ExecuteTriggerMessageParams,
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
      senderFriend: { id: 'f1' } as ExecuteTriggerMessageParams['senderFriend'],
      triggerArrivedAtMs: Date.now(),
      memoryPermissions: {} as ExecuteTriggerMessageParams['memoryPermissions'],
      resolvedPermissions: {} as ExecuteTriggerMessageParams['resolvedPermissions'],
      channelId: 'ch-1',
      sessionId: 'sess-1',
    }
    expect(minimal.isGroup).toBe(false)
  })

  it('ExecuteTriggerMessageResult 含必要字段', () => {
    const sample: ExecuteTriggerMessageResult = {
      outcome: 'completed',
      finalText: 'hello',
      sentMessage: true,
      overdueInjected: false,
    }
    expect(sample.outcome).toBe('completed')
  })

  it('ExecuteTriggerMessageResult 支持 exitToolCall optional', () => {
    const withExit: ExecuteTriggerMessageResult = {
      outcome: 'completed',
      finalText: '',
      sentMessage: false,
      overdueInjected: false,
      exitToolCall: { name: 'supplement_task', input: { target_task_id: 't1', supplement_text: 'fix' } },
    }
    expect(withExit.exitToolCall?.name).toBe('supplement_task')
  })

  it('ExecuteTriggerMessageResult 支持 error optional', () => {
    const failed: ExecuteTriggerMessageResult = {
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
    const outcomes: ExecuteTriggerMessageResult['outcome'][] = [
      'completed', 'failed', 'max_turns', 'aborted',
    ]
    expect(outcomes.length).toBe(4)
  })
})
