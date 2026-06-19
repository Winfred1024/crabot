import { describe, it, expect } from 'vitest'
import { buildManifest, validateBackupManifest } from './manifest.js'

describe('manifest', () => {
  it('buildManifest 产出 product=crabot 的合法 manifest', () => {
    const m = buildManifest({
      categories: ['config', 'memory'],
      includeSecrets: false,
      runtimeVersion: '1.2.3',
      createdAt: '2026-06-19T00:00:00Z',
    })
    expect(m.product).toBe('crabot')
    expect(m.schemaVersion).toBe(1)
    expect(m.categories).toEqual(['config', 'memory'])
    expect(m.includeSecrets).toBe(false)
  })

  it('validate 认 crabot 归档', () => {
    const m = buildManifest({ categories: ['config'], includeSecrets: true, runtimeVersion: 'x', createdAt: 'y' })
    const r = validateBackupManifest(m)
    expect(r.ok).toBe(true)
  })

  it('validate 拒绝非 crabot product', () => {
    const r = validateBackupManifest({ schemaVersion: 1, product: 'openclaw', categories: [] })
    expect(r.ok).toBe(false)
  })

  it('validate 拒绝比当前新的 schemaVersion', () => {
    const r = validateBackupManifest({ schemaVersion: 2, product: 'crabot', categories: ['config'] })
    expect(r.ok).toBe(false)
  })

  it('validate 丢弃未知类别', () => {
    const r = validateBackupManifest({ schemaVersion: 1, product: 'crabot', categories: ['config', 'chat'] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.categories).toEqual(['config'])
  })
})
