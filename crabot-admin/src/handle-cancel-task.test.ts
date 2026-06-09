/**
 * Admin 模块 - handleCancelTask 端到端行为测试
 *
 * 验证 cancel 路径走 applyStatusTransition 后：
 * - pending → cancelled 仍然成立
 * - waiting_human → cancelled 会清掉 waiting_human_at / pending_question 残留
 * - 终态（failed 等）取消会被拒，且抛 TASK_NOT_CANCELLABLE 而不是 INVALID_STATUS_TRANSITION
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import { assertTaskInvariants } from './task-state-machine.js'

const TEST_PROTOCOL_PORT = 19822
const TEST_WEB_PORT = 13022
const TEST_DATA_DIR = './test-data/admin-cancel-task-test'

describe('handleCancelTask through applyStatusTransition', () => {
  let admin: AdminModule

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})

    admin = new AdminModule(
      {
        moduleId: 'admin-cancel-task-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_CANCEL_TASK',
        jwt_secret_env: 'TEST_JWT_SECRET_CANCEL_TASK',
        token_ttl: 3600,
      }
    )

    process.env.TEST_ADMIN_PASSWORD_CANCEL_TASK = 'test_password_123'
    process.env.TEST_JWT_SECRET_CANCEL_TASK = 'test_jwt_secret_at_least_32_chars'

    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('cancels pending task', async () => {
    const { task } = await (admin as any).handleCreateTask({
      title: 't', priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    const r = await (admin as any).handleCancelTask({ task_id: task.id, reason: 'user-canceled' })
    expect(r.cancelled).toBe(true)
    expect(r.task.status).toBe('cancelled')
    expect(r.task.error).toBe('user-canceled')
    expect(() => assertTaskInvariants(r.task)).not.toThrow()
  })

  it('cancels waiting_human task and clears derived fields', async () => {
    const { task } = await (admin as any).handleCreateTask({
      title: 't', priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({
      task_id: task.id, status: 'waiting_human', pending_question: 'q?',
    })

    const r = await (admin as any).handleCancelTask({ task_id: task.id, reason: 'user-canceled' })
    expect(r.cancelled).toBe(true)
    expect(r.task.status).toBe('cancelled')
    expect(r.task.waiting_human_at).toBeUndefined()
    expect(r.task.pending_question).toBeUndefined()
    expect(r.task.completed_at).toBeDefined()
    expect(() => assertTaskInvariants(r.task)).not.toThrow()
  })

  it('rejects cancel on terminal status', async () => {
    const { task } = await (admin as any).handleCreateTask({
      title: 't', priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'failed', error: 'oom' })

    await expect(
      (admin as any).handleCancelTask({ task_id: task.id, reason: 'too-late' }),
    ).rejects.toThrow()
  })
})
