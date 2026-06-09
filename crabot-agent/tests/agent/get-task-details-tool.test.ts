import { describe, it, expect } from 'vitest'
import { createGetTaskProgressTool, type GetTaskProgressToolDeps } from '../../src/agent/get-task-details-tool'

// spec 2026-06-09-task-trace-tool-unification.md §4.1: 改名 get_task_details → get_task_progress
describe('get_task_progress tool description', () => {
  const tool = createGetTaskProgressTool({} as unknown as GetTaskProgressToolDeps)

  it('name 已改为 get_task_progress', () => {
    expect(tool.name).toBe('get_task_progress')
  })

  it('强调已知 task_id 时取进度', () => {
    expect(tool.description).toMatch(/已知.*task_id/)
  })

  it('引导先 find_task 找 task_id（替代旧 search_short_term / search_traces 摸排）', () => {
    expect(tool.description).toContain('find_task')
  })
})
