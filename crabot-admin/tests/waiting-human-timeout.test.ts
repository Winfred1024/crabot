/**
 * runWaitingHumanTimeoutScan 超时调度器单元测试
 *
 * 用 Object.create(AdminModule.prototype) 跳过构造函数，注入最小 stub，
 * 直接调 public runWaitingHumanTimeoutScan 方法。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AdminModule } from '../src/index.js'
import type { Task } from '../src/types.js'

const WAITING_HUMAN_TIMEOUT_MS = 24 * 60 * 60 * 1000  // 24h

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString()
  return {
    id: `task-to-${Date.now()}` as Task['id'],
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

  admin.dataLoaded = true
  admin.saveData = vi.fn().mockResolvedValue(undefined)
  admin.atomicWriteFile = vi.fn().mockResolvedValue(undefined)
  admin.schedules = new Map()
  admin.config = { moduleId: 'test-admin' }
  admin.rpcClient = {
    call: vi.fn(),
    resolve: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue(undefined),
  }

  return admin
}

describe('runWaitingHumanTimeoutScan', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('未达到 24h 阈值前不超时', async () => {
    // 先设置任务为 waiting_human 状态，waiting_human_at = 现在
    const task = makeTask({ status: 'waiting_human', waiting_human_at: new Date().toISOString() })
    const admin = buildAdmin([task])

    // 推进到接近但未超过阈值
    vi.advanceTimersByTime(WAITING_HUMAN_TIMEOUT_MS - 1000)

    await (admin as any).runWaitingHumanTimeoutScan()

    const updatedTask = (admin.tasks as Map<string, Task>).get(task.id)!
    expect(updatedTask.status).toBe('waiting_human')
  })

  it('超过 24h 后自动切 failed', async () => {
    const task = makeTask({ status: 'waiting_human', waiting_human_at: new Date().toISOString() })
    const admin = buildAdmin([task])

    // 推进超过阈值
    vi.advanceTimersByTime(WAITING_HUMAN_TIMEOUT_MS + 1000)

    await (admin as any).runWaitingHumanTimeoutScan()

    const updatedTask = (admin.tasks as Map<string, Task>).get(task.id)!
    expect(updatedTask.status).toBe('failed')
    expect(updatedTask.error).toContain('超时未收到人类回复')
    expect(updatedTask.waiting_human_at).toBeUndefined()
  })

  it('非 waiting_human 状态的任务不受影响', async () => {
    const task = makeTask({ status: 'executing' })
    const admin = buildAdmin([task])

    // 推进 25h
    vi.advanceTimersByTime(25 * 60 * 60 * 1000)

    await (admin as any).runWaitingHumanTimeoutScan()

    const updatedTask = (admin.tasks as Map<string, Task>).get(task.id)!
    expect(updatedTask.status).toBe('executing')
  })
})
