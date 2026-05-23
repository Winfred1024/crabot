import type { ToolDefinition } from '../engine/types.js'
import { defineTool } from '../engine/tool-framework.js'
import { TodoStore, type TodoItem } from './worker-todo-store.js'

const TOOL_DESCRIPTION =
  '管理你当前任务的执行清单。**适用场景：≥10 步的复杂任务、用户给出多个并列子任务、研究/探索类任务**。' +
  '单步任务（直接答 / 一条命令搞定）不需要用此工具。\n\n' +
  '读模式：不传 todos 参数 = 返回当前完整列表\n' +
  '写模式：\n' +
  '- merge=false（或缺省）= 用传入数组整体替换 plan，用于初始 plan 或推翻重写\n' +
  '- merge=true = 按 id 增量更新（新 id 追加），用于推进进度\n\n' +
  '每个 item: {id, content, status: pending|in_progress|completed|cancelled}\n' +
  '列表顺序代表执行优先级。**同时只能有 1 个 in_progress**。\n\n' +
  '执行约束：\n' +
  '- 任务开始前先列 plan（≥10 步任务必须列）\n' +
  '- 推进时先 mark in_progress，做完立刻 mark completed\n' +
  '- 单步失败 → mark cancelled + 添加修订 item，不要原地反复重试\n' +
  '- 假设颠覆 → replace 整个 plan，不要硬改\n\n' +
  '工具会返回最新完整列表，便于你 confirm 状态。'

export interface TodoToolDeps {
  /** 可选；缺省时不门控（兼容旧调用方）。
   *  Phase 2 起 agent-handler 注入 () => task.goal !== undefined
   *  spec: 2026-05-23-goal-mode-design.md §5 */
  readonly hasGoal?: () => boolean
}

export function createTodoTool(store: TodoStore, deps?: TodoToolDeps): ToolDefinition {
  return defineTool({
    name: 'todo',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '要写入的 todo 列表；不传则为读模式',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '稳定 ID（如 slug）' },
              content: { type: 'string', description: '这一步要做的事' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
              },
            },
            required: ['id', 'content', 'status'],
            additionalProperties: false,
          },
        },
        merge: {
          type: 'boolean',
          description: 'true=按 id 增量更新；false 或缺省=整体替换',
        },
      },
    },
    isReadOnly: false,
    call: async (input) => {
      const { todos, merge } = input as { todos?: unknown; merge?: boolean }

      // Read mode 不门控（无 todos 字段 = 读）
      if (todos === undefined) {
        return { output: JSON.stringify(store.list()), isError: false }
      }

      // Write mode：检查 hasGoal 门控
      if (deps?.hasGoal && !deps.hasGoal()) {
        return {
          output:
            'todo: 本任务尚未 set_task_goal。复杂任务（多步骤改动 / 跨 turn / 用户明确说"确保 X"）'
            + '请先调 set_task_goal 写下 objective + acceptance_criteria，再用 todo 拆步骤。'
            + '简单任务（单次工具调用即可、直接问答）请直接干，不必走 todo。',
          isError: true,
        }
      }

      if (!Array.isArray(todos)) {
        return { output: 'todo: todos must be an array', isError: true }
      }

      try {
        if (merge === true) store.merge(todos as TodoItem[])
        else store.replace(todos as TodoItem[])
        return { output: JSON.stringify(store.list()), isError: false }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { output: `todo: ${msg}`, isError: true }
      }
    },
  })
}
