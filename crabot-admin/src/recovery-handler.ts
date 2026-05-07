/**
 * Self-healing recovery 任务生成器
 *
 * Agent 模块意外重启后，把所有 status=executing 的非 recovery 任务标 failed，
 * 然后生成一条新的 recovery worker 任务，让 agent 自己用 search_traces 工具
 * 调研每条中断任务的实际进度，决定继续 / 记录 / 放弃。
 *
 * @see crabot-docs/protocols/protocol-admin.md "Recovery Task 约定"
 */

import type { CreateTaskParams, Task } from './types.js'

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

  const description = [
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
    description,
    priority: 'high',
    source: {
      origin: 'system',
      trigger_type: 'auto',
    },
    tags: ['recovery'],
  }
}
