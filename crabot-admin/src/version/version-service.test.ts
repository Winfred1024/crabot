import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VersionService } from './version-service.js'

function tmpHome(withGit = false): string {
  const home = mkdtempSync(join(tmpdir(), 'crabot-ver-'))
  if (withGit) mkdirSync(join(home, '.git'))
  return home
}

describe('VersionService capability', () => {
  it('system mode 优先（etcDir 有 cluster.version）', async () => {
    const etc = mkdtempSync(join(tmpdir(), 'crabot-etc-'))
    writeFileSync(join(etc, 'cluster.version'), '1\n')
    const home = tmpHome(true)
    const svc = new VersionService({ crabotHome: home, dataDir: home, etcDir: etc })
    const s = await svc.check()
    expect(s.upgrade_capability).toBe('system')
    expect(s.upgrade_available).toBe(false)
    rmSync(etc, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('release: 比对 VERSION 与 latest tag', async () => {
    const home = tmpHome(false)
    writeFileSync(join(home, 'VERSION'), 'v1.0.0\n')
    const svc = new VersionService({
      crabotHome: home,
      dataDir: home,
      etcDir: join(home, 'no-etc'),
      fetchLatestTag: async () => 'v1.1.0',
    })
    const s = await svc.check()
    expect(s.upgrade_capability).toBe('release')
    expect(s.current_version).toBe('v1.0.0')
    expect(s.latest_version).toBe('v1.1.0')
    expect(s.upgrade_available).toBe(true)
    rmSync(home, { recursive: true, force: true })
  })

  it('release: 版本相同则无更新', async () => {
    const home = tmpHome(false)
    writeFileSync(join(home, 'VERSION'), 'v1.0.0\n')
    const svc = new VersionService({
      crabotHome: home, dataDir: home, etcDir: join(home, 'no-etc'),
      fetchLatestTag: async () => 'v1.0.0',
    })
    const s = await svc.check()
    expect(s.upgrade_available).toBe(false)
    rmSync(home, { recursive: true, force: true })
  })
})

describe('VersionService source', () => {
  function makeSourceSvc(git: (args: string[]) => string) {
    const home = mkdtempSync(join(tmpdir(), 'crabot-src-'))
    mkdirSync(join(home, '.git'))
    return new VersionService({
      crabotHome: home, dataDir: home, etcDir: join(home, 'no-etc'),
      gitRunner: git,
    })
  }

  it('远端 main 领先且工作区干净 → 有更新无 blockers', async () => {
    const svc = makeSourceSvc((args) => {
      if (args[0] === 'ls-remote') return 'abc123\trefs/heads/main'
      if (args[0] === 'cat-file') throw new Error('not found') // 本地不含该 commit
      if (args[0] === 'status') return ''
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main'
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'def456'
      return ''
    })
    const s = await svc.check()
    expect(s.upgrade_capability).toBe('source')
    expect(s.upgrade_available).toBe(true)
    expect(s.source_blockers ?? []).toEqual([])
    expect(s.latest_version).toBe('abc123')
    expect(s.current_version).toBe('def456')
  })

  it('工作区脏 + 非 main 分支 → 有更新但两条 blockers', async () => {
    const svc = makeSourceSvc((args) => {
      if (args[0] === 'ls-remote') return 'abc123\trefs/heads/main'
      if (args[0] === 'cat-file') throw new Error('not found')
      if (args[0] === 'status') return ' M crabot-admin/src/x.ts'
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feature/y'
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'def456'
      return ''
    })
    const s = await svc.check()
    expect(s.upgrade_available).toBe(true)
    expect(s.source_blockers).toContain('工作区有未提交改动')
    expect(s.source_blockers).toContain('当前不在 main 分支')
  })

  it('本地已含远端 commit → 无更新', async () => {
    const svc = makeSourceSvc((args) => {
      if (args[0] === 'ls-remote') return 'abc123\trefs/heads/main'
      if (args[0] === 'cat-file') return '' // 不抛 = 本地已含
      if (args[0] === 'status') return ''
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main'
      if (args[0] === 'rev-parse' && args[1] === '--short') return 'abc123'
      return ''
    })
    const s = await svc.check()
    expect(s.upgrade_available).toBe(false)
  })

  it('ls-remote 返回空串 → state.error 非空且 upgrade_available 为 false', async () => {
    const svc = makeSourceSvc((args) => {
      if (args[0] === 'ls-remote') return '' // 空输出，找不到 main 分支
      return ''
    })
    const s = await svc.check()
    expect(s.error).toBeTruthy()
    expect(s.upgrade_available).toBe(false)
  })
})
