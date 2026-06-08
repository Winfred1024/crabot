/**
 * Admin 模块 — Schedule.target_session 一等可选字段测试
 *
 * 验证 create_schedule / update_schedule / get_schedule 完整覆盖 target_session 三态：
 *   - 不传字段：保持现有
 *   - 传 null（仅 update）：清除已配置的 target_session
 *   - 传对象：写入或更新
 *
 * 直接调 admin handler，不走 HTTP RPC（避免端口绑定 / 测试间串扰）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import AdminModule from './index.js'
import type {
  Schedule,
  CreateScheduleParams,
  UpdateScheduleParams,
  GetScheduleParams,
  ScheduleTargetSession,
} from './types.js'

const TEST_PROTOCOL_PORT = 19820
const TEST_WEB_PORT = 13020
const TEST_DATA_DIR = './test-data/schedule-target-session-test'

interface AdminHandlers {
  handleCreateSchedule(params: CreateScheduleParams): Promise<{ schedule: Schedule }>
  handleUpdateSchedule(params: UpdateScheduleParams): Promise<{ schedule: Schedule }>
  handleGetSchedule(params: GetScheduleParams): Promise<{ schedule: Schedule }>
}

describe('Schedule.target_session', () => {
  let admin: AdminModule
  let handlers: AdminHandlers

  beforeAll(async () => {
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }

    process.env.TEST_ADMIN_PASSWORD_TGT = 'test_password_123'
    process.env.TEST_JWT_SECRET_TGT = 'test_jwt_secret_at_least_32_chars_target'

    admin = new AdminModule(
      {
        moduleId: 'admin-target-session-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: TEST_PROTOCOL_PORT,
        subscriptions: [],
      },
      {
        web_port: TEST_WEB_PORT,
        data_dir: TEST_DATA_DIR,
        password_env: 'TEST_ADMIN_PASSWORD_TGT',
        jwt_secret_env: 'TEST_JWT_SECRET_TGT',
        token_ttl: 3600,
      }
    )

    await admin.start()
    handlers = admin as unknown as AdminHandlers
  })

  afterAll(async () => {
    await admin.stop()
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  const baseTemplate = {
    type: 'routine',
    title: 'Daily Routine',
    priority: 'normal' as const,
    tags: [] as string[],
  }

  const sampleTarget: ScheduleTargetSession = {
    channel_id: 'telegram-main',
    session_id: 'sess-abc-123',
    type: 'group',
  }

  it('create_schedule accepts target_session and persists it', async () => {
    const result = await handlers.handleCreateSchedule({
      name: 'WithTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      target_session: sampleTarget,
    })

    expect(result.schedule.target_session).toEqual(sampleTarget)

    // 持久化后 get_schedule 也能读到
    const fetched = await handlers.handleGetSchedule({ schedule_id: result.schedule.id })
    expect(fetched.schedule.target_session).toEqual(sampleTarget)
  })

  it('create_schedule without target_session leaves field undefined', async () => {
    const result = await handlers.handleCreateSchedule({
      name: 'NoTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
    })

    expect(result.schedule.target_session).toBeUndefined()
  })

  it('update_schedule without target_session field preserves existing', async () => {
    const created = await handlers.handleCreateSchedule({
      name: 'PreserveTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      target_session: sampleTarget,
    })

    // 不传 target_session — 只改 name
    const updated = await handlers.handleUpdateSchedule({
      schedule_id: created.schedule.id,
      name: 'PreserveTarget-Renamed',
    })

    expect(updated.schedule.name).toBe('PreserveTarget-Renamed')
    expect(updated.schedule.target_session).toEqual(sampleTarget)
  })

  it('update_schedule with target_session=null clears the field', async () => {
    const created = await handlers.handleCreateSchedule({
      name: 'ClearTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      target_session: sampleTarget,
    })

    const updated = await handlers.handleUpdateSchedule({
      schedule_id: created.schedule.id,
      target_session: null,
    })

    expect(updated.schedule.target_session).toBeUndefined()

    const fetched = await handlers.handleGetSchedule({ schedule_id: created.schedule.id })
    expect(fetched.schedule.target_session).toBeUndefined()
  })

  it('update_schedule with new target_session object overwrites previous', async () => {
    const created = await handlers.handleCreateSchedule({
      name: 'OverwriteTarget',
      trigger: { type: 'interval', seconds: 60 },
      task_template: baseTemplate,
      target_session: sampleTarget,
    })

    const newTarget: ScheduleTargetSession = {
      channel_id: 'feishu-secondary',
      session_id: 'sess-xyz-999',
      type: 'private',
    }

    const updated = await handlers.handleUpdateSchedule({
      schedule_id: created.schedule.id,
      target_session: newTarget,
    })

    expect(updated.schedule.target_session).toEqual(newTarget)
  })

  it('rejects target_session with invalid type field', async () => {
    await expect(
      handlers.handleCreateSchedule({
        name: 'InvalidType',
        trigger: { type: 'interval', seconds: 60 },
        task_template: baseTemplate,
        target_session: {
          channel_id: 'telegram-main',
          session_id: 'sess-1',
          // @ts-expect-error testing runtime rejection of invalid type
          type: 'channel',
        },
      })
    ).rejects.toThrow(/target_session\.type/)
  })
})
