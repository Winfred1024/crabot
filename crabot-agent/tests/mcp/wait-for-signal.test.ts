import { describe, it, expect } from 'vitest'
import { createWaitForSignalTool } from '../../src/mcp/wait-for-signal.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'
import type { ToolCallContext } from '../../src/engine/types.js'

describe('wait_for_signal', () => {
  it('returns error when no pending event exists', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool({
      humanQueue,
      hasActiveAudit: () => false,
      hasActiveAsyncSubagent: () => false,
    })
    const result = await tool.call({ reason: 'test' }, {} as ToolCallContext)
    expect(result.isError).toBe(true)
    expect(result.output).toContain('无 pending')
    // assert observable: barrier NOT set
    expect(humanQueue.hasBarrier).toBe(false)
  })

  it('sets barrier when audit is active', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool({
      humanQueue,
      hasActiveAudit: () => true,
      hasActiveAsyncSubagent: () => false,
    })
    const result = await tool.call({ reason: 'await audit' }, {} as ToolCallContext)
    expect(result.isError).toBe(false)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('sets barrier when async subagent is active', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool({
      humanQueue,
      hasActiveAudit: () => false,
      hasActiveAsyncSubagent: () => true,
    })
    await tool.call({ reason: 'await subagent' }, {} as ToolCallContext)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })

  it('sets barrier when humanQueue has pending push', async () => {
    const humanQueue = new HumanMessageQueue()
    humanQueue.push('pending message')
    const tool = createWaitForSignalTool({
      humanQueue,
      hasActiveAudit: () => false,
      hasActiveAsyncSubagent: () => false,
    })
    await tool.call({ reason: 'await pending' }, {} as ToolCallContext)
    expect(humanQueue.hasBarrier).toBe(true)
    humanQueue.clearBarrier()
  })
})
