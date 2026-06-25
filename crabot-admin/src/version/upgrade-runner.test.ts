import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readUpgradeStatus, canUpgrade } from './upgrade-runner.js'
import type { VersionState } from './types.js'

function tmpDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crabot-up-'))
  mkdirSync(join(d, 'admin'), { recursive: true })
  return join(d, 'admin')
}

describe('readUpgradeStatus', () => {
  it('文件不存在返回 null', () => {
    expect(readUpgradeStatus(tmpDataDir())).toBeNull()
  })
  it('读已写入的状态', () => {
    const dir = tmpDataDir()
    writeFileSync(join(dir, 'upgrade-status.json'), JSON.stringify({ phase: 'done', started_at: 'x' }))
    expect(readUpgradeStatus(dir)?.phase).toBe('done')
  })
})

describe('canUpgrade', () => {
  const base = (over: Partial<VersionState>): VersionState => ({
    current_version: 'a', latest_version: 'b', upgrade_available: true,
    upgrade_capability: 'release', last_checked: null, checking: false, ...over,
  })
  it('release 有更新 → 允许', () => {
    expect(canUpgrade(base({})).ok).toBe(true)
  })
  it('system → 拒绝', () => {
    expect(canUpgrade(base({ upgrade_capability: 'system' })).ok).toBe(false)
  })
  it('source 有 blockers → 拒绝', () => {
    expect(canUpgrade(base({ upgrade_capability: 'source', source_blockers: ['工作区有未提交改动'] })).ok).toBe(false)
  })
  it('source 干净 → 允许', () => {
    expect(canUpgrade(base({ upgrade_capability: 'source', source_blockers: [] })).ok).toBe(true)
  })
  it('无可用更新 → 拒绝', () => {
    expect(canUpgrade(base({ upgrade_available: false })).ok).toBe(false)
  })
})
