/**
 * Task 状态机 + 派生字段维护 + 不变量校验。
 *
 * 状态变更必须走 AdminModule.applyStatusTransition（它内部调用本文件的纯函数）。
 * 任何直接 mutate task.status 的新代码 = bug。loadData 也用这里的 repair 治历史脏数据。
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
