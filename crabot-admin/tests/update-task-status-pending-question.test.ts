/**
 * handleUpdateTaskStatus pending_question 字段读写单元测试
 *
 * 用 Object.create(AdminModule.prototype) 跳过构造函数，注入最小 stub，
 * 直接调 private handler 方法（用 as any 绕过 private 约束）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AdminModule } from '../src/index.js'
import type { Task } from '../src/types.js'

function makeExecutingTask(overrides: Partial<Task> = {}): Task {
  const now = '2026-05-14T00:00:00.000Z'
  return {
    id: 'task-pending-q-001' as Task['id'],
    status: 'executing',
    priority: 'normal',
    title: '测试任务',
    source: { origin: 'human', trigger_type: 'manual' },
    worker_agent_id: undefined,
    plan: undefined,
    result: undefined,
    input: undefined,
    output: undefined,
    error: undefined,
    messages: [],
    tags: [],
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: undefined,
    ...overrides,
  }
}

function buildAdmin(tasks: Task[] = []) {
  const admin = Object.create(AdminModule.prototype) as Record<string, unknown>

  const tasksMap = new Map<string, Task>(tasks.map((t) => [t.id, t]))
  admin.tasks = tasksMap

  // dataLoaded=true，让 saveData 不被 guard 拦截
  admin.dataLoaded = true

  // saveData stub
  admin.saveData = vi.fn().mockResolvedValue(undefined)

  // atomicWriteFile stub
  admin.atomicWriteFile = vi.fn().mockResolvedValue(undefined)

  // schedules map（任务完成时推进 watermark 需要）
  admin.schedules = new Map()

  // config 和 rpcClient 是 publishAdminEvent 需要的
  admin.config = { moduleId: 'test-admin' }
  admin.rpcClient = {
    call: vi.fn(),
    resolve: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue(undefined),
  }

  return admin
}

describe('handleUpdateTaskStatus pending_question', () => {
  let admin: Record<string, unknown>
  let taskId: string

  beforeEach(() => {
    const task = makeExecutingTask()
    taskId = task.id
    admin = buildAdmin([task])
  })

  it('切到 waiting_human 时写入 pending_question', async () => {
    const { task } = await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'waiting_human',
      pending_question: '信号判定窗口选 A 还是 B？',
    })
    expect(task.status).toBe('waiting_human')
    expect(task.pending_question).toBe('信号判定窗口选 A 还是 B？')
  })

  it('切回 executing 时自动清空 pending_question', async () => {
    // 先切到 waiting_human 写入 pending_question
    await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'waiting_human',
      pending_question: 'q1',
    })
    // 再切回 executing，pending_question 应被清空
    const { task } = await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'executing',
    })
    expect(task.status).toBe('executing')
    expect(task.pending_question).toBeUndefined()
  })

  it('显式传 pending_question: null 也清空（非 executing 终态）', async () => {
    // 先切到 waiting_human 写入 pending_question
    await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'waiting_human',
      pending_question: 'q1',
    })
    // 切到 cancelled（非 executing）并显式传 null
    // status !== 'executing'，所以只有 pending_question === null 这条分支生效
    const { task } = await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'cancelled',
      pending_question: null,
    })
    expect(task.pending_question).toBeUndefined()
  })
})
