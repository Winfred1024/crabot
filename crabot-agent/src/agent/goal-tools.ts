/**
 * set_task_goal 工具：worker 在动手前调，把"完成承诺"写到 task.goal。
 *
 * - 一旦写入不可由 agent 自改（admin 端 RPC handler 拒绝二次 set）
 * - 调 todo 工具前必须先调本工具（todo 工具入口加了 hasGoal 门控，Task 9 落地）
 * - end_turn 时引擎自动触发独立 audit subagent 对照 acceptance_criteria 验证
 *
 * spec: 2026-05-23-goal-mode-design.md §7.3
 */

import type { ToolDefinition } from '../engine/types.js'

export interface SetTaskGoalDeps {
  /** 当前 task id（worker 启动时绑定） */
  readonly taskId: string
  /** 调 admin RPC 的入口（注入：agent-handler 里现有 rpcClient.call(adminPort, ...) 封装） */
  readonly callAdminRpc: <T = unknown>(method: string, params: unknown) => Promise<T>
  /**
   * 本任务是否已设过 goal。重设已有 goal = 改方向，需先持有一张"改目标券"。
   * 缺省 → 不门控（向后兼容 / 无 goal-mode 上下文的测试）。
   */
  readonly hasExistingGoal?: () => boolean
  /** 是否持有"改目标券"。券由人类 supplement 到达时发放（上限 1，不叠加）。 */
  readonly hasRevisionToken?: () => boolean
  /** 消费一张"改目标券"。仅在重设成功后调用。 */
  readonly consumeRevisionToken?: () => void
  /**
   * 重设 goal 成功后调用：abort 当前 audit subagent + 清 outboundBuffer + 推 audit_aborted marker。
   * 缺省 → 不门控（向后兼容 / 无 audit 上下文的测试）。
   * spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.7
   */
  readonly abortAudit?: (reason: string) => void
}

const TOOL_DESCRIPTION = `在动手前写下本任务的工作计划与自验承诺。**复杂任务（≥2 个独立动作 / 跨多 turn / 用户明确说"确保 X""完成 Y 后通知我"）必须先调本工具。**

acceptance_criteria 是**你的自验计划**——你打算用什么方式证明自己做完了。注意：交付的判决标准是**人类的原始请求**（原话），不是你写的 criteria——计划写得再窄也挡不住审计按人类原话验收，所以照实写、写全。

调用本工具后：
- 你的计划锁定到 task.goal，不可由你自己修改
- 之后可以调 todo 工具拆步骤（todo 工具被门控：没目标拒绝调用）
- send_message(intent='info') 完成交付后 end_turn，系统会自动跑独立审计员：以人类原始请求为标准验收，你的 criteria 作为取证线索（cmd/file 类会被实际执行）
- 审计未通过 → 下一轮你会拿到详细缺口报告

简单任务（直接问答 / 一次工具调用即可）**不必**调本工具，直接 send_message(intent='info') 后 end_turn 即可，无 goal 不触发审计。

acceptance_criteria 至少 1 条，每条结构：
- id: 短 id（如 c-typecheck），audit 报告里用来定位
- kind: cmd | file | semantic
- spec: kind=cmd 时是命令（写成可直接执行的）；kind=file 时是路径；kind=semantic 时是自然语言验证标准
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
          minimum: 1,
          description: '可选预算（必须 >0）；不填则无限制（默认）。超过则目标进入 budget_limited 终态（系统强制收尾）。',
        },
      },
      required: ['objective', 'acceptance_criteria'],
      additionalProperties: false,
    },
    call: async (input) => {
      // 改方向门控：已设过 goal 时，重设需先持有一张人类授权的"改目标券"。
      // 无券拒绝 = 反 specification-gaming（worker 不得自行把目标改小）。
      const isReset = deps.hasExistingGoal?.() ?? false
      if (isReset && !(deps.hasRevisionToken?.() ?? false)) {
        return {
          output:
            'set_task_goal: 目标已设定，你不能自行修改。只有在收到人类的新指示后才允许重设——' +
            '若人类改变了要求，请等其消息到达、确认意图后再调本工具。',
          isError: true,
        }
      }
      // LLM 偶尔会传 0 / 负数 / NaN，admin 会硬拒抛 "token_budget 必须是正数"
      // 浪费一整轮 turn。这里 sanitize：无效值视同未传（协议允许缺省）。
      const tb = input.token_budget
      const validTokenBudget = (typeof tb === 'number' && Number.isFinite(tb) && tb > 0) ? tb : undefined
      try {
        await deps.callAdminRpc('set_task_goal', {
          task_id: deps.taskId,
          objective: input.objective,
          acceptance_criteria: input.acceptance_criteria,
          ...(validTokenBudget !== undefined ? { token_budget: validTokenBudget } : {}),
        })
        // 重设成功才消费券（admin RPC 抛错则券留待重试）。
        if (isReset) deps.consumeRevisionToken?.()
        // 改 goal 成功 → abort 当前 audit（针对的是旧 goal，已无意义）+ 清 outboundBuffer。
        // 首次设 goal 时也调，no-op（无 activeAuditId）。abort 失败不阻塞工具返回。
        // spec: 2026-06-07-goal-audit-async-buffered-info-design.md §4.7
        try {
          deps.abortAudit?.('goal_revised')
        } catch (err) {
          console.warn('[set_task_goal] abortAudit failed:', err instanceof Error ? err.message : String(err))
        }
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
