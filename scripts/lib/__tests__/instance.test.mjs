import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readInstance, writeInstance, hasInstance, resolveCliDataDir } from '../instance.mjs'

describe('instance manifest', () => {
  let homeDir

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'crabot-instance-'))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('hasInstance 返回 false 当文件不存在', () => {
    expect(hasInstance(homeDir)).toBe(false)
  })

  it('writeInstance + readInstance 往返一致', () => {
    const m = {
      mode: 'system',
      port_offset: 100,
      applied_cluster_version: 5,
      applied_at: '2026-06-07T10:30:00Z',
      data_dir: '/home/alice/.crabot/data-100',
      crabot_home: '/opt/crabot',
    }
    writeInstance(homeDir, m)
    expect(hasInstance(homeDir)).toBe(true)
    expect(readInstance(homeDir)).toEqual(m)
  })

  it('readInstance 抛错当文件损坏', () => {
    writeFileSync(join(homeDir, 'instance.json'), '{ not json')
    expect(() => readInstance(homeDir)).toThrow()
  })
})

describe('resolveCliDataDir', () => {
  let homeDir
  let repoRoot

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'crabot-cli-dd-home-'))
    repoRoot = mkdtempSync(join(tmpdir(), 'crabot-cli-dd-repo-'))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('env DATA_DIR 优先级最高（覆盖一切）', () => {
    writeInstance(homeDir, {
      mode: 'user', port_offset: 0,
      data_dir: '/instance/written/path',
      crabot_home: repoRoot,
    })
    mkdirSync(join(repoRoot, 'data', 'admin'), { recursive: true })
    const env = { DATA_DIR: '/explicit/dir' }
    expect(resolveCliDataDir({ homeDir, repoRoot, env })).toBe('/explicit/dir')
  })

  // 回归测试：2026-06-07 17:59~23:12 窗口里 auto-init 写出来的 stale instance.json
  // （data_dir 死写成 ~/.crabot/data）不能绕过 legacy source install 检测。
  // resolveCliDataDir 的契约就是不读 instance.data_dir。
  it('stale instance.json + legacy source data 同时存在 → 走 $REPO/data', () => {
    writeInstance(homeDir, {
      mode: 'user', port_offset: 0,
      data_dir: resolve(homedir(), '.crabot/data'),  // stale: 默认 fallback 路径
      crabot_home: repoRoot,
    })
    mkdirSync(join(repoRoot, 'data', 'admin'), { recursive: true })
    expect(resolveCliDataDir({ homeDir, repoRoot, env: {} }))
      .toBe(join(repoRoot, 'data'))
  })

  it('无 instance.json + 无 legacy data → 默认 ~/.crabot/data', () => {
    expect(resolveCliDataDir({ homeDir, repoRoot, env: {} }))
      .toBe(resolve(homedir(), '.crabot/data'))
  })

  it('OFFSET 从 instance.json 回退（env 没设）→ 走 ~/.crabot/data-<OFF>', () => {
    writeInstance(homeDir, {
      mode: 'system', port_offset: 42,
      data_dir: '/some/legacy/wrong/path',
      crabot_home: repoRoot,
    })
    // 即使 $REPO/data/admin 存在，offset>0 也不走 legacy 分支
    mkdirSync(join(repoRoot, 'data', 'admin'), { recursive: true })
    const env = {}
    expect(resolveCliDataDir({ homeDir, repoRoot, env }))
      .toBe(resolve(homedir(), '.crabot/data-42'))
    // resolveOffset 副作用：把 OFFSET 写回 env 供子进程继承
    expect(env.CRABOT_PORT_OFFSET).toBe('42')
  })

  it('env CRABOT_PORT_OFFSET 优先于 instance.json.port_offset', () => {
    writeInstance(homeDir, {
      mode: 'system', port_offset: 42,
      data_dir: '/instance/wrong', crabot_home: repoRoot,
    })
    const env = { CRABOT_PORT_OFFSET: '7' }
    expect(resolveCliDataDir({ homeDir, repoRoot, env }))
      .toBe(resolve(homedir(), '.crabot/data-7'))
  })
})
