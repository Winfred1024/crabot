/**
 * set_task_goal 工具：worker 在动手前调，把"完成承诺"写到 task.goal。
 *
 * - 一旦写入不可由 agent 自改（admin 端 RPC handler 拒绝二次 set）
 * - 调 todo 工具前必须先调本工具（todo 工具入口加了 hasGoal 门控，Task 9 落地）
 * - send_message(intent='final') 触发独立 audit subagent 对照 acceptance_criteria 验证（Task 8 落地）
 *
 * spec: 2026-05-23-goal-mode-design.md §7.3
 */

import type { ToolDefinition } from '../engine/types.js'

export interface SetTaskGoalDeps {
  /** 当前 task id（worker 启动时绑定） */
  readonly taskId: string
  /** 调 admin RPC 的入口（注入：agent-handler 里现有 rpcClient.call(adminPort, ...) 封装） */
  readonly callAdminRpc: <T = unknown>(method: string, params: unknown) => Promise<T>
}

const TOOL_DESCRIPTION = `在动手前写下本任务的完成承诺。**复杂任务（≥2 个独立动作 / 跨多 turn / 用户明确说"确保 X""完成 Y 后通知我"）必须先调本工具。**

调用本工具后：
- 你的承诺锁定到 task.goal，不可由你自己修改
- 之后可以调 todo 工具拆步骤（todo 工具被门控：没目标拒绝调用）
- send_message(intent='final') 时系统会自动跑独立审计员对照你写下的 acceptance_criteria 验证证据
- 审计未通过 → 工具返回错误 + 下一轮你会拿到详细缺口报告

简单任务（直接问答 / 一次工具调用即可）**不必**调本工具，直接 send_message(intent='final') 即可，audit gate 透明放行。

acceptance_criteria 至少 1 条，每条结构：
- id: 短 id（如 c-typecheck），audit 报告里用来定位
- kind: cmd | file | semantic
- spec: kind=cmd 时是命令；kind=file 时是路径；kind=semantic 时是自然语言验证标准
- expect?: { exit_code?, stdout_contains?, stdout_matches? }（cmd/file 用）
- rationale?: 给 auditor 看的解释`

export function createSetTaskGoalTool(deps: SetTaskGoalDeps): ToolDefinition {
  return {
    name: 'set_task_goal',
    description: TOOL_DESCRIPTION,
    isReadOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: '自然语言目标描述。喂给你（worker prompt）也喂给 auditor。',
        },
        acceptance_criteria: {
          type: 'array',
          description: '完成条件，每条独立验证；至少 1 条',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              kind: { type: 'string', enum: ['cmd', 'file', 'semantic'] },
              spec: { type: 'string' },
              expect: {
                type: 'object',
                properties: {
                  exit_code: { type: 'number' },
                  stdout_contains: { type: 'string' },
                  stdout_matches: { type: 'string' },
                },
                additionalProperties: false,
              },
              rationale: { type: 'string' },
            },
            required: ['id', 'kind', 'spec'],
            additionalProperties: false,
          },
          minItems: 1,
        },
        token_budget: {
          type: 'number',
          description: '可选预算；超过则目标进入 budget_limited 终态（系统强制收尾）',
        },
      },
      required: ['objective', 'acceptance_criteria'],
      additionalProperties: false,
    },
    call: async (input) => {
      try {
        await deps.callAdminRpc('set_task_goal', {
          task_id: deps.taskId,
          objective: input.objective,
          acceptance_criteria: input.acceptance_criteria,
          ...(input.token_budget !== undefined ? { token_budget: input.token_budget } : {}),
        })
        return {
          output: 'set_task_goal: ok。你的承诺已写入 task.goal。现在可以调 todo 拆步骤或直接干活。',
          isError: false,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `set_task_goal: ${msg}`, isError: true }
      }
    },
  }
}
