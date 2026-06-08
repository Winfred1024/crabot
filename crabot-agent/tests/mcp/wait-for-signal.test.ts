import { describe, it, expect, vi } from 'vitest'
import { createWaitForSignalTool, WAIT_FOR_SIGNAL_TIMEOUT_MS } from '../../src/mcp/wait-for-signal.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

describe('wait_for_signal', () => {
  it('returns error when no pending event exists', async () => {
    const humanQueue = new HumanMessageQueue()
    const tool = createWaitForSignalTool({
      humanQueue,
      hasActiveAudit: () => false,
      hasActiveAsyncSubagent: () => false,
    })
    const result = await tool.call({ reason: 'test' }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('无 pending')
  })

  it('sets barrier when audit is active', async () => {
    const humanQueue = new HumanMessageQueue()
    const setBarrier = vi.spyOn(humanQueue, 'setBarrier')
    const tool = createWaitForSignalTool({
      humanQueue,
      hasActiveAudit: () => true,
      hasActiveAsyncSubagent: () => false,
    })
    const result = await tool.call({ reason: 'await audit' }, {})
    expect(result.isError).toBe(false)
    expect(setBarrier).toHaveBeenCalledWith(WAIT_FOR_SIGNAL_TIMEOUT_MS)
    humanQueue.clearBarrier()
  })

  it('sets barrier when async subagent is active', async () => {
    const humanQueue = new HumanMessageQueue()
    const setBarrier = vi.spyOn(humanQueue, 'setBarrier')
    const tool = createWaitForSignalTool({
      humanQueue,
      hasActiveAudit: () => false,
      hasActiveAsyncSubagent: () => true,
    })
    await tool.call({ reason: 'await subagent' }, {})
    expect(setBarrier).toHaveBeenCalled()
    humanQueue.clearBarrier()
  })

  it('sets barrier when humanQueue has pending push', async () => {
    const humanQueue = new HumanMessageQueue()
    humanQueue.push('pending message')
    const setBarrier = vi.spyOn(humanQueue, 'setBarrier')
    const tool = createWaitForSignalTool({
      humanQueue,
      hasActiveAudit: () => false,
      hasActiveAsyncSubagent: () => false,
    })
    await tool.call({ reason: 'await pending' }, {})
    expect(setBarrier).toHaveBeenCalled()
    humanQueue.clearBarrier()
  })
})
