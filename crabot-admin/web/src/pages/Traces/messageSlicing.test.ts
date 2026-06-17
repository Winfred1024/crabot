import { describe, it, expect } from 'vitest'
import { sliceSpanMessages } from './messageSlicing'

describe('sliceSpanMessages', () => {
  it('按 message_count_after 切出本轮产出', () => {
    // messages 仅包含 run 期间产出的消息（不含初始 user prompt），
    // message_count_after 从 0 起绝对计数。
    // 两个 llm span：第一轮 count=2（产出 a1+tr1 即 index 0..2），第二轮 count=3（产出 a2 即 2..3）
    const messages = [{ id: 'a1' }, { id: 'tr1' }, { id: 'a2' }] as never[]
    const spans = [{ message_count_after: 2 }, { message_count_after: 3 }]
    expect(sliceSpanMessages(messages, spans, 0)).toEqual([{ id: 'a1' }, { id: 'tr1' }])
    expect(sliceSpanMessages(messages, spans, 1)).toEqual([{ id: 'a2' }])
  })

  it('第一个 span 从索引 0 开始切', () => {
    const messages = [{ id: 'm0' }, { id: 'm1' }, { id: 'm2' }] as never[]
    const spans = [{ message_count_after: 2 }]
    expect(sliceSpanMessages(messages, spans, 0)).toEqual([{ id: 'm0' }, { id: 'm1' }])
  })

  it('message_count_after 为 undefined 时返回空数组', () => {
    const messages = [{ id: 'u' }, { id: 'a1' }] as never[]
    const spans = [{}]
    expect(sliceSpanMessages(messages, spans, 0)).toEqual([])
  })

  it('spanIndex 越界时返回空数组', () => {
    const messages = [{ id: 'u' }] as never[]
    const spans = [{ message_count_after: 1 }]
    expect(sliceSpanMessages(messages, spans, 5)).toEqual([])
  })
})
