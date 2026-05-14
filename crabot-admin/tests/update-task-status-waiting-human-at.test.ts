/**
 * handleUpdateTaskStatus waiting_human_at 字段读写单元测试
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
    id: 'task-wh-at-001' as Task['id'],
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

describe('handleUpdateTaskStatus waiting_human_at', () => {
  let admin: Record<string, unknown>
  let taskId: string

  beforeEach(() => {
    const task = makeExecutingTask()
    taskId = task.id
    admin = buildAdmin([task])
  })

  it('切到 waiting_human 时写入 waiting_human_at', async () => {
    const { task } = await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'waiting_human',
    })
    expect(task.status).toBe('waiting_human')
    expect(task.waiting_human_at).toBeTruthy()
    // 应该是有效的 ISO 时间戳
    expect(new Date(task.waiting_human_at).getTime()).not.toBeNaN()
  })

  it('切回 executing 时自动清空 waiting_human_at', async () => {
    // 先切到 waiting_human 写入 waiting_human_at
    await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'waiting_human',
    })
    // 再切回 executing，waiting_human_at 应被清空
    const { task } = await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'executing',
    })
    expect(task.status).toBe('executing')
    expect(task.waiting_human_at).toBeUndefined()
  })

  it('切到 cancelled 时清空 waiting_human_at', async () => {
    await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'waiting_human',
    })
    const { task } = await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'cancelled',
    })
    expect(task.status).toBe('cancelled')
    expect(task.waiting_human_at).toBeUndefined()
  })

  it('切到 failed 时清空 waiting_human_at', async () => {
    await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'waiting_human',
    })
    const { task } = await (admin as any).handleUpdateTaskStatus({
      task_id: taskId,
      status: 'failed',
    })
    expect(task.status).toBe('failed')
    expect(task.waiting_human_at).toBeUndefined()
  })
})
