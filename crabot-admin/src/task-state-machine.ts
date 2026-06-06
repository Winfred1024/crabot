/**
 * Task 状态机：合法状态转换表。
 *
 * 后续 task（同一 plan 内）会在本文件追加 applyDerivedFields / assertTaskInvariants
 * / repairTaskInvariants，并由 AdminModule.applyStatusTransition 统一调度。
 */

import type { Task, TaskStatus } from './types.js'

// 与 index.ts:4355 旧 validTransitions 的差异：新增 pending → failed。
// 承认 admin 启动期 cleanupStaleInflightTasks 把磁盘上 pending 当僵尸标 failed 是合法语义
// （旧代码绕过校验直接 mutate，所以这条转换未在 validTransitions 里）。
export const VALID_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlyArray<TaskStatus>>> = {
  pending: ['planning', 'failed', 'cancelled'],
  planning: ['executing', 'failed', 'cancelled'],
  executing: ['waiting_human', 'waiting', 'completed', 'failed', 'cancelled'],
  waiting_human: ['executing', 'cancelled', 'failed'],
  waiting: ['executing', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export type DerivedFieldOpts = {
  error?: string
  pendingQuestion?: string | null
}

/**
 * 应用状态变更带来的所有派生字段维护。纯函数，返回新 task。
 *
 * 调用方负责：
 * - 状态机校验（VALID_TRANSITIONS）—— AdminModule.applyStatusTransition 内做
 * - 不变量断言（assertTaskInvariants）—— 同上
 * - 事件发布、持久化 —— 同上或调用方自行
 */
export function applyDerivedFields(
  task: Task,
  newStatus: TaskStatus,
  nowISO: string,
  opts: DerivedFieldOpts = {},
): Task {
  const next: Task = { ...task, status: newStatus, updated_at: nowISO }

  if (newStatus === 'executing' && !next.started_at) {
    next.started_at = nowISO
  }

  if (isTerminalStatus(newStatus)) {
    next.completed_at = nowISO
  }

  next.waiting_human_at = newStatus === 'waiting_human' ? nowISO : undefined
  next.waiting_at = newStatus === 'waiting' ? nowISO : undefined

  // pending_question：离开 waiting_human 永远清空（旧 handleUpdateTaskStatus 仅在显式
  // 传 null 时清，是 INV-4 残留 bug 的来源）。进入 waiting_human 时调用方可覆盖
  // （opts.pendingQuestion=null 表示显式清空；undefined 表示保留 spread 带过来的旧值）。
  if (newStatus === 'waiting_human') {
    if (opts.pendingQuestion !== undefined) {
      next.pending_question = opts.pendingQuestion ?? undefined
    }
  } else {
    next.pending_question = undefined
  }

  if (opts.error !== undefined) {
    next.error = opts.error
  }

  return next
}

/**
 * 校验 task 满足派生字段不变量。违反抛错。
 *
 * 设计意图：所有走 applyStatusTransition 出来的 task 都必须 pass；
 * loadData 时 repair 后也必须 pass。pass 不掉 = repair 或派生字段
 * 实现有 bug，立刻暴露。
 */
export function assertTaskInvariants(task: Task): void {
  // INV-1: status === 'waiting_human' ⇔ waiting_human_at !== undefined
  if (task.status === 'waiting_human' && task.waiting_human_at === undefined) {
    throw new Error(`Task ${task.id}: INV-1 violated — status=waiting_human but waiting_human_at missing`)
  }
  if (task.status !== 'waiting_human' && task.waiting_human_at !== undefined) {
    throw new Error(
      `Task ${task.id}: INV-1 violated — status=${task.status} but waiting_human_at still set`,
    )
  }

  // INV-2: status === 'waiting' ⇔ waiting_at !== undefined
  if (task.status === 'waiting' && task.waiting_at === undefined) {
    throw new Error(`Task ${task.id}: INV-2 violated — status=waiting but waiting_at missing`)
  }
  if (task.status !== 'waiting' && task.waiting_at !== undefined) {
    throw new Error(`Task ${task.id}: INV-2 violated — status=${task.status} but waiting_at still set`)
  }

  // INV-3: terminal ⇒ completed_at !== undefined
  if (isTerminalStatus(task.status) && task.completed_at === undefined) {
    throw new Error(`Task ${task.id}: INV-3 violated — terminal status=${task.status} but completed_at missing`)
  }

  // INV-4: status !== 'waiting_human' ⇒ pending_question === undefined
  if (task.status !== 'waiting_human' && task.pending_question !== undefined) {
    throw new Error(
      `Task ${task.id}: INV-4 violated — status=${task.status} but pending_question still set`,
    )
  }
}

/**
 * 修正历史脏数据的派生字段不一致。loadData 启动期调用，目的：
 * 1. 治掉旧版本代码（绕过 applyStatusTransition 的 self-healing / cancel 路径）
 *    留下的 waiting_human_at / waiting_at / pending_question 残留
 * 2. 给 terminal 但缺 completed_at 的 task 回填一个时间戳（用 updated_at）
 *
 * 不会"反向修复"——比如 status=waiting_human 但缺 waiting_human_at，
 * 我们无法凭空造时间戳，留给 assertTaskInvariants 抛错。这种情况只会
 * 来自磁盘损坏或外部手工修改，应当被发现而不是默默掩盖。
 *
 * @returns task 同引用（无修改时）或新对象（有修改），fixes 列表说明修了哪些字段
 */
export function repairTaskInvariants(input: Task): { task: Task; fixes: string[] } {
  const fixes: string[] = []
  let task = input

  const fix = (field: string, mut: (t: Task) => void) => {
    if (task === input) task = { ...input }
    mut(task)
    fixes.push(field)
  }

  // INV-1 反向：清掉与 status 不符的 waiting_human_at
  if (task.status !== 'waiting_human' && task.waiting_human_at !== undefined) {
    fix('waiting_human_at', (t) => { t.waiting_human_at = undefined })
  }

  // INV-2 反向：清掉与 status 不符的 waiting_at
  if (task.status !== 'waiting' && task.waiting_at !== undefined) {
    fix('waiting_at', (t) => { t.waiting_at = undefined })
  }

  // INV-3 回填：terminal 但缺 completed_at → 用 updated_at 兜底
  if (isTerminalStatus(task.status) && task.completed_at === undefined) {
    fix('completed_at', (t) => { t.completed_at = t.updated_at })
  }

  // INV-4 反向：清掉与 status 不符的 pending_question
  if (task.status !== 'waiting_human' && task.pending_question !== undefined) {
    fix('pending_question', (t) => { t.pending_question = undefined })
  }

  return { task, fixes }
}
