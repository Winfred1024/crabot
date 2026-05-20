import { describe, it, expect } from 'vitest'
import { SessionLaneRegistry } from '../../src/orchestration/session-lane.js'

/**
 * 集成测试：验证 SessionLane 的串行 + 合并 + 跨 session 并行特性。
 * 注：不构造完整 unified-agent（依赖太多）；直接测 lane 行为 + 模拟
 * "处理函数完成后 activeTasks 已注册"的契约。
 *
 * Spec: 2026-05-20-session-lane-dispatcher-design.md §5
 */
describe('SessionLane × dispatcher 集成', () => {
  it('私聊连发 2 条合并为 batch_size=2 的一次 handler 调用', async () => {
    const handlerCalls: number[] = []
    const registry = new SessionLaneRegistry<{ message: string }>(async (batch) => {
      handlerCalls.push(batch.length)
      // 模拟 dispatcher + spawn 处理时间
      await new Promise(r => setTimeout(r, 50))
    })

    const lane = registry.getOrCreate('c1::s1')
    lane.enqueue({ message: 'PDF' })
    // 第一条立刻被 take（batch_size=1），开始 50ms 处理
    await new Promise(r => setTimeout(r, 10))
    // 在第一条处理中又来了两条
    lane.enqueue({ message: '现在呢' })
    lane.enqueue({ message: '还在吗' })
    // 等第一条 + 第二批都跑完
    await new Promise(r => setTimeout(r, 200))

    expect(handlerCalls).toEqual([1, 2])
  })

  it('同 session 慢节奏（间隔 > handler 时间）→ 两次独立 batch_size=1', async () => {
    const handlerCalls: number[] = []
    const registry = new SessionLaneRegistry<{ message: string }>(async (batch) => {
      handlerCalls.push(batch.length)
      await new Promise(r => setTimeout(r, 20))
    })
    const lane = registry.getOrCreate('c1::s1')
    lane.enqueue({ message: 'a' })
    await new Promise(r => setTimeout(r, 50))  // 等 lane 处理完 + 自我注销
    const lane2 = registry.getOrCreate('c1::s1')
    lane2.enqueue({ message: 'b' })
    await new Promise(r => setTimeout(r, 50))

    expect(handlerCalls).toEqual([1, 1])
  })

  it('跨 session 完全并行（lane-a 阻塞不影响 lane-b）', async () => {
    let aBlock: () => void = () => {}
    const aReady = new Promise<void>(r => { aBlock = r })
    const order: string[] = []
    const registry = new SessionLaneRegistry<{ name: string }>(async (batch) => {
      order.push(`start-${batch[0].name}`)
      if (batch[0].name === 'a') await aReady
      order.push(`end-${batch[0].name}`)
    })
    registry.getOrCreate('lane-a').enqueue({ name: 'a' })
    await new Promise(setImmediate)
    registry.getOrCreate('lane-b').enqueue({ name: 'b' })
    await new Promise(setImmediate)
    await new Promise(setImmediate)
    expect(order).toEqual(['start-a', 'start-b', 'end-b'])
    aBlock()
  })
})
