/**
 * wait_for_signal 工具：通用挂起原语。
 *
 * 适用场景：
 * 1) worker 派出了 async subagent（delegate_task），此刻没有别的事可干；
 * 2) 系统注入 [audit_pending]，告知 worker 有审计正在跑；
 * 3) 任意"我没事干、等通知"场景。
 *
 * 实现：复用 humanQueue.setBarrier 机制（跟 ask_human 同一套 barrier 路径）。
 * 任何 humanQueue.push（subagent 完成 / 用户补充 / 系统结果）会自动 clearBarrier 唤醒 worker。
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 2
 */

import { z } from 'zod'
import type { HumanMessageQueue } from '../engine/human-message-queue.js'
import type { ToolCallContext, ToolDefinition, ToolCallResult } from '../engine/types.js'

/**
 * 兜底超时：跟 ASK_HUMAN_BARRIER_TIMEOUT_MS 一致（24 小时）。
 * Agent 不感知此 timeout——只要有 push 就会被 clearBarrier 唤醒。
 */
export const WAIT_FOR_SIGNAL_TIMEOUT_MS = 24 * 60 * 60 * 1000

export interface WaitForSignalDeps {
  readonly humanQueue: HumanMessageQueue
  readonly hasActiveAudit: () => boolean
  readonly hasActiveAsyncSubagent: () => boolean
}

const inputSchema = z.object({
  reason: z.string().describe('挂起原因（trace 可读），如 "等 code_writer 完成"'),
})

const TOOL_DESCRIPTION =
  '挂起当前任务，等待外部异步事件唤醒。适用场景：' +
  '1) 你派出了 async subagent（delegate_task）没有别的事可干；' +
  '2) 系统注入 [audit_pending] 告知你有审计正在跑；' +
  '3) 任意"我没事干、等通知"场景。' +
  '任何 humanQueue push（subagent 完成 / 用户补充指示 / 系统结果）都会唤醒你。' +
  '当前确实有 pending 异步事件才调；滥用会被工具拒绝。'

export function createWaitForSignalTool(deps: WaitForSignalDeps): ToolDefinition {
  return {
    name: 'wait_for_signal',
    description: TOOL_DESCRIPTION,
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '挂起原因（trace 可读）' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    call: async (rawInput: Record<string, unknown>, _context: ToolCallContext): Promise<ToolCallResult> => {
      const parseResult = inputSchema.safeParse(rawInput)
      if (!parseResult.success) {
        return { isError: true, output: `invalid input: ${parseResult.error.message}` }
      }

      const hasPending = deps.humanQueue.hasPending
      const hasAudit = deps.hasActiveAudit()
      const hasSubagent = deps.hasActiveAsyncSubagent()

      if (!hasPending && !hasAudit && !hasSubagent) {
        return {
          isError: true,
          output:
            '当前无 pending 异步事件（无 audit / async subagent / queue 消息），不要滥用 wait_for_signal。' +
            '请继续调用其他工具或 end_turn。',
        }
      }

      deps.humanQueue.setBarrier(WAIT_FOR_SIGNAL_TIMEOUT_MS)
      return {
        isError: false,
        output: `已挂起等待 (${parseResult.data.reason})；下次 push 唤醒后继续。`,
      }
    },
  }
}
