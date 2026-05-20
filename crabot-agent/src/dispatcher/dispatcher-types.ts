/**
 * Pre-Front Dispatcher 类型定义。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §3
 */

import type { ChannelMessage, Friend, TaskSummary, RuntimeSceneProfile } from '../types.js'

/**
 * Dispatcher 的 trace 写入回调接口。
 * 采用 minimal interface，避免 dispatcher 模块直接 import agent 内部的 TraceStoreInterface。
 * 调用方（unified-agent）通过闭包将 traceStore 实例包装成此接口注入。
 */
export interface DispatchTraceCallback {
  readonly startSpan: (params: {
    type: string
    details?: Record<string, unknown>
    parent_span_id?: string
  }) => { span_id: string }
  readonly endSpan: (
    spanId: string,
    status: 'completed' | 'failed',
    details?: Record<string, unknown>,
  ) => void
}

/** Dispatcher 输出的单个动作。LLM 通过 structured output 约束格式。 */
export type DispatchAction =
  | { readonly kind: 'supplement'; readonly target_task_id: string; readonly text: string }
  | { readonly kind: 'new_task'; readonly text: string }
  | { readonly kind: 'stay_silent'; readonly reason?: string }

/** Dispatcher 调用上下文。 */
export interface DispatchContext {
  /** 当前触发批次：私聊单条 / 群聊 attention 批次。dispatcher 决策的直接对象。 */
  readonly messages: ReadonlyArray<ChannelMessage>
  /**
   * 最近聊天历史（不含当前 messages）。
   * dispatcher 需要它判断 supplement 时引用的「那个 PDF」「那个手机调研」是否指向当前活跃任务，
   * 并把媒体上下文（文件 / 图片）传递给 spawn 出来的 worker。
   * 由 contextAssembler 填充（参 FrontAgentContext.recent_messages）。
   */
  readonly recentMessages: ReadonlyArray<ChannelMessage>
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
  /** trace 写入回调（可选）。注入后 executeDispatchActions 为每个 action 写 dispatch_action span。 */
  readonly trace?: DispatchTraceCallback
}

/** Dispatcher 失败时的 trace outcome 标记。 */
export type DispatchTraceOutcome = 'dispatched' | 'silent' | 'error'

/** 软上限：单次 dispatch 最多输出多少个动作。LLM prompt 内告知此上限，超出截断。 */
export const MAX_ACTIONS_PER_DISPATCH = 5
