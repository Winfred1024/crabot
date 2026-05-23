import { describe, it, expect, vi } from 'vitest'
import { createSetTaskGoalTool } from '../../src/agent/goal-tools.js'

describe('set_task_goal 工具', () => {
  it('合法入参 → 调 admin RPC + 返回成功', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ task: { id: 't1', goal: { objective: 'x' } } })
    const tool = createSetTaskGoalTool({
      taskId: 't1',
      callAdminRpc: rpcCall,
    })
    const result = await tool.call!({
      objective: '实现 X',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)
    expect(result.isError).toBeFalsy()
    expect(String(result.output)).toContain('ok')
    expect(rpcCall).toHaveBeenCalledWith('set_task_goal', expect.objectContaining({
      task_id: 't1',
      objective: '实现 X',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }))
  })

  it('token_budget 可选；传入时透传', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ task: { id: 't1' } })
    const tool = createSetTaskGoalTool({ taskId: 't1', callAdminRpc: rpcCall })
    await tool.call!({
      objective: 'x',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
      token_budget: 100_000,
    }, {} as never)
    expect(rpcCall).toHaveBeenCalledWith('set_task_goal', expect.objectContaining({
      token_budget: 100_000,
    }))
  })

  it('token_budget 不传 → payload 不含该字段', async () => {
    const rpcCall = vi.fn().mockResolvedValue({ task: { id: 't1' } })
    const tool = createSetTaskGoalTool({ taskId: 't1', callAdminRpc: rpcCall })
    await tool.call!({
      objective: 'x',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)
    const payload = rpcCall.mock.calls[0]![1] as Record<string, unknown>
    expect('token_budget' in payload).toBe(false)
  })

  it('admin 抛错 → 工具返回 isError', async () => {
    const rpcCall = vi.fn().mockRejectedValue(new Error('goal 已存在；agent 不可自改'))
    const tool = createSetTaskGoalTool({
      taskId: 't1',
      callAdminRpc: rpcCall,
    })
    const result = await tool.call!({
      objective: 'x',
      acceptance_criteria: [{ id: 'c1', kind: 'cmd', spec: 'true' }],
    }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('goal 已存在')
  })

  it('description 引导 agent 在动手前调（含简单/复杂判断）', () => {
    const tool = createSetTaskGoalTool({ taskId: 't', callAdminRpc: vi.fn() })
    expect(tool.description).toMatch(/动手前|承诺/)
    expect(tool.description).toMatch(/简单任务|不必/)
  })

  it('inputSchema 强制 acceptance_criteria 至少 1 条', () => {
    const tool = createSetTaskGoalTool({ taskId: 't', callAdminRpc: vi.fn() })
    const schema = tool.inputSchema as { properties: { acceptance_criteria: { minItems: number } } }
    expect(schema.properties.acceptance_criteria.minItems).toBe(1)
  })

  it('inputSchema 限制 kind 枚举为 cmd|file|semantic', () => {
    const tool = createSetTaskGoalTool({ taskId: 't', callAdminRpc: vi.fn() })
    const schema = tool.inputSchema as {
      properties: {
        acceptance_criteria: {
          items: {
            properties: { kind: { enum: string[] } }
          }
        }
      }
    }
    expect(schema.properties.acceptance_criteria.items.properties.kind.enum)
      .toEqual(['cmd', 'file', 'semantic'])
  })
})
