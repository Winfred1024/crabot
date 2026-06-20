import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SpanDetailPanel } from './SpanDetailPanel'
import type { AgentSpan, EngineMessageLike } from '../../services/trace'

function span(over: Partial<AgentSpan>): AgentSpan {
  return {
    span_id: 's1', trace_id: 't1', type: 'tool_call',
    started_at: '2026-06-20T00:00:00Z', ended_at: '2026-06-20T00:00:01Z',
    status: 'completed', parent_span_id: undefined, details: {},
    ...over,
  } as AgentSpan
}

const messages: EngineMessageLike[] = [
  { id: 'a1', role: 'assistant' as const, timestamp: 0, content: [
    { type: 'text', text: '我来固化目标' },
    { type: 'tool_use', id: 'tu_1', name: 'set_task_goal', input: { objective: 'OBJ_FULL_CONTENT' } },
  ] as unknown[] },
  { id: 'tr1', role: 'user' as const, timestamp: 0, toolResults: [
    { tool_use_id: 'tu_1', content: 'OUT_FULL_CONTENT', is_error: false },
  ] as unknown[] },
]

describe('SpanDetailPanel tool span', () => {
  it('有 tool_use_id 且 messages 命中 → 渲染完整 I/O', () => {
    render(<SpanDetailPanel
      span={span({ type: 'tool_call', details: { tool_name: 'set_task_goal', input_summary: 'TRUNC', tool_use_id: 'tu_1' } as never })}
      messages={messages}
    />)
    expect(screen.getByText(/OBJ_FULL_CONTENT/)).toBeTruthy()
    expect(screen.getByText(/OUT_FULL_CONTENT/)).toBeTruthy()
  })

  it('无 messages(子 trace 场景)→ 回退截断摘要', () => {
    render(<SpanDetailPanel
      span={span({ type: 'tool_call', details: { tool_name: 'set_task_goal', input_summary: 'TRUNC_IN', output_summary: 'TRUNC_OUT', tool_use_id: 'tu_1' } as never })}
    />)
    expect(screen.getByText(/TRUNC_IN/)).toBeTruthy()
    expect(screen.getByText(/TRUNC_OUT/)).toBeTruthy()
  })
})

describe('SpanDetailPanel llm span', () => {
  it('渲染模型文本 + 工具名,不出现工具结果正文', () => {
    const llmSpan = span({
      span_id: 'llm1', type: 'llm_call',
      details: { iteration: 1, message_count_after: 2 } as never,
    })
    render(<SpanDetailPanel
      span={llmSpan}
      messages={messages}
      orderedLlmSpans={[{ span_id: 'llm1', message_count_after: 2 }]}
      spanIndexInLlm={0}
    />)
    expect(screen.getByText(/我来固化目标/)).toBeTruthy()
    expect(screen.getByText(/set_task_goal/)).toBeTruthy()
    expect(screen.queryByText(/OUT_FULL_CONTENT/)).toBeNull()
  })
})
