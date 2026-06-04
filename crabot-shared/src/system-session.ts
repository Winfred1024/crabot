import type { ModuleId, SessionId } from './base-protocol.js'

/**
 * 系统占位 session 哨兵。
 *
 * 用于 schedule 等系统触发的 task 在 trigger_message 里表达"无目标会话"——
 * 当 Schedule 未配置 target_session 时，ScheduledTaskRunner 构造 trigger_message
 * 时把 session 字段填为此哨兵。
 *
 * Worker 拿到此 session 不应试图调 channel.send_message 发送（crab-messaging
 * 会硬拒绝），应按 trigger_message.content.text 的指引自行决定是否汇报、汇报
 * 到哪个真实 session（如调 send_master_private）。
 */
export const SYSTEM_CHANNEL_ID = 'system' as ModuleId
export const SYSTEM_SESSION_ID = 'system' as SessionId

export const SYSTEM_SESSION = {
  channel_id: SYSTEM_CHANNEL_ID,
  session_id: SYSTEM_SESSION_ID,
  type: 'private' as const,
} as const
