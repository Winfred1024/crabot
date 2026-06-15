/**
 * OpenClaw backup manifest.json 校验测试。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §4
 * manifest 形态来自 OpenClaw src/infra/backup-create.ts 的 BackupManifest。
 */
import { describe, it, expect } from 'vitest'
import { validateManifest } from './validate-manifest.js'

const validRaw = {
  schemaVersion: 1,
  createdAt: '2026-06-15T00:00:00.000Z',
  archiveRoot: '2026-06-15T00-00-00.000Z-openclaw-backup',
  runtimeVersion: '1.2.3',
  platform: 'darwin',
  nodeVersion: 'v22.0.0',
  options: { includeWorkspace: true, onlyConfig: false },
  paths: { stateDir: '/h/.openclaw', configPath: '/h/.openclaw/openclaw.json', oauthDir: '/h/.openclaw/credentials', workspaceDirs: ['/h/.openclaw/workspace'] },
  assets: [],
  skipped: [],
}

describe('validateManifest', () => {
  it('合法 manifest → ok，带出 includeWorkspace 等', () => {
    const r = validateManifest(validRaw)

    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.schemaVersion).toBe(1)
      expect(r.includeWorkspace).toBe(true)
      expect(r.createdAt).toBe('2026-06-15T00:00:00.000Z')
    }
  })

  it('options.includeWorkspace=false → 如实带出（用于灰显记忆/workspace）', () => {
    const r = validateManifest({ ...validRaw, options: { includeWorkspace: false } })

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.includeWorkspace).toBe(false)
  })

  it('schemaVersion 非 1 → 拒绝，error 提示版本不支持', () => {
    const r = validateManifest({ ...validRaw, schemaVersion: 2 })

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/版本|version|不支持/i)
  })

  it('非对象 / null → 拒绝', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest('x').ok).toBe(false)
    expect(validateManifest(42).ok).toBe(false)
  })

  it('缺 schemaVersion → 拒绝', () => {
    const { schemaVersion, ...noVersion } = validRaw
    void schemaVersion
    expect(validateManifest(noVersion).ok).toBe(false)
  })

  it('缺 options → includeWorkspace 默认按 false（保守，触发灰显提示）', () => {
    const { options, ...noOptions } = validRaw
    void options
    const r = validateManifest(noOptions)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.includeWorkspace).toBe(false)
  })
})
