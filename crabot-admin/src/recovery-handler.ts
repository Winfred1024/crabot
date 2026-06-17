/**
 * Self-healing recovery 任务生成器
 *
 * Agent 模块意外重启后，把所有 status=executing 的非 recovery 任务标 failed，
 * 然后生成一条新的 recovery worker 任务，让 agent 自己用 search_traces 工具
 * 调研每条中断任务的实际进度，决定继续 / 记录 / 放弃。
 *
 * @see crabot-docs/protocols/protocol-admin.md "Recovery Task 约定"
 */

import type { CreateTaskParams, Task, TaskStatus } from './types.js'
import { applyDerivedFields } from './task-state-machine.js'

/**
 * Admin 重启后对磁盘上 loaded tasks 做的状态清扫。
 *
 * 触发场景：admin 进程死后重启（**不一定 agent 也重启**）。磁盘上仍写着
 * status='executing' 之类的"看起来在跑"的任务，但 admin 进程刚活过来，
 * 对应的 worker 进程内存状态早就丢了——任务对调用方而言就是僵尸。
 *
 * 处理：把所有"非终态、非 waiting_human"的任务一律标 failed。
 * waiting_human 在这条路径上是例外：admin 重启不代表 agent 也重启，agent 可能仍
 * 活着、其 worker loop 仍 parked 在 humanQueue 上，人类一回复就能正常 resume——
 * 此时标 failed 会误杀活着的 loop。故保留。
 * （agent **自己**重启时则相反：loop 必死，那条路径见 isAgentRestartStale，会把
 * waiting_human 一并标 failed。两条路径处理不同，勿混。）
 *
 * @returns 新数组 + 实际清扫了几条（用于日志）
 */
export function cleanupStaleInflightTasks(
  tasks: ReadonlyArray<Task>,
  nowISO: string,
): { tasks: Task[]; staleCount: number } {
  const STALE_INFLIGHT: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
    'pending',
    'planning',
    'executing',
  ])
  let staleCount = 0
  const next = tasks.map((task) => {
    if (!STALE_INFLIGHT.has(task.status)) return task
    staleCount++
    return applyDerivedFields(task, 'failed', nowISO, {
      error: task.error ?? 'admin_restarted_during_task',
    })
  })
  return { tasks: next, staleCount }
}

/**
 * agent 进程重启后，判断某 task 状态是否属于"依赖已死的 worker loop、需标 failed"的遗留态。
 *
 * agent 重启意味着内存里的 worker loop 全部销毁，对话状态没有落盘 checkpoint。因此：
 * - executing / waiting（等 async 子 agent）：loop 已死，僵尸，标 failed。
 * - waiting_human：loop 同样已死。它的 pending_question 留在 admin，但没有任何机制
 *   在重启后把 parked loop 拉回内存——dispatcher 仍把它列为 supplement 目标，
 *   而 pushSupplement 永远 hasActiveTask=false 兜底成 new_task。一律标 failed，
 *   既让状态诚实，也让它退出 dispatcher 的活跃任务集合（不再被误判成 supplement）。
 * - pending：还没被 worker 接走，无内存状态可丢，原样保留待重新调度。
 * - planning / 终态：维持既有行为，不在此扫除。
 *
 * 注意：仅适用于 **agent 重启** 路径。admin 单独重启时 agent 可能仍活着、loop 仍 parked，
 * 那条路径（cleanupStaleInflightTasks）必须继续保留 waiting_human。
 */
export function isAgentRestartStale(status: TaskStatus): boolean {
  return status === 'executing' || status === 'waiting' || status === 'waiting_human'
}

/**
 * 把 resume_task RPC 的结果按「成功 resume / 需要走 recovery 兜底」分流。
 *
 * 纯函数，方便单元测试。由 runSelfHealingForAgentRestart 调用。
 */
export function partitionResumeResults(
  results: ReadonlyArray<{ task: Task; resumed: boolean }>,
): { resumed: Task[]; needRecovery: Task[] } {
  const resumed: Task[] = []
  const needRecovery: Task[] = []
  for (const r of results) (r.resumed ? resumed : needRecovery).push(r.task)
  return { resumed, needRecovery }
}

/**
 * 构造 recovery 任务参数。
 *
 * @param executingTasks 当前所有 status=executing 的任务（含 recovery 标签的）
 * @param restartCount 本次 agent 启动是第几次（0 = 首次启动，>0 = 重启）
 * @param nowISO 当前时间 ISO 串，用于 recovery 任务的标题/描述
 *
 * @returns null 表示不需要 recovery（首次启动或没有非 recovery in-flight 任务）；
 *          否则返回 CreateTaskParams 直接传给 handleCreateTask。
 */
export function buildRecoveryTask(
  executingTasks: ReadonlyArray<Task>,
  restartCount: number,
  nowISO: string
): CreateTaskParams | null {
  // 首次启动不做 recovery（健康冷启动场景）
  if (restartCount <= 0) return null

  // 防雪崩：自带 'recovery' tag 的任务不再为之派生新 recovery
  const interrupted = executingTasks.filter((t) => !t.tags.includes('recovery'))
  if (interrupted.length === 0) return null

  const lines = interrupted.map((t) => {
    const startedAt = t.started_at ?? t.created_at
    return `- ${t.id}: ${t.title} (started ${startedAt})`
  })

  const initialMessageContent = [
    `[重启时间：${nowISO}]`,
    '',
    `你刚刚因故重启了。重启前有以下 ${interrupted.length} 条任务正在执行但被强制中断：`,
    '',
    ...lines,
    '',
    '请对每条任务：',
    '1. 用 search_traces / get_task_details 工具查实际进度',
    '2. 判断进度：「基本完成、只缺收尾」/「做到一半」/「刚开始」三类',
    '3. 如果有 master 在等结果（看 task source.session_id 是否还活着），先在该会话发一条状态消息',
    '4. 决定：继续推进 / 记录到 memory / 直接放弃，每条要有结论',
    '',
    '完成后给 master 一条汇总：哪些已恢复继续、哪些放弃、原因。',
  ].join('\n')

  return {
    title: `处理 agent 重启遗留的中断任务（${interrupted.length} 条）`,
    initial_message: { content: initialMessageContent },
    priority: 'high',
    source: {
      origin: 'system',
      trigger_type: 'auto',
    },
    tags: ['recovery'],
  }
}
