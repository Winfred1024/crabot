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
