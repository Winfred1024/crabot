import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInstance, writeInstance, hasInstance } from '../instance.mjs'

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
