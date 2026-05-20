import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SpanTree } from './SpanTree'
import { traceService } from '../../services/trace'
import type { AgentSpan } from '../../services/trace'

vi.mock('../../services/trace')

function span(over: Partial<AgentSpan>): AgentSpan {
  return {
    span_id: 's1',
    trace_id: 't1',
    type: 'agent_loop',
    started_at: '2026-05-19T00:00:00Z',
    ended_at: '2026-05-19T00:00:01Z',
    status: 'completed',
    parent_span_id: undefined,
    details: {},
    ...over,
  } as AgentSpan
}

describe('SpanTree sub_agent_call expansion', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('sub_agent_call 节点显示展开图标', () => {
    const spans: AgentSpan[] = [
      span({ span_id: 's1', type: 'sub_agent_call', details: { child_trace_id: 'child-1', target_module_id: 'code_planner' } as never }),
    ]
    render(<SpanTree spans={spans} expandedDetails={new Set()} toggleDetail={() => {}} />)
    expect(screen.getByRole('button', { name: /展开子 trace/ })).toBeInTheDocument()
  })

  it('点击展开调 traceService.getTrace', async () => {
    const spans: AgentSpan[] = [
      span({ span_id: 's1', type: 'sub_agent_call', details: { child_trace_id: 'child-1', target_module_id: 'researcher' } as never }),
    ]
    ;(traceService.getTrace as ReturnType<typeof vi.fn>).mockResolvedValue({
      trace: {
        trace_id: 'child-1',
        spans: [span({ span_id: 'cs1', trace_id: 'child-1' })],
      },
    })
    render(<SpanTree spans={spans} expandedDetails={new Set()} toggleDetail={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /展开子 trace/ }))
    await waitFor(() => {
      expect(traceService.getTrace).toHaveBeenCalledWith('child-1')
    })
  })

  it('展开后渲染子 trace banner + spans', async () => {
    ;(traceService.getTrace as ReturnType<typeof vi.fn>).mockResolvedValue({
      trace: {
        trace_id: 'child-1',
        spans: [span({ span_id: 'cs1', trace_id: 'child-1', type: 'tool_call', details: { tool_name: 'search', input_summary: '查' } as never })],
      },
    })
    const spans: AgentSpan[] = [
      span({ span_id: 's1', type: 'sub_agent_call', details: { child_trace_id: 'child-1', target_module_id: 'researcher' } as never }),
    ]
    render(<SpanTree spans={spans} expandedDetails={new Set()} toggleDetail={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /展开子 trace/ }))
    // banner div 带 data-testid，等待它出现后检查内容
    const banner = await screen.findByTestId('child-trace-banner')
    expect(banner.textContent).toMatch(/subagent:.*researcher/i)
    // 子 trace 的 tool 标签应出现
    expect(await screen.findByText('tool')).toBeInTheDocument()
  })

  it('一个 agent_loop 多个 sub_agent_call 互不影响', async () => {
    ;(traceService.getTrace as ReturnType<typeof vi.fn>).mockResolvedValue({
      trace: { trace_id: 'any', spans: [span({ span_id: 'cs1', trace_id: 'any' })] },
    })
    const spans: AgentSpan[] = [
      span({ span_id: 's1', type: 'agent_loop' }),
      span({ span_id: 's2', parent_span_id: 's1', type: 'sub_agent_call', details: { child_trace_id: 'a', target_module_id: 'A' } as never }),
      span({ span_id: 's3', parent_span_id: 's1', type: 'sub_agent_call', details: { child_trace_id: 'b', target_module_id: 'B' } as never }),
    ]
    render(<SpanTree spans={spans} expandedDetails={new Set()} toggleDetail={() => {}} />)
    const buttons = screen.getAllByRole('button', { name: /展开子 trace/ })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0])
    await waitFor(() => {
      expect(traceService.getTrace).toHaveBeenCalledWith('a')
    })
    expect(traceService.getTrace).not.toHaveBeenCalledWith('b')
  })

  it('无 child_trace_id 时展开按钮置灰', () => {
    const spans: AgentSpan[] = [
      span({ span_id: 's1', type: 'sub_agent_call', details: { target_module_id: 'old' } as never }),
    ]
    render(<SpanTree spans={spans} expandedDetails={new Set()} toggleDetail={() => {}} />)
    const btn = screen.getByRole('button', { name: /展开子 trace/ })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', expect.stringContaining('无子 trace'))
  })
})

describe('SpanTree tool_call child_trace_id expansion (delegate_task)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('tool_call 带 child_trace_id 时显示展开按钮', () => {
    const spans: AgentSpan[] = [
      span({
        span_id: 's1',
        type: 'tool_call',
        details: {
          tool_name: 'delegate_task',
          input_summary: '{"subagent_type":"code_planner"}',
          child_trace_id: 'child-tc-1',
        } as never,
      }),
    ]
    render(<SpanTree spans={spans} expandedDetails={new Set()} toggleDetail={() => {}} />)
    expect(screen.getByRole('button', { name: /展开子 trace/ })).toBeInTheDocument()
  })

  it('tool_call 无 child_trace_id 时不显示展开按钮', () => {
    const spans: AgentSpan[] = [
      span({
        span_id: 's1',
        type: 'tool_call',
        details: { tool_name: 'Read', input_summary: '{}' } as never,
      }),
    ]
    render(<SpanTree spans={spans} expandedDetails={new Set()} toggleDetail={() => {}} />)
    expect(screen.queryByRole('button', { name: /展开子 trace/ })).not.toBeInTheDocument()
  })

  it('点击 tool_call 的展开按钮加载并渲染子 trace', async () => {
    ;(traceService.getTrace as ReturnType<typeof vi.fn>).mockResolvedValue({
      trace: {
        trace_id: 'child-tc-1',
        spans: [
          span({
            span_id: 'cs1',
            trace_id: 'child-tc-1',
            type: 'tool_call',
            details: { tool_name: 'Bash', input_summary: 'ls' } as never,
          }),
        ],
      },
    })
    const spans: AgentSpan[] = [
      span({
        span_id: 's1',
        type: 'tool_call',
        details: {
          tool_name: 'delegate_task',
          input_summary: '{"subagent_type":"researcher"}',
          child_trace_id: 'child-tc-1',
        } as never,
      }),
    ]
    render(<SpanTree spans={spans} expandedDetails={new Set()} toggleDetail={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /展开子 trace/ }))
    await waitFor(() => {
      expect(traceService.getTrace).toHaveBeenCalledWith('child-tc-1')
    })
    const banner = await screen.findByTestId('child-trace-banner')
    // delegate_task 没有 target_module_id，banner 应该回退到工具名或 unknown
    expect(banner.textContent).toMatch(/subagent:/i)
  })
})
