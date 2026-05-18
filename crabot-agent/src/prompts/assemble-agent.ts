/**
 * 统一 Agent system prompt 装配函数。
 *
 * 装配顺序：
 *   [adminPersonality?] → 大脑身份 → [sceneProfile?] → 对话边界 →
 *   工作流（私聊/群聊）→ send_message 规范 → end_turn self-check →
 *   时间感知 → 信息查询指引 → 工具使用规范 → 任务推进硬约束 →
 *   记忆存储指引 → 收尾责任 → [skillListing?] → [subAgents?]
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-15-agent-unified-loop-redesign-design.md §3.1
 */

import {
  CRABOT_BRAIN_IDENTITY,
  SYSTEM_DIALOGUE_BOUNDARY,
  WORKFLOW_PRIVATE,
  WORKFLOW_GROUP,
  PLAN_AND_EXECUTE_GUIDE,
  SEND_MESSAGE_SPEC,
  END_TURN_SELF_CHECK,
  TIME_AWARENESS,
  INFO_QUERY_GUIDE,
  TOOL_USAGE,
  TASK_HARD_CONSTRAINTS,
  MEMORY_STORE_GUIDE,
  CLOSURE_DUTIES,
} from './agent-sections.js'

export interface AssembleAgentPromptOptions {
  readonly isGroup: boolean
  readonly adminPersonality?: string
  readonly sceneProfile?: { readonly label: string; readonly content: string }
  readonly skillListing?: string
  readonly availableSubAgents?: ReadonlyArray<{
    readonly toolName: string
    readonly workerHint: string
  }>
  readonly hasCodePlanner?: boolean
}

function escapeSceneProfileContent(content: string): string {
  return content.replace(/<\/scene_profile>/g, '&lt;/scene_profile&gt;')
}

export function assembleAgentPrompt(opts: AssembleAgentPromptOptions): string {
  const parts: string[] = []

  if (opts.adminPersonality) {
    parts.push(opts.adminPersonality)
  }

  parts.push(CRABOT_BRAIN_IDENTITY)

  if (opts.sceneProfile) {
    const escaped = escapeSceneProfileContent(opts.sceneProfile.content)
    parts.push(
      `## 场景画像\n<scene_profile label="${opts.sceneProfile.label}">\n${escaped}\n</scene_profile>`,
    )
  }

  parts.push(SYSTEM_DIALOGUE_BOUNDARY)
  parts.push(opts.isGroup ? WORKFLOW_GROUP : WORKFLOW_PRIVATE)

  if (opts.hasCodePlanner) {
    parts.push(PLAN_AND_EXECUTE_GUIDE)
  }

  parts.push(SEND_MESSAGE_SPEC)
  parts.push(END_TURN_SELF_CHECK)
  parts.push(TIME_AWARENESS)
  parts.push(INFO_QUERY_GUIDE)
  parts.push(TOOL_USAGE)
  parts.push(TASK_HARD_CONSTRAINTS)
  parts.push(MEMORY_STORE_GUIDE)
  parts.push(CLOSURE_DUTIES)

  if (opts.skillListing) {
    parts.push(opts.skillListing)
  }

  if (opts.availableSubAgents && opts.availableSubAgents.length > 0) {
    const list = opts.availableSubAgents
      .map(a => `- ${a.toolName}：${a.workerHint}`)
      .join('\n')
    parts.push(
      `## 可用的专项 Sub-agent\n\n` +
      `你可以将子任务委派给以下专项 Sub-agent，它们在独立上下文中执行，只返回最终结果：\n${list}\n\n` +
      `适合委派的场景：\n` +
      `1. 你的能力不足以完成某个子任务（如你没有视觉能力但需要分析图片）\n` +
      `2. 子任务的中间过程你不关心，只需要最终结果（避免污染你的上下文）`,
    )
  }

  return parts.join('\n\n')
}
