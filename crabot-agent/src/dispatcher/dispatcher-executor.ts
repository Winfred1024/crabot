/**
 * Dispatcher 动作执行器：按顺序执行 DispatchAction[]。
 *
 * 每个动作通过 ExecuteContext 注入的回调执行：
 * - supplement → pushSupplement 投递到 humanQueue
 * - new_task   → spawnAgentInstance 启动 agent 实例
 * - stay_silent → discard（无副作用）
 *
 * 单个动作失败 / supplement_fallback 不阻塞后续动作。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §3.4 §6
 */

import type { DispatchAction, ExecuteContext } from './dispatcher-types.js'

export async function executeDispatchActions(
  actions: ReadonlyArray<DispatchAction>,
  ctx: ExecuteContext,
): Promise<void> {
  for (const action of actions) {
    try {
      if (action.kind === 'supplement') {
        const outcome = await ctx.pushSupplement(action.target_task_id, action.text)
        if (outcome === 'fallback') {
          console.warn(
            `[dispatcher-executor] supplement_fallback: target_task_id=${action.target_task_id} not in agent activeTasks`,
          )
        }
      } else if (action.kind === 'new_task') {
        await ctx.spawnAgentInstance(action.text)
      } else if (action.kind === 'stay_silent') {
        // 无副作用——attention scheduler 通过"是否有非 stay_silent 动作"判断退避
      }
    } catch (err) {
      console.error(
        `[dispatcher-executor] action ${action.kind} failed (continuing):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}
