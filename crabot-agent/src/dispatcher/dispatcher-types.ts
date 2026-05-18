/**
 * Pre-Front Dispatcher 类型定义。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §3
 */

import type { ChannelMessage, Friend, TaskSummary, RuntimeSceneProfile } from '../types.js'

/** Dispatcher 输出的单个动作。LLM 通过 structured output 约束格式。 */
export type DispatchAction =
  | { readonly kind: 'supplement'; readonly target_task_id: string; readonly text: string }
  | { readonly kind: 'new_task'; readonly text: string }
  | { readonly kind: 'stay_silent'; readonly reason?: string }

/** Dispatcher 调用上下文。 */
export interface DispatchContext {
  readonly messages: ReadonlyArray<ChannelMessage>
  /** 已 union 去重 + 过滤 schedule task 的 active_tasks。dispatcher 直接信任。 */
  readonly activeTasks: ReadonlyArray<TaskSummary>
  readonly sessionType: 'private' | 'group' | 'admin_chat'
  readonly channelId: string
  readonly sessionId: string
  readonly senderFriend: Friend
  readonly sceneProfile?: RuntimeSceneProfile
  /** trace 关联：dispatcher 在此 trace 下挂 dispatch_call + dispatch_action span */
  readonly traceId: string
  readonly parentSpanId?: string
}

/** Dispatcher 返回结果。 */
export interface DispatchResult {
  readonly actions: ReadonlyArray<DispatchAction>
}

/** 动作执行器的运行时上下文（注入 unified-agent 提供的回调）。 */
export interface ExecuteContext {
  readonly dispatchCtx: DispatchContext
  /** supplement 投递回调：把 text push 到目标 task 的 humanQueue。
   *  返回值：'delivered' = 投递成功；'fallback' = task not found（agent 进程内 activeTasks 没有）。 */
  readonly pushSupplement: (taskId: string, text: string) => Promise<'delivered' | 'fallback'>
  /** new_task spawn 回调：启动一个 agent 实例。
   *  实施细节：内部调 admin create_task with client-provided id 注册，然后跑 runWorkerLoop + finalizeTask。
   *  返回值 spawnedTraceId 用于 cross-trace link。 */
  readonly spawnAgentInstance: (text: string) => Promise<{ readonly spawnedTraceId: string }>
  /** channel send 回调：dispatcher 失败兜底走这条向人类报错。 */
  readonly sendErrorToUser: (errorText: string) => Promise<void>
}

/** Dispatcher 失败时的 trace outcome 标记。 */
export type DispatchTraceOutcome = 'dispatched' | 'silent' | 'error'

/** 软上限：单次 dispatch 最多输出多少个动作。LLM prompt 内告知此上限，超出截断。 */
export const MAX_ACTIONS_PER_DISPATCH = 5
