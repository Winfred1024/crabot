/**
 * Scheduled Task Runner - 调度任务执行器
 *
 * unified-agent.handleCreateTaskFromSchedule 触发的调度任务执行入口。
 * 其他决策（direct_reply / create_task / supplement_task / silent）已由 unified loop 直接处理，
 * 本模块仅负责 schedule 触发的任务。
 */

import type { RpcClient } from 'crabot-shared'
import type {
  ExecuteTaskParams,
  ExecuteTaskResult,
  WorkerAgentContext,
} from '../types.js'
import type { WorkerHandler } from '../agent/worker-handler.js'
import { MemoryWriter } from './memory-writer.js'

/** Admin create_task 返回的任务信息 */
interface AdminTask {
  id: string
  title: string
  description?: string
  priority: string
  plan?: string
  task_type?: string
}

export class ScheduledTaskRunner {
  private workerHandler: WorkerHandler | null = null

  constructor(
    private rpcClient: RpcClient,
    private moduleId: string,
    private contextAssembler: unknown,
    private memoryWriter: MemoryWriter,
    private getAdminPort: () => number | Promise<number>,
    private getChannelPort: (channelId: string) => Promise<number>,
    private executeTaskFn?: (params: ExecuteTaskParams & { related_task_id?: string }) => Promise<ExecuteTaskResult & { trace_id?: string }>,
  ) {}

  /**
   * 设置本地 Worker Handler 引用（UnifiedAgent 在初始化 Worker 后调用）
   */
  setWorkerHandler(handler: WorkerHandler): void {
    this.workerHandler = handler
  }

  /**
   * 后台执行调度任务：无来源 channel，不发即时回复，仅更新 Admin 任务状态 + 写系统级短期记忆
   */
  executeScheduledTaskInBackground(
    task: AdminTask,
    workerContext: WorkerAgentContext,
  ): void {
    const run = async () => {
      const adminPort = await this.getAdminPort()

      // 推进任务状态：pending → planning → executing
      try {
        await this.rpcClient.call(
          adminPort, 'update_task_status',
          { task_id: task.id, status: 'planning' },
          this.moduleId
        )
        await this.rpcClient.call(
          adminPort, 'update_task_status',
          { task_id: task.id, status: 'executing' },
          this.moduleId
        )
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ScheduledTaskRunner] Failed to transition scheduled task ${task.id} to executing: ${msg}`)
      }

      // memory_maintenance 直接走 RPC，不经 Worker
      if (task.task_type === 'memory_maintenance') {
        try {
          await this.memoryWriter.runMaintenance('all')
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            {
              task_id: task.id,
              status: 'completed',
              result: {
                outcome: 'completed',
                summary: '记忆维护完成（observation_check / stale_aging / trash_cleanup）',
                finished_at: new Date().toISOString(),
              },
            },
            this.moduleId,
          )
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`[ScheduledTaskRunner] memory_maintenance task ${task.id} failed: ${msg}`)
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            {
              task_id: task.id,
              status: 'failed',
              result: { outcome: 'failed', summary: msg, finished_at: new Date().toISOString() },
              error: msg,
            },
            this.moduleId,
          ).catch(() => undefined)
        }
        return
      }

      try {
        const taskPayload: ExecuteTaskParams = {
          task: {
            task_id: task.id,
            task_title: task.title,
            task_description: task.description ?? '',
            priority: task.priority,
            plan: task.plan,
            task_type: task.task_type,
          },
          context: workerContext,
        }

        // worker handler 内部已完成：update_task_status + update_task_outcome + 记忆写入
        if (this.executeTaskFn) {
          await this.executeTaskFn({ ...taskPayload, related_task_id: task.id })
        } else {
          await this.workerHandler!.executeTask(taskPayload)
        }
      } catch (error) {
        // worker handler 自身崩溃（throw）——兜底：标失败 + 写失败记忆
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[ScheduledTaskRunner] Background scheduled task ${task.id} failed: ${msg}`)

        try {
          await this.rpcClient.call(
            adminPort,
            'update_task_status',
            { task_id: task.id, status: 'failed', error: msg },
            this.moduleId
          )
        } catch { /* best effort */ }

        this.finalizeTaskMemory({
          taskId: task.id,
          taskTitle: task.title,
          outcome: 'failed',
          outcomeBrief: msg.slice(0, 200),
          processHighlights: [],
          friendName: 'system',
          friendId: '',
          channelId: '',
          sessionId: '',
          visibility: 'internal',
          scopes: [],
        })
      }
    }

    run().catch((err) => {
      console.error(`[ScheduledTaskRunner] Unexpected error in scheduled task: ${err}`)
    })
  }

  /**
   * worker handler 自身崩溃时的失败记忆兜底写入（短期 + 长期）。两者均 fire-and-forget。
   *
   * 成功路径的记忆已由 worker-handler.finalizeMemoryWrite 内部写入，dispatcher 不再重复。
   */
  private finalizeTaskMemory(args: {
    taskId: string
    taskTitle: string
    outcome: 'completed' | 'failed'
    outcomeBrief: string
    processHighlights: readonly string[]
    friendName: string
    friendId: string
    channelId: string
    sessionId: string
    visibility: 'private' | 'internal' | 'public'
    scopes: string[]
    traceId?: string
  }): void {
    const {
      taskId, taskTitle, outcome, outcomeBrief, processHighlights,
      friendName, friendId, channelId, sessionId, visibility, scopes, traceId,
    } = args

    this.memoryWriter.writeTaskFinished({
      task_id: taskId,
      task_title: taskTitle,
      outcome,
      outcome_brief: outcomeBrief,
      process_highlights: [...processHighlights],
      friend_name: friendName,
      friend_id: friendId,
      channel_id: channelId,
      session_id: sessionId,
      visibility,
      scopes,
      ...(traceId ? { trace_id: traceId } : {}),
    }).catch(() => {})

    const briefSrc = `${taskTitle} → ${outcomeBrief}`.slice(0, 80)
    const outcomeLabel = outcome === 'completed' ? '完成' : '失败'
    this.memoryWriter.quickCapture({
      type: 'lesson',
      brief: briefSrc,
      content: `任务 ${taskId}（${taskTitle}）${outcomeLabel}：${outcomeBrief}`,
      source_ref: { type: 'conversation', task_id: taskId, channel_id: channelId, session_id: sessionId },
      entities: [],
      tags: [`task_outcome:${outcome}`],
      importance_factors: {
        proximity: 0.6,
        surprisal: outcome === 'failed' ? 0.8 : 0.4,
        entity_priority: 0.5,
        unambiguity: 0.6,
      },
    }).catch(() => undefined)
  }
}
