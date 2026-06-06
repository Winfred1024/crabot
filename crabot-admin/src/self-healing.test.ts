/**
 * Admin 模块 - runSelfHealingForAgentRestart 端到端行为测试
 *
 * 验证 self-healing 路径走 applyStatusTransition 后，
 * waiting_human / waiting 任务被标 failed 时不会残留 *_at 字段。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import { assertTaskInvariants } from './task-state-machine.js'

const TEST_PROTOCOL_PORT = 19821
const TEST_WEB_PORT = 13021
const TEST_DATA_DIR = './test-data/admin-self-healing-test'

describe('runSelfHealingForAgentRestart through applyStatusTransition', () => {
  let admin: AdminModule

  beforeAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})

    admin = new AdminModule(
      {
        moduleId: 'admin-self-healing-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_SELF_HEALING',
        jwt_secret_env: 'TEST_JWT_SECRET_SELF_HEALING',
        token_ttl: 3600,
      }
    )

    process.env.TEST_ADMIN_PASSWORD_SELF_HEALING = 'test_password_123'
    process.env.TEST_JWT_SECRET_SELF_HEALING = 'test_jwt_secret_at_least_32_chars'

    await admin.start()
  })

  afterAll(async () => {
    await admin.stop()
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('clears waiting_human_at and pending_question when waiting_human → failed', async () => {
    // 准备：构造一个 waiting_human task
    const { task } = await (admin as any).handleCreateTask({
      title: 't',
      description: 'd',
      priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({
      task_id: task.id,
      status: 'waiting_human',
      pending_question: 'q?',
    })

    // 触发 self-healing
    await (admin as any).runSelfHealingForAgentRestart(1)

    const healed = (admin as any).tasks.get(task.id)
    expect(healed.status).toBe('failed')
    expect(healed.error).toBe('agent_restarted_during_execution')
    expect(healed.waiting_human_at).toBeUndefined()
    expect(healed.pending_question).toBeUndefined()
    expect(healed.completed_at).toBeDefined()
    expect(() => assertTaskInvariants(healed)).not.toThrow()
  })

  it('clears waiting_at on waiting → failed', async () => {
    const { task } = await (admin as any).handleCreateTask({
      title: 't',
      description: 'd',
      priority: 'normal',
      source: { trigger_type: 'manual', origin: 'human' },
    })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'planning' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'executing' })
    await (admin as any).handleUpdateTaskStatus({ task_id: task.id, status: 'waiting' })

    await (admin as any).runSelfHealingForAgentRestart(1)

    const healed = (admin as any).tasks.get(task.id)
    expect(healed.status).toBe('failed')
    expect(healed.waiting_at).toBeUndefined()
    expect(() => assertTaskInvariants(healed)).not.toThrow()
  })
})
