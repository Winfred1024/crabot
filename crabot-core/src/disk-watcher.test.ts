import { describe, it, expect, vi } from 'vitest'
import { checkDiskLow, type DiskCheckResult } from './disk-watcher.js'

describe('checkDiskLow', () => {
  it('returns ok when available >= threshold', async () => {
    const fakeStatfs = vi.fn().mockResolvedValue({
      bavail: BigInt(2_000_000),
      blocks: BigInt(10_000_000),
      bsize: 4096,
    })
    const r: DiskCheckResult = await checkDiskLow('/data', 1_000_000_000, fakeStatfs)
    expect(r.is_low).toBe(false)
    expect(r.available_bytes).toBe(2_000_000 * 4096)
  })

  it('returns low when available < threshold', async () => {
    const fakeStatfs = vi.fn().mockResolvedValue({
      bavail: BigInt(100), // 100 * 4096 = 409600 bytes
      blocks: BigInt(10_000_000),
      bsize: 4096,
    })
    const r = await checkDiskLow('/data', 1_000_000_000, fakeStatfs)
    expect(r.is_low).toBe(true)
    expect(r.payload).toBeDefined()
    expect(r.payload!.threshold_bytes).toBe(1_000_000_000)
    expect(r.payload!.available_bytes).toBe(409600)
  })

  it('handles statfs failure gracefully', async () => {
    const fakeStatfs = vi.fn().mockRejectedValue(new Error('EACCES'))
    const r = await checkDiskLow('/data', 1_000_000_000, fakeStatfs)
    expect(r.is_low).toBe(false)
    expect(r.error).toBeDefined()
  })
})
