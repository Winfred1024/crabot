import { describe, it, expect } from 'vitest'
import { REPLY_TOOL } from '../../src/agent/front-tools.js'

describe('REPLY_TOOL — emotion 字段 (D.2)', () => {
  it('inputSchema.properties 含 emotion enum', () => {
    expect(REPLY_TOOL.inputSchema.properties).toHaveProperty('emotion')
    const emotion = (REPLY_TOOL.inputSchema.properties as any).emotion
    expect(Array.isArray(emotion.enum)).toBe(true)
    expect(emotion.enum).toContain('neutral')
    expect(emotion.enum).toContain('frustrated')
  })
})
