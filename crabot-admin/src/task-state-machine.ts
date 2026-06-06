/**
 * Task 状态机：合法状态转换表。
 *
 * 后续 task（同一 plan 内）会在本文件追加 applyDerivedFields / assertTaskInvariants
 * / repairTaskInvariants，并由 AdminModule.applyStatusTransition 统一调度。
 */

import type { TaskStatus } from './types.js'

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
