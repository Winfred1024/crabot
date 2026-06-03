/**
 * Dispatcher 动作执行器：按顺序执行 DispatchAction[]。
 *
 * 每个动作通过 ExecuteContext 注入的回调执行：
 * - supplement → pushSupplement 投递到 humanQueue；返回 fallback 时降级为 new_task
 *               （避免静默吃消息——schema 白名单已先拦了 LLM 编 task_id 的大多数 case，
 *                这里兜底处理 agent 进程内 activeTasks 与 dispatcher 看到的 admin
 *                snapshot 之间的 race 窗口）
 * - new_task   → spawnAgentInstance 启动 agent 实例
 * - stay_silent → discard（无副作用）
 *
 * 单个动作失败不阻塞后续动作。
 * 若 ExecuteContext.trace 已注入，每个动作执行前后写 dispatch_action span。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-19-prefront-dispatcher-design.md §3.4 §3.6 §6
 */

import type { DispatchAction, ExecuteContext } from './dispatcher-types.js'

export async function executeDispatchActions(
  actions: ReadonlyArray<DispatchAction>,
  ctx: ExecuteContext,
): Promise<void> {
  for (const action of actions) {
    // 写 dispatch_action span（若调用方注入了 trace callback）
    const span = ctx.trace?.startSpan({
      type: 'dispatch_action',
      details: buildActionSpanDetails(action),
    })

    try {
      if (action.kind === 'supplement') {
        const outcome = await ctx.pushSupplement(action.target_task_id, action.text)
        if (outcome === 'fallback') {
          const visibleIds = ctx.dispatchCtx.activeTasks.map((t) => t.task_id).join(', ') || '(empty)'
          console.warn(
            `[dispatcher-executor] supplement_fallback: target_task_id=${action.target_task_id} not in agent activeTasks; visible=${visibleIds} — falling back to new_task to avoid silently dropping the user message`,
          )
          const { spawnedTraceId } = await ctx.spawnAgentInstance(action.text)
          if (span && ctx.trace) {
            ctx.trace.endSpan(span.span_id, 'completed', {
              outcome: 'supplement_fallback_recovered',
              recovered_via: 'new_task',
              spawned_trace_id: spawnedTraceId,
              attempted_target_task_id: action.target_task_id,
            })
          }
        } else if (span && ctx.trace) {
          ctx.trace.endSpan(span.span_id, 'completed', { outcome: 'supplement_delivered' })
        }
      } else if (action.kind === 'new_task') {
        // 预回复（如果 dispatcher 判定复杂任务带了 immediate_reply）：
        // 在 spawnAgentInstance 之前 await 一次 channel.send_message，让用户立即收到 ack。
        // worker 起来后会通过 fetchRecentMessages 看到这条 outbound，不会重复 ack。
        // 失败兜底：warn 不阻塞 spawn——预回复不是必发，worker 起来照常跑。
        // Spec: 2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md
        let immediateReplySent = false
        if (action.immediate_reply && ctx.sendImmediateReply) {
          try {
            await ctx.sendImmediateReply(action.immediate_reply)
            immediateReplySent = true
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.warn(
              `[dispatcher-executor] sendImmediateReply failed (continuing to spawn worker without ack): ${msg}`,
            )
          }
        }
        const { spawnedTraceId } = await ctx.spawnAgentInstance(action.text)
        if (span && ctx.trace) {
          ctx.trace.endSpan(span.span_id, 'completed', {
            outcome: 'new_task_spawned',
            spawned_trace_id: spawnedTraceId,
            immediate_reply_sent: immediateReplySent,
          })
        }
      } else if (action.kind === 'stay_silent') {
        // 无副作用——attention scheduler 通过"是否有非 stay_silent 动作"判断退避
        if (span && ctx.trace) {
          ctx.trace.endSpan(span.span_id, 'completed', { outcome: 'silent_discard' })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[dispatcher-executor] action ${action.kind} failed (continuing):`, msg)
      if (span && ctx.trace) {
        ctx.trace.endSpan(span.span_id, 'failed', { error: msg })
      }
    }
  }
}

function buildActionSpanDetails(action: DispatchAction): Record<string, unknown> {
  if (action.kind === 'supplement') {
    return {
      kind: action.kind,
      target_task_id: action.target_task_id,
      text_summary: action.text.slice(0, 200),
    }
  }
  if (action.kind === 'new_task') {
    return {
      kind: action.kind,
      text_summary: action.text.slice(0, 200),
    }
  }
  // stay_silent
  return {
    kind: action.kind,
    ...(action.reason != null ? { reason: action.reason } : {}),
  }
}
