import type { ResumeCheckpoint } from '../types.js'
import type { EngineMessage } from '../engine/types.js'

export type ResumeGuard = { ok: true } | { ok: false; reason: 'empty_checkpoint' | 'version_mismatch' }

export function isResumable(cp: ResumeCheckpoint, currentVersion: string): ResumeGuard {
  if (cp.agent_version !== currentVersion) return { ok: false, reason: 'version_mismatch' }
  if (!cp.messages || cp.messages.length === 0) return { ok: false, reason: 'empty_checkpoint' }
  return { ok: true }
}

export function buildResumeWakeupMessage(): EngineMessage {
  return {
    id: `resume-wakeup-${Date.now()}`,
    role: 'user',
    content:
      '[系统] 你（agent）刚重启过，正在恢复此 task。若你之前 spawn 过子 agent 或在 wait_for_signal 等待，' +
      '它们已随重启中断——用 list_entities / search_traces / 读 result 文件自查进度后，继续把任务做完。',
    timestamp: Date.now(),
  }
}
