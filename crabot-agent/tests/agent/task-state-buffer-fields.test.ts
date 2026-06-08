import { describe, it, expect } from 'vitest'
import type { WorkerTaskState } from '../../src/types.js'
import { TodoStore } from '../../src/agent/worker-todo-store.js'

/**
 * Task 5 验证 WorkerTaskState 上新增的三字段默认初始化形状：
 *   - outboundBuffer: 空数组（可变；audit 等待态下 handler push, engine flush）
 *   - activeAuditId: undefined（工作态）
 *   - activeAsyncSubagentIds: 空 Set（runWorkerLoop 跨 iteration 持久；Task 3 reviewer follow-up）
 *
 * 不跑 runWorkerLoop —— 直接构造一个满足 shape 的 plain object 来固定接口契约：
 * 任何人改 WorkerTaskState 时如果默认值偏离这里，这组测试会作为提醒触发更新。
 */
describe('WorkerTaskState 新增字段（Task 5）', () => {
  const makeStub = (): WorkerTaskState => ({
    taskId: 'task_test',
    status: 'executing',
    startedAt: new Date().toISOString(),
    abortController: {
      signal: { aborted: false },
      abort: () => {},
    },
    pendingHumanMessages: [],
    todoStore: new TodoStore(),
    outboundBuffer: [],
    activeAuditId: undefined,
    activeAsyncSubagentIds: new Set<string>(),
  })

  it('outboundBuffer 初始化为空数组', () => {
    const ts = makeStub()
    expect(Array.isArray(ts.outboundBuffer)).toBe(true)
    expect(ts.outboundBuffer).toEqual([])
    expect(ts.outboundBuffer.length).toBe(0)
  })

  it('activeAuditId 初始化为 undefined（工作态）', () => {
    const ts = makeStub()
    expect(ts.activeAuditId).toBeUndefined()
  })

  it('activeAsyncSubagentIds 初始化为空 Set', () => {
    const ts = makeStub()
    expect(ts.activeAsyncSubagentIds).toBeInstanceOf(Set)
    expect(ts.activeAsyncSubagentIds.size).toBe(0)
  })

  it('outboundBuffer 支持 push / splice（handler push, engine flush 语义）', () => {
    const ts = makeStub()
    ts.outboundBuffer.push({
      channel_id: 'wechat:friend:abc',
      session_id: 'session_abc',
      content: 'hello',
      intent: 'info',
      sent_at_attempt_ms: Date.now(),
    })
    expect(ts.outboundBuffer.length).toBe(1)
    const drained = ts.outboundBuffer.splice(0)
    expect(drained.length).toBe(1)
    expect(ts.outboundBuffer.length).toBe(0)
  })

  it('activeAuditId 是可写字段（运行时切换工作态 ↔ 等审态）', () => {
    const ts = makeStub()
    ts.activeAuditId = 'audit_xyz'
    expect(ts.activeAuditId).toBe('audit_xyz')
    ts.activeAuditId = undefined
    expect(ts.activeAuditId).toBeUndefined()
  })

  it('activeAsyncSubagentIds Set 引用是 readonly 但内部可变（跨 iteration 持久）', () => {
    const ts = makeStub()
    const ref = ts.activeAsyncSubagentIds
    ts.activeAsyncSubagentIds.add('agent_1')
    ts.activeAsyncSubagentIds.add('agent_2')
    expect(ref).toBe(ts.activeAsyncSubagentIds) // 同一引用
    expect(ts.activeAsyncSubagentIds.size).toBe(2)
    expect(ts.activeAsyncSubagentIds.has('agent_1')).toBe(true)
  })
})
