import { describe, it, expect, vi } from 'vitest'
import { buildDelegateTaskDescription, createDelegateTaskTool } from '../../src/agent/delegate-task-tool.js'
import type { SubAgentConfig } from '../../src/types.js'

function fakeSubAgent(name: string, when_to_use = `Use this subagent when ${name}.`): SubAgentConfig {
  return {
    id: `id-${name}`,
    name,
    description: `desc ${name}`,
    when_to_use,
    role: 'r',
    workflow: 'w',
    deliverables: 'd',
    model: { model_id: 'm', endpoint: 'https://x', apikey: 'k', format: 'anthropic' } as any,
    builtin_capabilities: { file_system: true, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
    allowed_mcp_server_ids: [],
    allowed_skill_ids: [],
    max_turns: 10,
  }
}

describe('buildDelegateTaskDescription', () => {
  it('含 <available_subagents> 段 + 每个 subagent 的 when_to_use', () => {
    const desc = buildDelegateTaskDescription([fakeSubAgent('alpha'), fakeSubAgent('beta')])
    expect(desc).toContain('<available_subagents>')
    expect(desc).toContain('"alpha"')
    expect(desc).toContain('"beta"')
    expect(desc).toContain('=== alpha ===')
    expect(desc).toContain('Use this subagent when alpha.')
    expect(desc).toContain('=== beta ===')
    expect(desc).toContain('Use this subagent when beta.')
  })

  it('空 subagent 列表也能产出合法 description', () => {
    const desc = buildDelegateTaskDescription([])
    expect(desc).toContain('<available_subagents>')
    expect(typeof desc).toBe('string')
  })

  it('含使用提示（不继承父对话历史 / 不能再委派下一层）', () => {
    const desc = buildDelegateTaskDescription([fakeSubAgent('x')])
    expect(desc).toContain('不继承父对话历史')
    expect(desc).toContain('不能再委派下一层')
  })
})

describe('createDelegateTaskTool', () => {
  it('工具名为 delegate_task', () => {
    const tool = createDelegateTaskTool({ subAgents: [fakeSubAgent('vision')], runSubAgent: vi.fn() })
    expect(tool.name).toBe('delegate_task')
  })

  it('inputSchema.subagent_type.enum 含所有 enabled subagents', () => {
    const tool = createDelegateTaskTool({ subAgents: [fakeSubAgent('a'), fakeSubAgent('b')], runSubAgent: vi.fn() })
    const props = tool.inputSchema.properties as Record<string, any>
    const enumVals = props.subagent_type.enum
    expect(enumVals).toEqual(['a', 'b'])
  })

  it('inputSchema.required 含 subagent_type 和 task', () => {
    const tool = createDelegateTaskTool({ subAgents: [fakeSubAgent('a')], runSubAgent: vi.fn() })
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(['subagent_type', 'task']))
  })

  it('未知 subagent_type 返回 isError + 可用列表', async () => {
    const tool = createDelegateTaskTool({ subAgents: [fakeSubAgent('a')], runSubAgent: vi.fn() })
    const result = await tool.call(
      { subagent_type: 'unknown', task: 't' },
      { abortSignal: new AbortController().signal } as any
    )
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('unknown')
    expect(String(result.output)).toContain('a')   // 列出可用
  })

  it('已知 subagent_type 调 runSubAgent + 透传 input', async () => {
    const runMock = vi.fn().mockResolvedValue({ output: 'done', isError: false })
    const sub = fakeSubAgent('a')
    const tool = createDelegateTaskTool({ subAgents: [sub], runSubAgent: runMock })
    const result = await tool.call(
      { subagent_type: 'a', task: 'do x' },
      { abortSignal: new AbortController().signal } as any
    )
    expect(runMock).toHaveBeenCalledWith(sub, { subagent_type: 'a', task: 'do x' }, expect.anything())
    expect(result.output).toBe('done')
    expect(result.isError).toBe(false)
  })
})

describe('createDelegateTaskTool system_only filtering', () => {
  it('过滤掉 system_only=true 的 subagent，不出现在 enum / description', () => {
    const subagents: SubAgentConfig[] = [
      fakeSubAgent('code_writer'),
      { ...fakeSubAgent('goal_auditor'), system_only: true },
    ]
    const tool = createDelegateTaskTool({
      subAgents: subagents,
      runSubAgent: async () => ({ output: '', isError: false }),
    })
    const schema = tool.inputSchema as { properties: { subagent_type: { enum: string[] } } }
    expect(schema.properties.subagent_type.enum).toEqual(['code_writer'])
    expect(tool.description).not.toContain('goal_auditor')
    expect(tool.description).toContain('code_writer')
  })

  it('worker 调用 system_only subagent 会被拒（即使硬塞 enum 外的 name）', async () => {
    const subagents: SubAgentConfig[] = [
      { ...fakeSubAgent('goal_auditor'), system_only: true },
    ]
    let called = false
    const tool = createDelegateTaskTool({
      subAgents: subagents,
      runSubAgent: async () => {
        called = true
        return { output: 'should not run', isError: false }
      },
    })
    const ctx = { abortSignal: new AbortController().signal } as any
    const result = await tool.call(
      { subagent_type: 'goal_auditor', task: 'audit' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.output)).toContain('Unknown subagent_type')
    expect(called).toBe(false)
  })
})
