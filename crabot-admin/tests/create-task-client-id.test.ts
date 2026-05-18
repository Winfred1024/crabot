/**
 * handleCreateTask 接受 client-provided id 的单测。
 *
 * 参照 update-task-outcome.test.ts 风格：Object.create(AdminModule.prototype)
 * 跳过构造函数，注入最小 stub。
 */
import { describe, it, expect, vi } from 'vitest'
import { AdminModule } from '../src/index.js'
import type { Task, CreateTaskParams } from '../src/types.js'
import { AdminErrorCode } from '../src/types.js'

function buildAdmin(tasks: Task[] = []) {
  const admin = Object.create(AdminModule.prototype) as Record<string, unknown>
  admin.tasks = new Map<string, Task>(tasks.map((t) => [t.id, t]))
  admin.dataLoaded = true
  admin.saveData = vi.fn().mockResolvedValue(undefined)
  admin.atomicWriteFile = vi.fn().mockResolvedValue(undefined)
  admin.config = { moduleId: 'test-admin' }
  admin.rpcClient = {
    call: vi.fn(),
    resolve: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue(undefined),
  }
  return admin
}

const baseParams: CreateTaskParams = {
  title: '测试任务',
  source: { origin: 'human', channel_id: 'test-ch', trigger_type: 'manual' },
}

describe('handleCreateTask client-provided id', () => {
  it('传入 id 时使用 caller 提供的 task_id', async () => {
    const admin = buildAdmin()
    const params: CreateTaskParams = { ...baseParams, id: 'trigger-custom-123' }
    const { task } = await (admin as { handleCreateTask: (p: CreateTaskParams) => Promise<{ task: Task }> })
      .handleCreateTask(params)
    expect(task.id).toBe('trigger-custom-123')
    expect((admin.tasks as Map<string, Task>).has('trigger-custom-123')).toBe(true)
  })

  it('传入与已存在 task 冲突的 id 时抛 TASK_ALREADY_EXISTS', async () => {
    const existing: Task = {
      id: 'trigger-collision' as Task['id'],
      status: 'executing',
      priority: 'normal',
      title: '已存在',
      source: { origin: 'human', channel_id: 'ch', trigger_type: 'manual' },
      worker_agent_id: undefined,
      plan: undefined,
      input: undefined,
      output: undefined,
      error: undefined,
      messages: [],
      tags: [],
      created_at: '2026-05-18T00:00:00.000Z',
      updated_at: '2026-05-18T00:00:00.000Z',
      started_at: undefined,
      completed_at: undefined,
      expires_at: undefined,
    }
    const admin = buildAdmin([existing])
    const params: CreateTaskParams = { ...baseParams, id: 'trigger-collision' }
    await expect(
      (admin as { handleCreateTask: (p: CreateTaskParams) => Promise<{ task: Task }> })
        .handleCreateTask(params)
    ).rejects.toThrow(AdminErrorCode.TASK_ALREADY_EXISTS)
  })

  it('不传 id 时走 generateId 路径（回归）', async () => {
    const admin = buildAdmin()
    const { task } = await (admin as { handleCreateTask: (p: CreateTaskParams) => Promise<{ task: Task }> })
      .handleCreateTask(baseParams)
    expect(task.id).toBeTruthy()
    expect(task.id).not.toBe('trigger-custom-123')  // 不应是上一个测试的固定值
  })
})
