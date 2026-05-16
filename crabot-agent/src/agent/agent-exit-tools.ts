/**
 * 统一 Agent loop 的早退工具集合。
 *
 * - supplement_task: 当前消息是某个活跃任务的纠偏/补充。仅 turn 0 可调，调完退出 loop。
 * - stay_silent: 群聊中消息与自己无关。仅 turn 0 可调，调完退出 loop。
 *
 * 工具定义带 `turnZeroOnly: true` + `exitsLoop: true` 两个 metadata，
 * 引擎据此强制约束。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-15-agent-unified-loop-redesign-design.md §2.2 / §4.2
 */

import type { ToolDefinition } from '../engine/types.js'

const NOOP_CALL = async () => ({ output: '', isError: false as const })

export function supplementTaskTool(activeTaskIds: readonly string[]): ToolDefinition {
  return {
    name: 'supplement_task',
    description:
      '当前消息是某个活跃任务的纠偏或补充——而不是一个新需求。' +
      '调用此工具后引擎自动结束本 loop，调用方会把 supplement_text 传给目标任务。' +
      '仅允许在本次消息的 turn 0 调用：进入后续主工作流后，即使发现"原来是 supplement"，' +
      '也不允许再退出（已有副作用没法回滚）。',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target_task_id: {
          type: 'string',
          enum: [...activeTaskIds],
          description: '目标任务 ID，必须是当前活跃任务列表中的一个。',
        },
        supplement_text: {
          type: 'string',
          description: '提炼后的补充/纠偏内容，会被传给目标任务。',
        },
      },
      required: ['target_task_id', 'supplement_text'],
    },
    isReadOnly: true,
    turnZeroOnly: true,
    exitsLoop: true,
    call: NOOP_CALL,
  }
}

export const STAY_SILENT_TOOL: ToolDefinition = {
  name: 'stay_silent',
  description:
    '群聊中消息与自己无关时使用——例如群成员之间的讨论、系统通知、分享链接等。' +
    '调用后引擎结束 loop，不会向人类发送任何消息。仅 turn 0 可调。' +
    '注意：被 @你 标注、上下文只有发送者和你、或你之前的消息被引用时，禁止 stay_silent。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      reason: {
        type: 'string',
        description: '【可选】简短说明为何静默（如"群成员互相讨论"），便于 trace 复盘。',
      },
    },
    required: [],
  },
  isReadOnly: true,
  turnZeroOnly: true,
  exitsLoop: true,
  call: NOOP_CALL,
}

/**
 * 装配早退工具集。
 *
 * - 群聊：始终包含 stay_silent；若有活跃任务则加 supplement_task
 * - 私聊：不含 stay_silent；若有活跃任务则加 supplement_task
 */
export function getAgentExitTools(opts: {
  readonly isGroup: boolean
  readonly activeTaskIds: readonly string[]
}): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  if (opts.activeTaskIds.length > 0) {
    tools.push(supplementTaskTool(opts.activeTaskIds))
  }
  if (opts.isGroup) {
    tools.push(STAY_SILENT_TOOL)
  }
  return tools
}
