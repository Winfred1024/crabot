/**
 * TaskGoal 纯函数工具集。
 *
 * Phase 1：抽离状态机 / 校验 / 终态判断等无副作用逻辑，供 Phase 2 在 admin task
 * 数据层（set_task_goal / append_audit_entry / increment_tokens / complete_goal）复用。
 *
 * 不是 Manager 类——TaskGoal 是 Task 的子对象，没有独立的存储 / id / owner。
 * 所有状态变更都通过 Task 的 update 路径完成。
 *
 * spec: crabot-docs/superpowers/specs/2026-05-23-goal-mode-design.md §3
 */

import type {
  TaskGoal,
  TaskGoalStatus,
  AcceptanceCriterion,
  TaskGoalAuditEntry,
} from './types.js'

const TERMINAL_STATUSES: ReadonlySet<TaskGoalStatus> = new Set([
  'complete',
  'blocked',
  'budget_limited',
  'cleared',
])

export function isTerminal(status: TaskGoalStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/**
 * 状态机合法切换：
 *   active → 任意终态
 *   终态 → 同一终态（幂等）
 *   其余拒绝
 */
export function isValidTransition(from: TaskGoalStatus, to: TaskGoalStatus): boolean {
  if (from === to) return true
  if (from === 'active' && isTerminal(to)) return true
  return false
}

/** 校验 criterion 列表；不抛错则视为合法。 */
export function validateCriteria(criteria: AcceptanceCriterion[]): void {
  if (criteria.length === 0) {
    throw new Error('acceptance_criteria 至少需要 1 条（不接受模糊目标）')
  }
  const seen = new Set<string>()
  for (const c of criteria) {
    if (!c.id.trim()) throw new Error('AcceptanceCriterion.id 不能为空')
    if (seen.has(c.id)) throw new Error(`AcceptanceCriterion.id 重复：${c.id}`)
    seen.add(c.id)
    if (!c.spec.trim()) throw new Error(`AcceptanceCriterion ${c.id}: spec 不能为空`)
    if (!['cmd', 'file', 'semantic'].includes(c.kind)) {
      throw new Error(`AcceptanceCriterion ${c.id}: kind 非法（${c.kind}）`)
    }
    if (c.expect?.stdout_matches !== undefined) {
      try {
        new RegExp(c.expect.stdout_matches)
      } catch {
        throw new Error(`AcceptanceCriterion ${c.id}: stdout_matches 不是合法正则`)
      }
    }
  }
}

export interface CreateTaskGoalParams {
  objective: string
  acceptance_criteria: AcceptanceCriterion[]
  token_budget?: number
}

/**
 * 构造新的 TaskGoal 初值（不写入任何存储）。
 * 由 admin 的 set_task_goal 路径在通过 Task 更新时调用。
 */
export function buildNewTaskGoal(params: CreateTaskGoalParams, now: string): TaskGoal {
  if (!params.objective.trim()) {
    throw new Error('objective 不能为空')
  }
  validateCriteria(params.acceptance_criteria)
  if (params.token_budget !== undefined) {
    if (!Number.isFinite(params.token_budget) || params.token_budget <= 0) {
      throw new Error('token_budget 必须是正数')
    }
  }
  return {
    objective: params.objective,
    acceptance_criteria: params.acceptance_criteria,
    status: 'active',
    tokens_used: 0,
    ...(params.token_budget !== undefined ? { token_budget: params.token_budget } : {}),
    audit_history: [],
    created_at: now,
    updated_at: now,
  }
}

/** Audit 追加：最新的在前。仅 active goal 可追加；非 active 抛错。 */
export function appendAuditEntry(
  goal: TaskGoal,
  entry: TaskGoalAuditEntry,
  now: string,
): TaskGoal {
  if (goal.status !== 'active') {
    throw new Error(`TaskGoal 当前 status=${goal.status}，非 active 不可追加 audit 历史`)
  }
  return {
    ...goal,
    audit_history: [entry, ...goal.audit_history],
    updated_at: now,
  }
}

/**
 * Token 累加 + budget 超限自动切 budget_limited 终态。
 * - delta < 0 抛错
 * - 非 active goal 返回原 goal（noop，避免误用）
 */
export function incrementTokens(goal: TaskGoal, delta: number, now: string): TaskGoal {
  if (delta < 0) throw new Error('delta 必须 >= 0')
  if (goal.status !== 'active') return goal
  const tokens_used = goal.tokens_used + delta
  const shouldLimit = goal.token_budget !== undefined && tokens_used >= goal.token_budget
  return {
    ...goal,
    tokens_used,
    ...(shouldLimit
      ? { status: 'budget_limited' as const, completed_at: now }
      : {}),
    updated_at: now,
  }
}

/** 切换 goal 到终态；非法 transition 抛错。 */
export function transitionGoalStatus(
  goal: TaskGoal,
  to: TaskGoalStatus,
  now: string,
): TaskGoal {
  if (!isValidTransition(goal.status, to)) {
    throw new Error(`非法状态切换：${goal.status} → ${to}`)
  }
  if (goal.status === to) return goal
  return {
    ...goal,
    status: to,
    updated_at: now,
    ...(isTerminal(to) ? { completed_at: now } : {}),
  }
}

/**
 * 判断是否要把 goal 自动 transition 到 blocked：
 * 最近 N 次 audit 全 fail 且 failed_criteria 集合完全相同。
 *
 * 调用方：append_audit_entry 路径在拿到新 goal 后调本函数判断要不要再走一次 transitionGoalStatus。
 */
export function shouldAutoBlock(goal: TaskGoal, threshold: number): boolean {
  if (goal.audit_history.length < threshold) return false
  const recent = goal.audit_history.slice(0, threshold)
  if (recent.some((h) => h.pass)) return false
  const first = new Set(recent[0]!.failed_criteria)
  return recent.every((h) => setsEqual(new Set(h.failed_criteria), first))
}

/**
 * 连续 N 次 audit fail 且 failed_criteria 集合一致 → 自动 transition 到 blocked。
 *
 * 默认 N=3 平衡 legit retry（修了一处但漏看另一处） 与 token 浪费。
 *
 * Spec: 2026-05-23-goal-mode-design §3 / 2026-05-26-goal-audit-loop-completion §2.2
 */
export const TASK_GOAL_BLOCKED_THRESHOLD = 3

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}
