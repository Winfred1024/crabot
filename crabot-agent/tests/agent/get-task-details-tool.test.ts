import { describe, it, expect } from 'vitest'
import { createGetTaskDetailsTool, type GetTaskDetailsToolDeps } from '../../src/agent/get-task-details-tool'

describe('get_task_details tool description', () => {
  const tool = createGetTaskDetailsTool({} as unknown as GetTaskDetailsToolDeps)

  it('强调已知 task_id 时取详情', () => {
    expect(tool.description).toMatch(/已知.*task_id/)
  })

  it('引导先 search_short_term 找 task_id', () => {
    expect(tool.description).toContain('search_short_term')
  })
})
