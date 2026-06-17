import type { ResumeCheckpoint } from '../types.js'
import type { EngineMessage } from '../engine/types.js'
import { redactSecrets } from '../engine/redact-secrets.js'

export type ResumeGuard = { ok: true } | { ok: false; reason: 'empty_checkpoint' | 'version_mismatch' }

export function isResumable(cp: ResumeCheckpoint, currentVersion: string): ResumeGuard {
  if (cp.agent_version !== currentVersion) return { ok: false, reason: 'version_mismatch' }
  if (!cp.messages || cp.messages.length === 0) return { ok: false, reason: 'empty_checkpoint' }
  return { ok: true }
}

/**
 * 对 ResumeCheckpoint 做脱敏处理，用于 UI 读路径（get_trace）。
 * 纯函数，返回新对象；落盘和 resume 读路径不受影响。
 */
export function redactCheckpoint(cp: ResumeCheckpoint, secrets: readonly string[]): ResumeCheckpoint {
  const redactedSystemPrompt = redactSecrets(cp.system_prompt, secrets)
  const messagesJson = redactSecrets(JSON.stringify(cp.messages), secrets)
  const redactedMessages = JSON.parse(messagesJson) as EngineMessage[]
  return {
    ...cp,
    system_prompt: redactedSystemPrompt,
    messages: redactedMessages,
  }
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
