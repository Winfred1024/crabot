import { describe, it, expect } from 'vitest'
import { UnifiedAgent } from '../../src/unified-agent.js'

// setupBarriers 只能把「真正 arm 成功」的 task 返回给 clearAllBarriers，
// 否则 dispatch 结尾的 clearAllBarriers 会把被跳过的 park task（如 ask_human）
// 的 barrier 也清掉，二次误唤醒它。
describe('UnifiedAgent.setupBarriers', () => {
  it('已 park 被跳过(setBarrierForTask=false)的 task 不进返回列表', () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    const calls: string[] = []
    agent.agentHandler = {
      getActiveTasksByOrigin: () => ['running-task', 'parked-task'],
      setBarrierForTask: (taskId: string) => {
        calls.push(taskId)
        // parked-task 已挂 barrier → 跳过返回 false；running-task arm 成功
        return taskId !== 'parked-task'
      },
    }

    const result = agent.setupBarriers('ch', 'sess')

    expect(calls).toEqual(['running-task', 'parked-task']) // 两个都试过
    expect(result).toEqual(['running-task']) // 但只返回 arm 成功的
  })

  it('无 agentHandler → 空数组', () => {
    const agent = Object.create(UnifiedAgent.prototype) as any
    agent.agentHandler = undefined
    expect(agent.setupBarriers('ch', 'sess')).toEqual([])
  })
})
