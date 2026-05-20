import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startTraceCleanupCron } from './trace-cleanup-cron.js'

describe('startTraceCleanupCron', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips when trace_retention_days is null', async () => {
    const callCleanup = vi.fn().mockResolvedValue({ affected_count: 0, affected_bytes: 0 })
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({ trace_retention_days: null }),
      callCleanup,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanup).not.toHaveBeenCalled()
    stop()
  })

  it('skips when trace_retention_days is undefined', async () => {
    const callCleanup = vi.fn().mockResolvedValue({ affected_count: 0, affected_bytes: 0 })
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({}),
      callCleanup,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanup).not.toHaveBeenCalled()
    stop()
  })

  it('calls callCleanup with retention days when set', async () => {
    const callCleanup = vi.fn().mockResolvedValue({ affected_count: 5, affected_bytes: 1024 })
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({ trace_retention_days: 30 }),
      callCleanup,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanup).toHaveBeenCalledWith(30)
    stop()
  })

  it('swallows errors and continues', async () => {
    const callCleanup = vi.fn().mockRejectedValue(new Error('agent down'))
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({ trace_retention_days: 7 }),
      callCleanup,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanup).toHaveBeenCalled()
    stop()
  })

  it('stop() clears timer', () => {
    const clearIntervalFn = vi.fn()
    const setIntervalFn = vi.fn().mockReturnValue('fake-timer')
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({}),
      callCleanup: vi.fn(),
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: clearIntervalFn as never,
    })
    stop()
    expect(clearIntervalFn).toHaveBeenCalledWith('fake-timer')
  })
})
