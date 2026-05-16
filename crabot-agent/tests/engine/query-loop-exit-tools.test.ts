// crabot-agent/tests/engine/query-loop-exit-tools.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import type { ToolDefinition } from '../../src/engine/types.js'

function makeAdapter(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  }>,
): LLMAdapter {
  let i = 0
  return {
    complete: vi.fn(async () => {
      const r = responses[i++] ?? responses[responses.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      return {
        content,
        stopReason: r.stopReason,
        usage: { inputTokens: 100, outputTokens: 50 },
      }
    }),
    stream: async function* () { /* unused */ },
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

const dummyExitTool: ToolDefinition = {
  name: 'do_exit',
  description: 'exit tool',
  inputSchema: { type: 'object' as const, properties: { reason: { type: 'string' } }, required: [] },
  isReadOnly: true,
  turnZeroOnly: true,
  exitsLoop: true,
  call: async () => ({ output: '', isError: false }),
}

const dummyTurnZeroTool: ToolDefinition = {
  name: 'turn_zero_only',
  description: 'turn 0 only',
  inputSchema: { type: 'object' as const, properties: {}, required: [] },
  isReadOnly: true,
  turnZeroOnly: true,
  call: async () => ({ output: 'should not execute', isError: false }),
}

describe('query-loop: exitsLoop 工具退出', () => {
  it('turn 0 调用 exitsLoop 工具 → engine 立刻退出，exitToolCall 暴露 name + input', async () => {
    const adapter = makeAdapter([
      {
        toolCalls: [{ name: 'do_exit', id: 'call_1', input: { reason: 'turn 0 决定退出' } }],
        stopReason: 'tool_use',
      },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [dummyExitTool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.exitToolCall).toEqual({
      name: 'do_exit',
      input: { reason: 'turn 0 决定退出' },
    })
    expect(result.totalTurns).toBe(1)
    expect((adapter.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  it('未触发 exit 工具时 exitToolCall undefined', async () => {
    const adapter = makeAdapter([{ text: '正常结束', stopReason: 'end_turn' }])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [dummyExitTool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.exitToolCall).toBeUndefined()
  })
})

describe('query-loop: turnZeroOnly 拒绝', () => {
  it('turn ≥ 1 调用 turnZeroOnly 工具 → 返回 error tool_result，下一轮继续', async () => {
    const harmlessTool: ToolDefinition = {
      name: 'harmless',
      description: 'no-op',
      inputSchema: { type: 'object' as const, properties: {}, required: [] },
      isReadOnly: true,
      call: async () => ({ output: 'done', isError: false }),
    }
    const adapter = makeAdapter([
      // turn 0: 调一个普通工具 → tool_use 进入 turn 1
      { toolCalls: [{ name: 'harmless', id: 'h1', input: {} }], stopReason: 'tool_use' },
      // turn 1: 试图调 turn_zero_only → 被拒绝，下一轮 LLM 看到 error
      { toolCalls: [{ name: 'turn_zero_only', id: 'tz1', input: {} }], stopReason: 'tool_use' },
      // turn 2: LLM 看到错误，end_turn
      { text: '收到拒绝，结束', stopReason: 'end_turn' },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [harmlessTool, dummyTurnZeroTool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(3)
    expect(result.finalText).toBe('收到拒绝，结束')
  })

  it('turn 0 调用 turnZeroOnly 工具 → 正常执行（边界条件）', async () => {
    const adapter = makeAdapter([
      // turn 0: 调 turn_zero_only（非 exitsLoop 的 turnZeroOnly 工具）→ 应被正常执行
      { toolCalls: [{ name: 'turn_zero_only', id: 't1', input: {} }], stopReason: 'tool_use' },
      // turn 1: LLM 看到 tool result 后 end_turn
      { text: '完成', stopReason: 'end_turn' },
    ])
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [dummyTurnZeroTool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.totalTurns).toBe(2)
  })
})

describe('query-loop: exitsLoop + agent-exit-tools 联动', () => {
  it('真实 supplement_task 工具：turn 0 调 → exitToolCall 含 task_id 和 supplement_text', async () => {
    const { supplementTaskTool } = await import('../../src/agent/agent-exit-tools.js')
    const tool = supplementTaskTool(['task-A', 'task-B'])

    const adapter = makeAdapter([
      {
        toolCalls: [{
          name: 'supplement_task',
          id: 's1',
          input: { target_task_id: 'task-A', supplement_text: '别用 cuda，用 mps' },
        }],
        stopReason: 'tool_use',
      },
    ])

    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [tool],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.exitToolCall).toEqual({
      name: 'supplement_task',
      input: { target_task_id: 'task-A', supplement_text: '别用 cuda，用 mps' },
    })
  })

  it('真实 stay_silent 工具：turn 0 调 → exitToolCall 含 reason', async () => {
    const { STAY_SILENT_TOOL } = await import('../../src/agent/agent-exit-tools.js')

    const adapter = makeAdapter([
      {
        toolCalls: [{
          name: 'stay_silent',
          id: 'ss1',
          input: { reason: '群成员之间互相讨论' },
        }],
        stopReason: 'tool_use',
      },
    ])

    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        tools: [STAY_SILENT_TOOL],
        systemPrompt: '',
        model: 'test',
      },
    })

    expect(result.outcome).toBe('completed')
    expect(result.exitToolCall).toEqual({
      name: 'stay_silent',
      input: { reason: '群成员之间互相讨论' },
    })
  })
})
