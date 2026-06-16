import { describe, it, expect } from 'vitest'
import { AgentHandler } from '../../src/agent/agent-handler.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('AgentHandler.setBarrierForTask', () => {
  it('正在干活(无 barrier)的 task → arm 8s hold', () => {
    const handler = Object.create(AgentHandler.prototype) as any
    const queue = new HumanMessageQueue()
    handler.humanQueues = new Map([['t1', queue]])

    const armed = handler.setBarrierForTask('t1', 8000)

    expect(armed).toBe(true)
    expect(queue.hasBarrier).toBe(true)
    queue.clearBarrier() // 清掉 timer 防泄漏
  })

  it('未知 task → false', () => {
    const handler = Object.create(AgentHandler.prototype) as any
    handler.humanQueues = new Map()
    expect(handler.setBarrierForTask('missing', 8000)).toBe(false)
  })

  it('已 park 在 ask_human barrier 上的 task → 跳过,不唤醒等待者', async () => {
    const handler = Object.create(AgentHandler.prototype) as any
    const queue = new HumanMessageQueue()
    handler.humanQueues = new Map([['t1', queue]])

    // 模拟 ask_human:task 已 setBarrier(24h) 并 park 在 waitBarrier 上
    queue.setBarrier(DAY_MS)
    let woke = false
    const waiting = queue.waitBarrier().then(() => { woke = true })

    // dispatcher 处理新入站消息时跑 setupBarriers → 试图再 setBarrierForTask
    const armed = handler.setBarrierForTask('t1', 8000)
    await Promise.resolve()
    await Promise.resolve()

    // 关键:已 park 的 task 不被广播式 setBarrier 误唤醒
    expect(armed).toBe(false)
    expect(woke).toBe(false)

    // 唯一合法唤醒路径:supplement 投递(push)——带内容唤醒
    queue.push('用户补充指示：帮我分析这个文件')
    await waiting
    expect(woke).toBe(true)
  })
})
