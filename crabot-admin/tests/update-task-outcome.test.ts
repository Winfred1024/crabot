/**
 * handleUpdateTaskOutcome 单元测试
 *
 * 用 Object.create(AdminModule.prototype) 跳过构造函数，注入最小 stub，
 * 直接调 private handler 方法（用 as any 绕过 private 约束）。
 */

import { describe, it, expect, vi } from 'vitest'
import { AdminModule } from '../src/index.js'
import type { Task, TaskResult } from '../src/types.js'

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = '2026-05-12T00:00:00.000Z'
  return {
    id: 'task-test-001' as Task['id'],
    status: 'completed',
    priority: 'normal',
    title: '测试任务',
    source: { origin: 'human', channel_id: 'test-ch', trigger_type: 'manual' },
    worker_agent_id: undefined,
    plan: undefined,
    result: {
      outcome: 'completed',
      finished_at: now,
    } satisfies TaskResult,
    input: undefined,
    output: undefined,
    error: undefined,
    messages: [],
    tags: [],
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: now,
    ...overrides,
  }
}

function buildAdmin(tasks: Task[] = []) {
  const admin = Object.create(AdminModule.prototype) as Record<string, unknown>

  const tasksMap = new Map<string, Task>(tasks.map((t) => [t.id, t]))
  admin.tasks = tasksMap

  // dataLoaded=true，让 saveData 不被 guard 拦截
  admin.dataLoaded = true

  // saveData stub（tasks 是 in-memory，saveData 只写其他数据，这里不关心磁盘）
  admin.saveData = vi.fn().mockResolvedValue(undefined)

  // atomicWriteFile stub（saveData 内部会用到，但已被整体 mock 掉）
  admin.atomicWriteFile = vi.fn().mockResolvedValue(undefined)

  // config 和 rpcClient 是 publishAdminEvent 需要的
  admin.config = { moduleId: 'test-admin' }
  admin.rpcClient = {
    call: vi.fn(),
    resolve: vi.fn(),
    publishEvent: vi.fn().mockResolvedValue(undefined),
  }

  return admin
}

describe('handleUpdateTaskOutcome', () => {
  it('patch outcome_brief / process_highlights 到已 completed 的 task.result，不动 status / summary / finished_at', async () => {
    const originalResult: TaskResult = {
      outcome: 'completed',
      finished_at: '2026-05-12T00:00:00.000Z',
      summary: '已完成旧摘要',
    }
    const task = makeTask({ result: originalResult })
    const admin = buildAdmin([task])

    const result = await (admin as any).handleUpdateTaskOutcome({
      task_id: task.id,
      outcome_brief: '任务顺利完成，无异常',
      process_highlights: ['步骤 A 正常', '步骤 B 正常'],
    })

    expect(result.task.status).toBe('completed')
    expect(result.task.result?.outcome).toBe('completed')
    expect(result.task.result?.finished_at).toBe('2026-05-12T00:00:00.000Z')
    expect(result.task.result?.summary).toBe('已完成旧摘要')
    expect(result.task.result?.outcome_brief).toBe('任务顺利完成，无异常')
    expect(result.task.result?.process_highlights).toEqual(['步骤 A 正常', '步骤 B 正常'])
    // updated_at 应被更新
    expect(result.task.updated_at).not.toBe('2026-05-12T00:00:00.000Z')
  })

  it('对不存在的 task 抛 TASK_NOT_FOUND 错误', async () => {
    const admin = buildAdmin([]) // 空 tasks map

    await expect(
      (admin as any).handleUpdateTaskOutcome({
        task_id: 'nonexistent-task-id',
        outcome_brief: '不存在',
      })
    ).rejects.toThrow('TASK_NOT_FOUND')
  })

  it('outcome_brief 缺失时只更新 process_highlights，其他字段不受影响', async () => {
    const originalResult: TaskResult = {
      outcome: 'completed',
      finished_at: '2026-05-12T00:00:00.000Z',
      outcome_brief: '原有 brief',
    }
    const task = makeTask({ result: originalResult })
    const admin = buildAdmin([task])

    const result = await (admin as any).handleUpdateTaskOutcome({
      task_id: task.id,
      process_highlights: ['只有 highlights'],
      // outcome_brief 不传 → 不覆盖原值
    })

    expect(result.task.result?.outcome_brief).toBe('原有 brief')
    expect(result.task.result?.process_highlights).toEqual(['只有 highlights'])
    expect(result.task.result?.finished_at).toBe('2026-05-12T00:00:00.000Z')
  })
})
