import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePid, readPid, isPidAlive, clearPid, checkSingleInstance } from '../pid.mjs'

describe('pid utils', () => {
  let dataDir

  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'crabot-pid-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }) })

  it('writePid + readPid 往返', () => {
    writePid(dataDir, 12345)
    expect(readPid(dataDir)).toBe(12345)
  })

  it('readPid 返回 null 当文件不存在', () => {
    expect(readPid(dataDir)).toBeNull()
  })

  it('isPidAlive(process.pid) 返回 true', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('isPidAlive(很大 PID) 返回 false', () => {
    expect(isPidAlive(2 ** 22)).toBe(false)
  })

  it('clearPid 删除文件', () => {
    writePid(dataDir, 999)
    clearPid(dataDir)
    expect(readPid(dataDir)).toBeNull()
  })

  it('checkSingleInstance 无 pid 文件 → ok', () => {
    expect(checkSingleInstance(dataDir)).toEqual({ ok: true })
  })

  it('checkSingleInstance 死 pid → 自动清理并 ok', () => {
    writePid(dataDir, 2 ** 22)
    expect(checkSingleInstance(dataDir)).toEqual({ ok: true })
    expect(readPid(dataDir)).toBeNull()
  })

  it('checkSingleInstance 活 pid → not ok 带 pid', () => {
    writePid(dataDir, process.pid)
    const r = checkSingleInstance(dataDir)
    expect(r.ok).toBe(false)
    expect(r.runningPid).toBe(process.pid)
  })
})
