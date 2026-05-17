/**
 * PromptManager - 统一提示词管理
 *
 * 所有提示词在此文件中以常量维护，不再读写外部 .md 文件。
 * 唯一的外部输入是 Admin 配置中的 system_prompt（adminPersonality）。
 *
 * 组装顺序: adminPersonality（可选）+ 产品自我认知 + 角色规则 + 能力注入（可选）
 */

import type { ChannelMessage } from './types.js'
import type { SenderIdentity } from './utils/sender-identity.js'
import { formatChannelMessageTime, formatRelativeTime } from './utils/time.js'
import { formatMessageContent } from './agent/media-resolver.js'
import {
  assembleAgentPrompt as assembleAgentPromptImpl,
  type AssembleAgentPromptOptions,
} from './prompts/assemble-agent.js'

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 统一渲染 channel 历史消息为 XML <message> 标签。
 * 输出格式：<message ts="HH:MM" from="sender" identity="..." [media="..."] [mention="@you"]>\n内容\n</message>
 * 内容超过 maxLen 时截断并附 `...[内容截断]`。
 */
export function formatChannelMessageLine(
  msg: ChannelMessage,
  opts: { timezone: string; now?: Date; maxLen?: number; mentionMark?: boolean; identity: SenderIdentity },
): string {
  const { timezone, now, maxLen = 2000, mentionMark = false, identity } = opts
  const sender = msg.sender.platform_display_name
  const time = msg.platform_timestamp
    ? formatChannelMessageTime(msg.platform_timestamp, timezone, now ?? new Date())
    : ''
  const fullText = formatMessageContent(msg)
  const truncated = fullText.length > maxLen ? fullText.slice(0, maxLen) + '...[内容截断]' : fullText
  const escaped = truncated.replace(/<\/message>/g, '&lt;/message&gt;')
  const mediaAttr = msg.content.type !== 'text' ? ` media="${msg.content.type}"` : ''
  const mentionAttr = mentionMark && msg.features.is_mention_crab ? ' mention="@you"' : ''
  return `<message ts="${time}" from="${escapeAttr(sender)}" identity="${identity}"${mediaAttr}${mentionAttr}>\n${escaped}\n</message>`
}

/**
 * 渲染单条短期记忆条目。
 * 输出格式：`- [<相对时间>] (channel=X, session=Y, task=Z) <content 截断>`
 * source 字段尽量给齐：让 LLM 跨 session 解析指代时能直接 cite 到具体的 channel/session。
 */
export function formatShortTermMemoryLine(
  entry: import('./types.js').ShortTermMemoryEntry,
  opts: { timezone: string; now?: Date; maxLen?: number },
): string {
  const { timezone, now, maxLen = 500 } = opts
  const rel = formatRelativeTime(entry.event_time, timezone, now ?? new Date())
  const stamp = rel ? `[${rel}]` : ''
  const sourceParts: string[] = []
  if (entry.source.channel_id) sourceParts.push(`channel=${entry.source.channel_id}`)
  if (entry.source.session_id) sourceParts.push(`session=${entry.source.session_id}`)
  const taskId = entry.refs?.task_id
  if (taskId) sourceParts.push(`task=${taskId}`)
  const sourceTag = sourceParts.length > 0 ? ` (${sourceParts.join(', ')})` : ''
  const fullText = entry.content
  const text = fullText.length > maxLen ? fullText.slice(0, maxLen) + '...[内容截断]' : fullText
  return `- ${stamp}${sourceTag}: ${text}`
}

export class PromptManager {
  /**
   * 组装统一 Agent system prompt。
   * 装配顺序由 src/prompts/assemble-agent.ts 控制。
   *
   * Spec: crabot-docs/superpowers/specs/2026-05-15-agent-unified-loop-redesign-design.md
   */
  assembleAgentPrompt(opts: AssembleAgentPromptOptions): string {
    return assembleAgentPromptImpl(opts)
  }
}
