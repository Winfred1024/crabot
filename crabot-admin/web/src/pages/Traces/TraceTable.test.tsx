import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { GroupedTableRow, AuditBadge, TraceTableRow } from './TraceTable'
import type { TraceGroup } from './utils'
import type { TraceIndexEntry } from '../../services/trace'

function entry(over: Partial<TraceIndexEntry>): TraceIndexEntry {
  return {
    trace_id: 't1',
    related_task_id: 'task-x',
    trigger_type: 'task',
    trigger_summary: 'task summary',
    started_at: '2026-05-21T00:04:26Z',
    ended_at: '2026-05-21T00:08:00Z',
    duration_ms: 214000,
    status: 'completed',
    span_count: 10,
    ...over,
  } as TraceIndexEntry
}

function makeGroup(members: TraceIndexEntry[]): TraceGroup {
  return {
    taskId: 'task-x',
    primary: members[0]!,
    members,
    status: 'completed',
    earliestStartedAt: members[0]!.started_at,
    totalSpans: members.reduce((s, m) => s + m.span_count, 0),
  }
}

function renderGrouped(group: TraceGroup) {
  return render(
    <table>
      <tbody>
        <GroupedTableRow
          group={group}
          selectedTraceId={null}
          onSelectTrace={() => {}}
          onFilterByTask={() => {}}
          onJumpToTrace={() => {}}
          defaultExpanded={true}
        />
      </tbody>
    </table>,
  )
}

describe('GroupedTableRow — sub_agent_call 行视觉', () => {
  it('展开后会列出 sub_agent_call 行，并显示 Sub-agent badge', () => {
    const group = makeGroup([
      entry({ trace_id: 'dispatch-1', trigger_type: 'message', trigger_summary: '[private] do L2' }),
      entry({ trace_id: 'task-1', trigger_type: 'task', trigger_summary: 'doing L2' }),
      entry({
        trace_id: 'sub-1',
        trigger_type: 'sub_agent_call',
        trigger_summary: '[code_writer] rewrite l2 module',
        parent_trace_id: 'task-1',
        span_count: 12,
      }),
    ])
    renderGrouped(group)
    expect(screen.getByText('Sub-agent')).toBeInTheDocument()
    expect(screen.getByText(/code_writer/)).toBeInTheDocument()
  })

  it('sub_agent_call 行用 ↳ 前缀（区分于普通 └）+ 带 tooltip', () => {
    const group = makeGroup([
      entry({ trace_id: 'task-1', trigger_type: 'task' }),
      entry({
        trace_id: 'sub-1',
        trigger_type: 'sub_agent_call',
        trigger_summary: '[code_writer] do x',
        parent_trace_id: 'task-1',
      }),
    ])
    renderGrouped(group)
    const arrow = screen.getByTitle('Subagent 子 trace（点击进入查看内部 span）')
    expect(arrow.textContent).toBe('↳')
  })

  it('普通 trace 行用 └ 前缀（无 ↳ tooltip）', () => {
    const group = makeGroup([
      entry({ trace_id: 'a', trigger_type: 'message' }),
      entry({ trace_id: 'b', trigger_type: 'task' }),
    ])
    renderGrouped(group)
    expect(screen.queryByTitle(/Subagent 子 trace/)).toBeNull()
  })

  it('展开后 sub_agent_call 行带 task_type=goal_audit 时显示"审计" badge', () => {
    const group = makeGroup([
      entry({ trace_id: 'task-1', trigger_type: 'task' }),
      entry({
        trace_id: 'sub-audit',
        trigger_type: 'sub_agent_call',
        trigger_summary: '[goal_audit] check AC',
        parent_trace_id: 'task-1',
        trigger_task_type: 'goal_audit',
      }),
    ])
    renderGrouped(group)
    expect(screen.getByText('审计')).toBeInTheDocument()
  })

  it('点击 sub_agent_call 行调 onSelectTrace 跳进 trace 详情（去看 SpanTree）', () => {
    let selected = ''
    const group = makeGroup([
      entry({ trace_id: 'task-1', trigger_type: 'task' }),
      entry({ trace_id: 'sub-99', trigger_type: 'sub_agent_call', trigger_summary: '[code_writer] do x' }),
    ])
    render(
      <table>
        <tbody>
          <GroupedTableRow
            group={group}
            selectedTraceId={null}
            onSelectTrace={(id) => { selected = id }}
            onFilterByTask={() => {}}
            onJumpToTrace={() => {}}
            defaultExpanded={true}
          />
        </tbody>
      </table>,
    )
    const subRow = screen.getByText(/code_writer/).closest('tr')!
    fireEvent.click(subRow)
    expect(selected).toBe('sub-99')
  })
})

describe('AuditBadge — goal_audit 高亮', () => {
  it('taskType=goal_audit 渲染"审计"', () => {
    render(<AuditBadge taskType="goal_audit" />)
    expect(screen.getByText('审计')).toBeInTheDocument()
  })

  it('taskType 缺省 / 其他值 不渲染', () => {
    const { container, rerender } = render(<AuditBadge taskType={undefined} />)
    expect(container.firstChild).toBeNull()
    rerender(<AuditBadge taskType="other_subtask" />)
    expect(container.firstChild).toBeNull()
  })
})

describe('TraceTableRow — 顶层 trace 行 goal_audit badge', () => {
  it('trigger_task_type=goal_audit 显示"审计"', () => {
    render(
      <table>
        <tbody>
          <TraceTableRow
            entry={entry({
              trace_id: 'goal-audit-trace',
              trigger_type: 'sub_agent_call',
              trigger_summary: '[goal_audit] check AC',
              trigger_task_type: 'goal_audit',
            })}
            isSelected={false}
            onClick={() => {}}
          />
        </tbody>
      </table>,
    )
    expect(screen.getByText('审计')).toBeInTheDocument()
  })

  it('普通 trace 行不显示"审计" badge', () => {
    render(
      <table>
        <tbody>
          <TraceTableRow
            entry={entry({ trace_id: 'normal', trigger_type: 'task' })}
            isSelected={false}
            onClick={() => {}}
          />
        </tbody>
      </table>,
    )
    expect(screen.queryByText('审计')).toBeNull()
  })
})
