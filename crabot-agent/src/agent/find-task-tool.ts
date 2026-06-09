/**
 * find_task 工具 — 按 task 维度查找历史任务（含已结束）。
 *
 * spec 2026-06-09-task-trace-tool-unification.md §4.1 / §4.2
 *
 * 替代旧的 search_traces + search_short_term 摸排 task_id 的绕路。
 * 关键词在 task.title + task.messages[].content 上匹配（admin handleListTasks Phase 1f 改造）。
 *
 * Agent 视角下 trace_id 概念不存在 —— 返回里只暴露 task_id；找到后走 get_task_progress(task_id)
 * 拿执行细节。
 *
 * 数据源：转发 admin list_tasks RPC + 字段剪裁。
 */

import type { ToolDefinition } from '../engine/types'
import { defineTool } from '../engine/tool-framework'
import type { RpcClient } from 'crabot-shared'

export interface FindTaskToolDeps {
  readonly rpcClient: RpcClient
  readonly moduleId: string
  readonly getAdminPort: () => Promise<number>
}

/** Admin Task 返回的最少字段子集（防止全量绑定带 trace_id 等内部字段）。 */
interface AdminTaskShape {
  id: string
  title: string
  status: string
  priority: string
  source?: {
    channel_id?: string
    session_id?: string
    friend_id?: string
    trigger_type?: string
  }
  created_at: string
  updated_at: string
  started_at?: string
  completed_at?: string
  pending_question?: string
  messages?: Array<unknown>
  goal?: {
    objective: string
    status: string
    audit_history?: Array<unknown>
  }
  result?: {
    outcome: string
    outcome_brief?: string
  }
}

interface ListTasksResponse {
  items: AdminTaskShape[]
  pagination: {
    page: number
    page_size: number
    total_items: number
    total_pages: number
  }
}

interface FindTaskInput {
  status?: string[]
  search?: string
  time_range?: { start: string; end: string }
  channel_id?: string
  session_id?: string
  sort?: 'created_at_desc' | 'created_at_asc' | 'updated_at_desc'
  page?: number
  page_size?: number
}

/** sort 字符串 → admin TaskSort 对象 */
function parseSort(sort: FindTaskInput['sort']): { field: string; order: string } {
  switch (sort) {
    case 'created_at_asc': return { field: 'created_at', order: 'asc' }
    case 'updated_at_desc': return { field: 'updated_at', order: 'desc' }
    default: return { field: 'created_at', order: 'desc' }
  }
}

/** Admin task → 暴露给 agent 的 TaskBrief（剪裁 trace_id / messages 数组等内部字段）。 */
function toTaskBrief(t: AdminTaskShape): Record<string, unknown> {
  return {
    task_id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    source: {
      ...(t.source?.channel_id ? { channel_id: t.source.channel_id } : {}),
      ...(t.source?.session_id ? { session_id: t.source.session_id } : {}),
      ...(t.source?.friend_id ? { friend_id: t.source.friend_id } : {}),
      ...(t.source?.trigger_type ? { trigger_type: t.source.trigger_type } : {}),
    },
    created_at: t.created_at,
    updated_at: t.updated_at,
    ...(t.started_at ? { started_at: t.started_at } : {}),
    ...(t.completed_at ? { completed_at: t.completed_at } : {}),
    ...(t.goal ? {
      goal: {
        objective: t.goal.objective,
        status: t.goal.status,
        audit_history_count: t.goal.audit_history?.length ?? 0,
      },
    } : {}),
    ...(t.result ? {
      result: {
        outcome: t.result.outcome,
        ...(t.result.outcome_brief ? { outcome_brief: t.result.outcome_brief } : {}),
      },
    } : {}),
    message_count: t.messages?.length ?? 0,
    ...(t.pending_question ? { pending_question: t.pending_question } : {}),
  }
}

export function createFindTaskTool(deps: FindTaskToolDeps): ToolDefinition {
  return defineTool({
    name: 'find_task',
    description:
      '按 task 维度查找历史任务（含已结束）。替代旧的 `search_traces` / `search_short_term` 摸排 task_id 的绕路。' +
      '关键词在 task.title + 对话流（task.messages[].content）上匹配，覆盖原文细节词。' +
      '【典型场景】回答"上次那个怎么样了"/"任务进度"/"我之前问过的 X"。' +
      '找到目标后用 `get_task_progress(task_id)` 拿执行细节。' +
      '【不返回 trace_id】agent 不需要区分 task vs trace，所有执行细节走 get_task_progress(task_id) 一个入口。',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['pending', 'planning', 'executing', 'waiting_human', 'waiting', 'completed', 'failed', 'cancelled'],
          },
          description: '状态过滤，多选；省略 = 全部状态。查"还没做完"用 [pending,planning,executing,waiting_human,waiting]；查"已结束"用 [completed,failed,cancelled]',
        },
        search: {
          type: 'string',
          description: '关键词，匹 task.title + task.messages[].content（lowercase includes）。按聊天原文细节词查找的命中字段',
        },
        time_range: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'ISO 8601 开始时间（created_at >=）' },
            end: { type: 'string', description: 'ISO 8601 结束时间（created_at <=）' },
          },
        },
        channel_id: { type: 'string', description: '按对话渠道过滤（如 telegram-001）' },
        session_id: { type: 'string', description: '按对话会话过滤' },
        sort: {
          type: 'string',
          enum: ['created_at_desc', 'created_at_asc', 'updated_at_desc'],
          description: '默认 created_at_desc（最近创建优先）',
        },
        page: { type: 'number', description: '页码从 1 开始；默认 1' },
        page_size: { type: 'number', description: '每页数量，默认 20，最大 100' },
      },
    },
    isReadOnly: true,
    call: async (input) => {
      const params = input as FindTaskInput

      const filter: Record<string, unknown> = {}
      if (params.status && params.status.length > 0) filter.status = params.status
      if (params.search) filter.search = params.search
      if (params.channel_id) filter.source_channel_id = params.channel_id
      if (params.session_id) filter.source_session_id = params.session_id
      if (params.time_range?.start) filter.created_after = params.time_range.start
      if (params.time_range?.end) filter.created_before = params.time_range.end

      const rpcParams = {
        page: params.page ?? 1,
        page_size: Math.min(params.page_size ?? 20, 100),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
        sort: parseSort(params.sort),
      }

      try {
        const adminPort = await deps.getAdminPort()
        const result = await deps.rpcClient.call<typeof rpcParams, ListTasksResponse>(
          adminPort,
          'list_tasks',
          rpcParams,
          deps.moduleId,
        )

        const items = result.items.map(toTaskBrief)
        return {
          output: JSON.stringify({
            items,
            pagination: result.pagination,
          }),
          isError: false,
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { output: `find_task error: ${msg}`, isError: true }
      }
    },
  })
}
