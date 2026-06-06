/**
 * Task 状态机：合法状态转换表。
 *
 * 后续 task（同一 plan 内）会在本文件追加 applyDerivedFields / assertTaskInvariants
 * / repairTaskInvariants，并由 AdminModule.applyStatusTransition 统一调度。
 */

import type { Task, TaskStatus } from './types.js'

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

  if (TERMINAL_STATUSES.has(newStatus)) {
    next.completed_at = nowISO
  }

  if (newStatus === 'waiting_human') {
    next.waiting_human_at = nowISO
  } else {
    next.waiting_human_at = undefined
  }

  if (newStatus === 'waiting') {
    next.waiting_at = nowISO
  } else {
    next.waiting_at = undefined
  }

  // pending_question：仅在 waiting_human 时持有，离开必清。
  // 进入 waiting_human 时调用方可覆盖（null = 显式清空）。
  if (newStatus === 'waiting_human') {
    if (opts.pendingQuestion !== undefined) {
      next.pending_question = opts.pendingQuestion ?? undefined
    }
    // 不提供时保留 input 的 pending_question（即 task.pending_question 通过 spread 已带过来）
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
  if (TERMINAL_STATUSES.has(task.status) && task.completed_at === undefined) {
    throw new Error(`Task ${task.id}: INV-3 violated — terminal status=${task.status} but completed_at missing`)
  }

  // INV-4: status !== 'waiting_human' ⇒ pending_question === undefined
  if (task.status !== 'waiting_human' && task.pending_question !== undefined) {
    throw new Error(
      `Task ${task.id}: INV-4 violated — status=${task.status} but pending_question still set`,
    )
  }
}
