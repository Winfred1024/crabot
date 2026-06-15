/**
 * deps 桥接测试：把 crabot managers 接成引擎要的 ImportDeps。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §8
 */
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { buildImportDeps } from './build-import-deps.js'

function makeManagers() {
  return {
    listProviderNames: () => ['existing-p'],
    createProvider: vi.fn(async () => ({ id: 'p1' })),
    listChannelNames: () => ['existing-c'],
    createChannel: vi.fn(async () => ({ id: 'c1' })),
    listMcpNames: () => ['existing-m'],
    importMcpJson: vi.fn(async () => []),
    listSkillNames: () => ['existing-s'],
    importSkillDir: vi.fn(async () => ({})),
    writeLongTerm: vi.fn(async () => ({ id: 'mem1' })),
    workspaceDir: '/data/workspace',
  }
}

describe('buildImportDeps', () => {
  it('把各 manager 的 list 转成 existing*Names Set', () => {
    const deps = buildImportDeps(makeManagers())

    expect(deps.existingProviderNames.has('existing-p')).toBe(true)
    expect(deps.existingChannelNames.has('existing-c')).toBe(true)
    expect(deps.existingMcpNames.has('existing-m')).toBe(true)
    expect(deps.existingSkillNames.has('existing-s')).toBe(true)
  })

  it('createProvider/createChannel/importMcpJson/importSkillDir/writeLongTerm 透传', async () => {
    const m = makeManagers()
    const deps = buildImportDeps(m)

    await deps.createProvider({ name: 'x' } as never)
    await deps.createChannel({ name: 'y' } as never)
    await deps.importMcpJson('{}')
    await deps.importSkillDir('/tmp/skill')
    await deps.writeLongTerm({ type: 'fact', content: 'c' })

    expect(m.createProvider).toHaveBeenCalledTimes(1)
    expect(m.createChannel).toHaveBeenCalledTimes(1)
    expect(m.importMcpJson).toHaveBeenCalledWith('{}')
    expect(m.importSkillDir).toHaveBeenCalledWith('/tmp/skill')
    expect(m.writeLongTerm).toHaveBeenCalledWith({ type: 'fact', content: 'c' })
  })

  it('workspaceDestDir = workspaceDir/openclaw-workspace（独立子目录避免 clobber）', () => {
    const deps = buildImportDeps(makeManagers())

    expect(deps.workspaceDestDir).toBe(path.join('/data/workspace', 'openclaw-workspace'))
  })
})
