import { describe, it, expect } from 'vitest'
import { sliceSpanMessages, findToolIO, extractAssistantOutput } from './messageSlicing'
import type { EngineMessageLike } from '../../services/trace'

describe('sliceSpanMessages', () => {
  it('按 message_count_after 切出本轮产出', () => {
    // span0 无前置 user，messages 直接从 assistant 起（firstAssistant=0 → prev=0）
    // 两个 llm span：第一轮 count=2（产出 a1+tr1 即 index 0..2），第二轮 count=3（产出 a2 即 2..3）
    const messages = [
      { id: 'a1', role: 'assistant' },
      { id: 'tr1', role: 'tool_result' },
      { id: 'a2', role: 'assistant' },
    ]
    const spans = [{ message_count_after: 2 }, { message_count_after: 3 }]
    expect(sliceSpanMessages(messages, spans, 0)).toEqual([
      { id: 'a1', role: 'assistant' },
      { id: 'tr1', role: 'tool_result' },
    ])
    expect(sliceSpanMessages(messages, spans, 1)).toEqual([{ id: 'a2', role: 'assistant' }])
  })

  it('第一个 span 从索引 0 开始切（无前置 user 消息时）', () => {
    const messages = [
      { id: 'm0', role: 'assistant' },
      { id: 'm1', role: 'tool_result' },
      { id: 'm2', role: 'assistant' },
    ]
    const spans = [{ message_count_after: 2 }]
    expect(sliceSpanMessages(messages, spans, 0)).toEqual([
      { id: 'm0', role: 'assistant' },
      { id: 'm1', role: 'tool_result' },
    ])
  })

  it('span0 含前置 user 输入时，只切出从首条 assistant 起的产出', () => {
    // 前置 user 是触发消息 / resume 恢复历史，不算本轮产出
    // messages=[user, assistant:a1, tool_result:tr1, assistant:a2], mca=[3,4]
    // span0 → [a1, tr1]（从 index1 起），span1 → [a2]
    const messages = [
      { id: 'trigger', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'tr1', role: 'tool_result' },
      { id: 'a2', role: 'assistant' },
    ]
    const spans = [{ message_count_after: 3 }, { message_count_after: 4 }]
    expect(sliceSpanMessages(messages, spans, 0)).toEqual([
      { id: 'a1', role: 'assistant' },
      { id: 'tr1', role: 'tool_result' },
    ])
    expect(sliceSpanMessages(messages, spans, 1)).toEqual([{ id: 'a2', role: 'assistant' }])
  })

  it('message_count_after 为 undefined 时返回空数组', () => {
    const messages = [{ id: 'u', role: 'user' }, { id: 'a1', role: 'assistant' }]
    const spans = [{}]
    expect(sliceSpanMessages(messages, spans, 0)).toEqual([])
  })

  it('spanIndex 越界时返回空数组', () => {
    const messages = [{ id: 'u', role: 'user' }]
    const spans = [{ message_count_after: 1 }]
    expect(sliceSpanMessages(messages, spans, 5)).toEqual([])
  })
})

describe('findToolIO', () => {
  it('按 tool_use_id 取完整 input(assistant content)与 output(toolResults)', () => {
    const messages: EngineMessageLike[] = [
      { id: 'a1', role: 'assistant', content: [
        { type: 'text', text: '我来调用工具' },
        { type: 'tool_use', id: 'tu_1', name: 'set_task_goal', input: { objective: '长内容'.repeat(50) } },
      ], timestamp: 100 },
      { id: 'tr1', role: 'user', toolResults: [
        { tool_use_id: 'tu_1', content: 'ok 结果'.repeat(50), is_error: false },
      ], timestamp: 101 },
    ]
    const io = findToolIO(messages, 'tu_1')
    expect(io).not.toBeNull()
    expect(io!.input).toEqual({ objective: '长内容'.repeat(50) })
    expect(io!.output).toBe('ok 结果'.repeat(50))
    expect(io!.isError).toBe(false)
  })

  it('同轮并行两个同名工具按 id 各取各的,不串', () => {
    const messages: EngineMessageLike[] = [
      { id: 'a1', role: 'assistant', content: [
        { type: 'tool_use', id: 'tu_a', name: 'read', input: { path: '/a' } },
        { type: 'tool_use', id: 'tu_b', name: 'read', input: { path: '/b' } },
      ], timestamp: 100 },
      { id: 'tr1', role: 'user', toolResults: [
        { tool_use_id: 'tu_a', content: 'AAA', is_error: false },
        { tool_use_id: 'tu_b', content: 'BBB', is_error: false },
      ], timestamp: 101 },
    ]
    expect(findToolIO(messages, 'tu_a')!.output).toBe('AAA')
    expect(findToolIO(messages, 'tu_b')!.output).toBe('BBB')
    expect(findToolIO(messages, 'tu_b')!.input).toEqual({ path: '/b' })
  })

  it('is_error 透出', () => {
    const messages: EngineMessageLike[] = [
      { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'x', input: {} }], timestamp: 100 },
      { id: 'tr1', role: 'user', toolResults: [{ tool_use_id: 'tu_1', content: 'boom', is_error: true }], timestamp: 101 },
    ]
    expect(findToolIO(messages, 'tu_1')!.isError).toBe(true)
  })

  it('id 不存在返回 null', () => {
    expect(findToolIO([], 'nope')).toBeNull()
  })
})

describe('extractAssistantOutput', () => {
  it('只返回 assistant 文本 + 工具名,不含 tool_result 内容', () => {
    const slice: EngineMessageLike[] = [
      { id: 'a1', role: 'assistant', content: [
        { type: 'text', text: '我先固化目标' },
        { type: 'tool_use', id: 'tu_1', name: 'set_task_goal', input: { objective: 'X' } },
      ], timestamp: 100 },
      { id: 'tr1', role: 'user', toolResults: [{ tool_use_id: 'tu_1', content: '机密结果', is_error: false }], timestamp: 101 },
    ]
    const out = extractAssistantOutput(slice)
    expect(out.text).toBe('我先固化目标')
    expect(out.toolNames).toEqual(['set_task_goal'])
    expect(JSON.stringify(out)).not.toContain('机密结果')
  })

  it('纯文本无工具轮只返回文本', () => {
    const slice: EngineMessageLike[] = [{ id: 'a1', role: 'assistant', content: [{ type: 'text', text: '完成了' }], timestamp: 100 }]
    const out = extractAssistantOutput(slice)
    expect(out.text).toBe('完成了')
    expect(out.toolNames).toEqual([])
  })
})
