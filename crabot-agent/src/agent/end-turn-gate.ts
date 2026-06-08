/**
 * createAsyncAuditEndTurnGate — engine endTurnGate 闭包工厂（异步派 audit 路径）。
 *
 * 与旧的 runGoalAudit-同步阻塞 版本的区别：
 *  - 旧：闭包 await runGoalAudit → 10-30s 阻塞 main loop
 *  - 新：闭包 spawnAuditSubagent → 立即返回 audit_id，注入 [audit_pending] marker → 续 turn 不真 end_turn
 *
 * 闭包行为（spec 2026-06-07-goal-audit-async-buffered-info-design.md §4.3）：
 *  1. goalSetCache=false（worker 尚未 set_task_goal）→ null（透明放行）
 *  2. outboundBuffer 空 → null（无 final 待审；讨论型/进度型场景已 flush）
 *  3. 拿 goal（admin get_task RPC）；缺失/RPC 挂 → null（fail-open）
 *  4. spawnAuditSubagent → 设 taskState.activeAuditId → 返回 [audit_pending] marker
 *  5. spawn 抛错 → null（fail-open，console.warn 记录）
 *
 * runGoalAudit 保留不动，未来如需 sync fallback / 兼容旧路径仍可用。
 */

import { buildAuditPendingMarker } from './audit-result-marker.js'
import { spawnAuditSubagent, type SpawnAuditSubagentDeps } from './audit-spawn.js'
import type { GoalAuditTaskGoal } from './goal-audit.js'
import type { RpcClient } from 'crabot-shared'
import type { WorkerTaskState } from '../types.js'

export interface AsyncAuditEndTurnGateDeps {
  /** 任务 ID — admin RPC 查 goal 用 + 透传给 spawnAuditSubagent。 */
  readonly taskId: string
  /** 任务状态对象 — 读 outboundBuffer 判定 passthrough，写 activeAuditId 标等审态。 */
  readonly taskState: WorkerTaskState

  /** worker 是否已 set_task_goal —— set_task_goal 工具路径会同步更新外部 cache。 */
  readonly goalSetCacheGetter: () => boolean

  /** admin get_task RPC 三件套（取当前 goal）。 */
  readonly rpcClient: Pick<RpcClient, 'call'>
  readonly moduleId: string
  readonly getAdminPort: () => Promise<number>

  /** 透传给 spawnAuditSubagent 的所有非闭包内可解析的依赖。
   *  audit subagent 的 goal 字段在闭包内 RPC 取得后覆盖，这里不用传。 */
  readonly buildSpawnDeps: (goal: GoalAuditTaskGoal) => SpawnAuditSubagentDeps

  /**
   * 测试 hook：注入 mock spawnAuditSubagent 控制 audit_id 返回 / 抛错时序。
   * 默认走真 spawnAuditSubagent。
   */
  readonly spawnAuditSubagentFn?: typeof spawnAuditSubagent
}

/**
 * 构造 engine endTurnGate 闭包 — 异步派 audit + 注入 [audit_pending] marker。
 *
 * 闭包签名：`() => Promise<string | null>`
 *  - 返回 string：engine 把这段文本作为 user message 注入下一轮（worker 不真 end_turn）
 *  - 返回 null：engine 放行 end_turn（含 flush outboundBuffer）
 */
export function createAsyncAuditEndTurnGate(
  deps: AsyncAuditEndTurnGateDeps,
): () => Promise<string | null> {
  const spawn = deps.spawnAuditSubagentFn ?? spawnAuditSubagent

  return async () => {
    // 1. 工作态门控：worker 尚未 set_task_goal → 没东西要审 → 透明放行
    if (!deps.goalSetCacheGetter()) return null

    // 2. 空 buffer 走 passthrough — 讨论型/进度型场景已 flush，无 final 待审
    if (deps.taskState.outboundBuffer.length === 0) return null

    // 3. 拿 goal（闭包触发时 RPC，保证拿到最新值；set_task_goal 改 goal 后立刻生效）
    let goal: GoalAuditTaskGoal
    try {
      const adminPort = await deps.getAdminPort()
      const taskResp = await deps.rpcClient.call<
        { task_id: string },
        { task: { id: string; goal?: GoalAuditTaskGoal } }
      >(adminPort, 'get_task', { task_id: deps.taskId }, deps.moduleId)
      if (!taskResp.task.goal) {
        // goalModeEnabled + goalSetCache=true 才进得了这条 gate；理论上不该没 goal。
        // 防御：缺失 → fail-open。
        return null
      }
      goal = taskResp.task.goal
    } catch (err) {
      console.warn(
        '[endTurnGate] get_task RPC failed open:',
        err instanceof Error ? err.message : String(err),
      )
      return null
    }

    // 4. 异步派 audit subagent — 立即拿 audit_id（不等 audit 完成）
    let auditId: string
    try {
      auditId = await spawn(deps.buildSpawnDeps(goal))
    } catch (err) {
      console.warn(
        '[endTurnGate] spawn audit failed open:',
        err instanceof Error ? err.message : String(err),
      )
      return null
    }

    // 5. 标记等审态 — send_message handler / drain / wait_for_signal 用这个判
    deps.taskState.activeAuditId = auditId

    // 6. 注入 [audit_pending] marker — 续 turn 让 worker 看到 + 调 wait_for_signal
    return buildAuditPendingMarker({ auditId })
  }
}
