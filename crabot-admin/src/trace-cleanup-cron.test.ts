import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startTraceCleanupCron, parseCleanupParams } from './trace-cleanup-cron.js'

describe('startTraceCleanupCron', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const mkOk = () => vi.fn().mockResolvedValue({ affected_count: 0, affected_bytes: 0 })

  it('skips when both retention fields are null', async () => {
    const callCleanup = mkOk()
    const callCleanupByCount = mkOk()
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({ trace_retention_days: null, trace_retention_count: null }),
      callCleanup,
      callCleanupByCount,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanup).not.toHaveBeenCalled()
    expect(callCleanupByCount).not.toHaveBeenCalled()
    stop()
  })

  it('skips when both retention fields are undefined', async () => {
    const callCleanup = mkOk()
    const callCleanupByCount = mkOk()
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({}),
      callCleanup,
      callCleanupByCount,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanup).not.toHaveBeenCalled()
    expect(callCleanupByCount).not.toHaveBeenCalled()
    stop()
  })

  it('calls callCleanup with days when trace_retention_days is set', async () => {
    const callCleanup = vi.fn().mockResolvedValue({ affected_count: 5, affected_bytes: 1024 })
    const callCleanupByCount = mkOk()
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({ trace_retention_days: 30 }),
      callCleanup,
      callCleanupByCount,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanup).toHaveBeenCalledWith(30)
    expect(callCleanupByCount).not.toHaveBeenCalled()
    stop()
  })

  it('calls callCleanupByCount with count when only trace_retention_count is set', async () => {
    const callCleanup = mkOk()
    const callCleanupByCount = vi.fn().mockResolvedValue({ affected_count: 7, affected_bytes: 2048 })
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({ trace_retention_count: 100 }),
      callCleanup,
      callCleanupByCount,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanupByCount).toHaveBeenCalledWith(100)
    expect(callCleanup).not.toHaveBeenCalled()
    stop()
  })

  it('prefers days over count when both are set', async () => {
    const callCleanup = mkOk()
    const callCleanupByCount = mkOk()
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({ trace_retention_days: 30, trace_retention_count: 100 }),
      callCleanup,
      callCleanupByCount,
      runImmediately: true,
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(callCleanup).toHaveBeenCalledWith(30)
    expect(callCleanupByCount).not.toHaveBeenCalled()
    stop()
  })

  it('swallows errors and continues', async () => {
    const callCleanup = vi.fn().mockRejectedValue(new Error('agent down'))
    const callCleanupByCount = mkOk()
    const stop = startTraceCleanupCron({
      getGlobalConfig: () => ({ trace_retention_days: 7 }),
      callCleanup,
      callCleanupByCount,
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
      callCleanupByCount: vi.fn(),
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: clearIntervalFn as never,
    })
    stop()
    expect(clearIntervalFn).toHaveBeenCalledWith('fake-timer')
  })
})

describe('parseCleanupParams', () => {
  const url = (qs: string) => new URL(`http://localhost/p${qs ? '?' + qs : ''}`)

  it('rejects missing days', () => {
    const r = parseCleanupParams(url(''))
    expect('error' in r).toBe(true)
  })

  it('rejects days=0', () => {
    const r = parseCleanupParams(url('days=0'))
    expect('error' in r).toBe(true)
  })

  it('rejects non-numeric days', () => {
    const r = parseCleanupParams(url('days=abc'))
    expect('error' in r).toBe(true)
  })

  it('accepts days=30 with dry_run default true', () => {
    const r = parseCleanupParams(url('days=30'))
    expect(r).toEqual({ days: 30, dryRun: true })
  })

  it('accepts days=30 with dry_run=false', () => {
    const r = parseCleanupParams(url('days=30&dry_run=false'))
    expect(r).toEqual({ days: 30, dryRun: false })
  })

  it('accepts days=30 with dry_run=true (explicit)', () => {
    const r = parseCleanupParams(url('days=30&dry_run=true'))
    expect(r).toEqual({ days: 30, dryRun: true })
  })

  it('rejects days=NaN (e.g. days=abc)', () => {
    const r = parseCleanupParams(url('days=abc'))
    expect('error' in r).toBe(true)
  })
})
