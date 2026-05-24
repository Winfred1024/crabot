/**
 * goal_auditor subagent 专属工具：submit_audit_result。
 *
 * 设计动机：auditor 早期通过 free-text emit "AUDIT_RESULT: pass|fail / FAILED_CRITERIA: [...]"
 * 由 runGoalAudit 端 regex parse。这种"prompt 让 LLM 按格式 emit + 服务端 regex 解析"
 * 是 LLM 协议反模式（脆、易被 quote/example 污染、被 JSON 包裹时解不出）。
 *
 * 改成 LLM tool call / function calling 标准做法：auditor 调本工具，schema 强制
 * pass/failed_criteria/evidence 三字段，crabot engine 用 exitsLoop 立即退 loop，
 * caller 从 EngineResult.exitToolCall.input 拿到结构化判决，零 parse 成本。
 *
 * spec: 2026-05-23-goal-mode-design.md §6（goal_auditor builtin）
 */

import type { ToolDefinition } from '../engine/types.js'

export const SUBMIT_AUDIT_RESULT_TOOL_NAME = 'submit_audit_result'

/** 工具 input schema 反映出的判决数据；caller 解 exitToolCall.input 后转成此类型。 */
export interface SubmitAuditResultInput {
  /** 整体判决：所有 acceptance_criteria 都通过 = true；任一条不通过 = false */
  pass: boolean
  /** 失败的 criterion id 列表；pass=true 时应为空数组 */
  failed_criteria: string[]
  /** 逐条核对的证据汇总（markdown）；含每条 criterion 用了什么工具采到的什么证据 + 判定理由 */
  evidence: string
}

const TOOL_DESCRIPTION = `提交本次审计的最终判决。**调用本工具即结束审计**（不要再调其它工具）。

**必须**通过本工具收尾审计；用 free-text emit "AUDIT_RESULT: ..." 不算数（外层不解析）。

参数：
- pass: 所有 acceptance_criteria 都通过 = true；任一条不通过 = false。拿不准 → false。
- failed_criteria: 未通过的 criterion id 列表（pass=true 时空数组）
- evidence: 逐条核对的 markdown，每条说清楚"用了什么工具 / 采到的证据片段 / 判定结果"。worker 续作时会看这份证据。

不调本工具就 silent end_turn → 视为审计员故障，整体当 fail 处理。`

export function createSubmitAuditResultTool(): ToolDefinition {
  return {
    name: SUBMIT_AUDIT_RESULT_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    isReadOnly: true,
    exitsLoop: true,
    inputSchema: {
      type: 'object',
      properties: {
        pass: {
          type: 'boolean',
          description: '整体判决；所有 criterion 都通过才 true',
        },
        failed_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: '失败的 criterion id 列表；pass=true 时空数组',
        },
        evidence: {
          type: 'string',
          description: '逐条核对的 markdown 证据汇总',
        },
      },
      required: ['pass', 'failed_criteria', 'evidence'],
      additionalProperties: false,
    },
    // exitsLoop=true 时引擎不实际调用 call，直接退 loop 把 input 写到
    // EngineResult.exitToolCall。这个 stub 仅为 ToolDefinition 类型必填字段。
    call: async () => ({ output: 'audit result submitted', isError: false }),
  }
}
