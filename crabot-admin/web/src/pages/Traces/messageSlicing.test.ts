import { describe, it, expect } from 'vitest'
import { sliceSpanMessages } from './messageSlicing'

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
