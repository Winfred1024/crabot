/**
 * Goal slash 业务逻辑：task 短前缀解析 + 三条 slash 话术格式化。
 *
 * 调用方（admin handleChannelMessage / handleGoalShowSlash etc.）已经做完
 * master 鉴权 + prefix 路由分发；本模块只关心：拿到 task-id 短前缀 + active task
 * 列表，给出该回什么话术。
 *
 * Spec: 2026-05-25-goal-slash-commands-design.md §4 / §5.2
 */

import type { Task, TaskGoalStatus } from './types.js'

const MIN_PREFIX_LEN = 4

export type ResolveResult =
  | { kind: 'invalid-input'; reason: string }
  | { kind: 'not-found' }
  | { kind: 'found'; task: Task }
  | { kind: 'ambiguous'; candidates: Task[] }

export function resolveTaskByShortIdPrefix(
  prefix: string,
  tasks: ReadonlyArray<Task>,
): ResolveResult {
  if (prefix.length < MIN_PREFIX_LEN) {
    return { kind: 'invalid-input', reason: `task-id 短前缀至少 ${MIN_PREFIX_LEN} 字符` }
  }
  const inputStripped = stripSemanticPrefix(prefix)
  const matched = tasks.filter((t) =>
    stripSemanticPrefix(t.id).startsWith(inputStripped),
  )
  if (matched.length === 0) return { kind: 'not-found' }
  if (matched.length === 1) return { kind: 'found', task: matched[0]! }
  return { kind: 'ambiguous', candidates: matched }
}

/**
 * 剥离 task id 开头的语义前缀（如 `trigger-` / `recovery-` / `manual-`），
 * 让短 id 显示和短前缀匹配都基于真正有区分度的 UUID 部分。
 *
 * 正则匹配"小写字母段 + 短划线"且后面紧跟 hex 字符，避免把纯 UUID
 * （如 `a2bde067-...`）误判为有前缀（UUID 首段含数字不是纯字母）。
 */
function stripSemanticPrefix(id: string): string {
  return id.replace(/^[a-z]+-(?=[a-f0-9])/, '')
}

function shortId(id: string): string {
  return stripSemanticPrefix(id).slice(0, 8)
}

function objectivePreview(task: Task, max = 60): string {
  const obj = task.goal?.objective ?? task.title ?? '(no objective)'
  return obj.length > max ? `${obj.slice(0, max)}...` : obj
}

function bulletTask(task: Task): string {
  const status = task.goal?.status ?? '(无 goal)'
  return `- ${shortId(task.id)} (${status})  objective: "${objectivePreview(task)}"`
}

/** /目标 <id>：完整 goal 展示 */
export function formatGoalShowResponse(input: string, task: Task): string {
  const goal = task.goal!
  const lines: string[] = []
  lines.push(`[系统响应 /目标 ${input}]`)
  lines.push(`task: ${shortId(task.id)}... ("${task.title ?? ''}")`)
  lines.push(`status: ${goal.status}`)
  lines.push(`objective: ${goal.objective}`)
  lines.push(`acceptance_criteria:`)
  for (const c of goal.acceptance_criteria) {
    lines.push(`  - ${c.id} (${c.kind}): ${c.spec}`)
  }
  const budgetSeg = goal.token_budget != null ? ` / budget ${goal.token_budget}` : ''
  lines.push(`tokens_used: ${goal.tokens_used}${budgetSeg}`)
  if (goal.audit_history.length > 0) {
    lines.push(`audit_history（最近 3 条）:`)
    for (const h of goal.audit_history.slice(0, 3)) {
      const verdict = h.pass ? 'pass' : 'fail'
      const failed = h.failed_criteria.length > 0 ? ` [${h.failed_criteria.join(', ')}]` : ''
      lines.push(`  - ${verdict}${failed} @ ${h.at}`)
    }
  }
  return lines.join('\n')
}

/** /目标 <id>：task 找不到（兼带候选 = 当前 channel active task 列表） */
export function formatGoalShowNotFound(input: string, candidates: ReadonlyArray<Task>): string {
  const lines: string[] = []
  lines.push(`[系统响应 /目标 ${input}]`)
  lines.push(`错误：未找到 task ${input}（短 ID 前缀匹配无果）。`)
  if (candidates.length > 0) {
    lines.push(`当前 channel active task：`)
    for (const t of candidates) lines.push(bulletTask(t))
  } else {
    lines.push(`当前 channel 无 active task。`)
  }
  return lines.join('\n')
}

/** /目标 <id>：task 找到但无 goal */
export function formatGoalShowNoGoal(input: string, task: Task): string {
  return [
    `[系统响应 /目标 ${input}]`,
    `task ${shortId(task.id)}... 该 task 没有 goal（worker 未调过 set_task_goal）。`,
  ].join('\n')
}

/** /清除目标 <id>：成功 */
export function formatGoalClearResponse(input: string, taskId: string): string {
  return [
    `[系统响应 /清除目标 ${input}]`,
    `已清除 task ${shortId(taskId)}... 的 goal。worker 下一轮会拿到 cleared 状态。`,
  ].join('\n')
}

/** /清除目标 <id>：goal 已在终态 */
export function formatGoalClearAlreadyTerminal(input: string, status: TaskGoalStatus): string {
  return [
    `[系统响应 /清除目标 ${input}]`,
    `该 task 的 goal 当前 status=${status}，已是终态不可清除。`,
  ].join('\n')
}

/** /清除目标 <id>：≥2 匹配 */
export function formatGoalClearAmbiguous(input: string, candidates: ReadonlyArray<Task>): string {
  const lines: string[] = []
  lines.push(`[系统响应 /清除目标 ${input}]`)
  lines.push(`多个 task 匹配前缀 ${input}：`)
  for (const t of candidates) lines.push(bulletTask(t))
  lines.push(`请用更长的前缀重新发起。`)
  return lines.join('\n')
}

/** /目标列表 */
export function formatGoalListResponse(tasks: ReadonlyArray<Task>): string {
  const lines: string[] = [`[系统响应 /目标列表]`]
  if (tasks.length === 0) {
    lines.push(`当前渠道无 active task。`)
    return lines.join('\n')
  }
  lines.push(`当前渠道 active task：`)
  for (const t of tasks) lines.push(bulletTask(t))
  return lines.join('\n')
}

/** /目标 或 /清除目标（漏 id）的引导话术 */
export function formatMissingIdResponse(
  command: '/目标' | '/清除目标',
  tasks: ReadonlyArray<Task>,
): string {
  const lines: string[] = []
  lines.push(`[系统响应 ${command}]`)
  lines.push(`缺少 task-id 参数。用法：${command} <task-id>`)
  if (tasks.length > 0) {
    lines.push(`当前 channel active task：`)
    for (const t of tasks) lines.push(bulletTask(t))
  } else {
    lines.push(`当前 channel 无 active task。`)
  }
  return lines.join('\n')
}
