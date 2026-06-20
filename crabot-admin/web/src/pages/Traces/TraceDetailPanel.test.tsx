import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TraceDetailPanel } from './index'
import type { AgentTrace } from '../../services/trace'

function workerTrace(over: Partial<AgentTrace> = {}): AgentTrace {
  return {
    trace_id: 'wt1', status: 'completed',
    started_at: '2026-06-20T00:00:00Z', duration_ms: 1000,
    trigger: { type: 'task', summary: '做个页面' },
    spans: [],
    resume_checkpoint: {
      agent_version: 'x', system_prompt: 'SYS_PROMPT_MARKER',
      messages: [{ id: 'a1', role: 'assistant', timestamp: 0, content: [{ type: 'text', text: 'CONV_TEXT_MARKER' }] }],
      worker_state: { todo_items: [] },
    },
    ...over,
  } as unknown as AgentTrace
}

describe('TraceDetailPanel 完整对话', () => {
  it('worker trace 顶部有「完整对话」按钮,不再有独立「对话(N 条消息)」区块', () => {
    render(<TraceDetailPanel trace={workerTrace()} loading={false} />)
    expect(screen.getByRole('button', { name: /完整对话/ })).toBeTruthy()
    expect(screen.queryByText(/条消息）/)).toBeNull()
  })

  it('点按钮打开弹窗,含 System Prompt 与对话内容', () => {
    render(<TraceDetailPanel trace={workerTrace()} loading={false} />)
    fireEvent.click(screen.getByRole('button', { name: /完整对话/ }))
    expect(screen.getByText(/CONV_TEXT_MARKER/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /System Prompt/ }))
    expect(screen.getByText(/SYS_PROMPT_MARKER/)).toBeTruthy()
  })

  it('非 worker trace(无 resume_checkpoint)无「完整对话」按钮', () => {
    const t = workerTrace({ trigger: { type: 'dispatcher', summary: 'x' } as never, resume_checkpoint: undefined as never })
    render(<TraceDetailPanel trace={t} loading={false} />)
    expect(screen.queryByRole('button', { name: /完整对话/ })).toBeNull()
  })
})
