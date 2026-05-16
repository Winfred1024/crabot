import { describe, it, expect } from 'vitest'
import {
  supplementTaskTool,
  STAY_SILENT_TOOL,
  getAgentExitTools,
} from '../../src/agent/agent-exit-tools.js'

describe('supplementTaskTool', () => {
  it('生成工具定义带 turnZeroOnly + exitsLoop', () => {
    const tool = supplementTaskTool(['task-1', 'task-2'])
    expect(tool.name).toBe('supplement_task')
    expect(tool.turnZeroOnly).toBe(true)
    expect(tool.exitsLoop).toBe(true)
  })

  it('inputSchema 的 target_task_id enum 含传入的 task IDs', () => {
    const tool = supplementTaskTool(['task-A', 'task-B'])
    const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>
    expect(props.target_task_id?.enum).toEqual(['task-A', 'task-B'])
  })

  it('不含 user_attitude 字段（spec 已移除）', () => {
    const tool = supplementTaskTool(['x'])
    const props = tool.inputSchema.properties as Record<string, unknown>
    expect(props.user_attitude).toBeUndefined()
  })

  it('必填字段是 target_task_id 和 supplement_text', () => {
    const tool = supplementTaskTool(['x'])
    expect(tool.inputSchema.required).toEqual(['target_task_id', 'supplement_text'])
  })
})

describe('STAY_SILENT_TOOL', () => {
  it('带 turnZeroOnly + exitsLoop 标记', () => {
    expect(STAY_SILENT_TOOL.name).toBe('stay_silent')
    expect(STAY_SILENT_TOOL.turnZeroOnly).toBe(true)
    expect(STAY_SILENT_TOOL.exitsLoop).toBe(true)
  })

  it('inputSchema 含可选 reason 字段', () => {
    const props = STAY_SILENT_TOOL.inputSchema.properties as Record<string, unknown>
    expect(props.reason).toBeDefined()
    expect(STAY_SILENT_TOOL.inputSchema.required).toEqual([])
  })
})

describe('getAgentExitTools', () => {
  it('私聊（!isGroup）+ 有活跃任务 → 只返回 supplement_task', () => {
    const tools = getAgentExitTools({ isGroup: false, activeTaskIds: ['t1'] })
    expect(tools.map(t => t.name)).toEqual(['supplement_task'])
  })

  it('私聊 + 无活跃任务 → 返回空（无法 supplement，也无 stay_silent）', () => {
    const tools = getAgentExitTools({ isGroup: false, activeTaskIds: [] })
    expect(tools).toEqual([])
  })

  it('群聊 + 有活跃任务 → supplement_task + stay_silent', () => {
    const tools = getAgentExitTools({ isGroup: true, activeTaskIds: ['t1'] })
    expect(tools.map(t => t.name).sort()).toEqual(['stay_silent', 'supplement_task'])
  })

  it('群聊 + 无活跃任务 → 只 stay_silent', () => {
    const tools = getAgentExitTools({ isGroup: true, activeTaskIds: [] })
    expect(tools.map(t => t.name)).toEqual(['stay_silent'])
  })
})
