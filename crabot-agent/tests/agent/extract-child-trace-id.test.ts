import { describe, it, expect } from 'vitest'
import { extractChildTraceIdFromOutput } from '../../src/agent/agent-handler.js'

describe('extractChildTraceIdFromOutput', () => {
  it('从 delegate_task 风格的 JSON output 提取 child_trace_id', () => {
    const output = JSON.stringify({
      output: '...subagent 文字结果...',
      outcome: 'completed',
      totalTurns: 12,
      child_trace_id: 'abc-123',
    })
    expect(extractChildTraceIdFromOutput(output)).toBe('abc-123')
  })

  it('JSON 不含 child_trace_id 时返回 undefined', () => {
    expect(extractChildTraceIdFromOutput(JSON.stringify({ output: 'ok' }))).toBeUndefined()
  })

  it('非 JSON 字符串返回 undefined（不抛错）', () => {
    expect(extractChildTraceIdFromOutput('plain text result')).toBeUndefined()
  })

  it('child_trace_id 字段为非字符串时返回 undefined', () => {
    expect(extractChildTraceIdFromOutput(JSON.stringify({ child_trace_id: 123 }))).toBeUndefined()
    expect(extractChildTraceIdFromOutput(JSON.stringify({ child_trace_id: null }))).toBeUndefined()
  })

  it('child_trace_id 为空字符串返回 undefined', () => {
    expect(extractChildTraceIdFromOutput(JSON.stringify({ child_trace_id: '' }))).toBeUndefined()
  })

  it('output 是 undefined / 空串时返回 undefined', () => {
    expect(extractChildTraceIdFromOutput(undefined)).toBeUndefined()
    expect(extractChildTraceIdFromOutput('')).toBeUndefined()
  })
})
