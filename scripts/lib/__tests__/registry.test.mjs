import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRegistry, allocateOffset } from '../registry.mjs'

describe('registry', () => {
  let regPath

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'crabot-reg-'))
    regPath = join(dir, 'ports.json')
    writeFileSync(regPath, '[]')
  })

  afterEach(() => {
    rmSync(regPath, { force: true })
  })

  it('空注册表 → 分配 100', async () => {
    const result = await allocateOffset(regPath, { user: 'alice', hostname: 'srv' })
    expect(result.offset).toBe(100)
    const reg = readRegistry(regPath)
    expect(reg).toHaveLength(1)
    expect(reg[0].user).toBe('alice')
    expect(reg[0].offset).toBe(100)
  })

  it('已有 100 → 分配 200', async () => {
    writeFileSync(regPath, JSON.stringify([
      { offset: 100, user: 'alice', hostname: 'srv', pid_at_init: 1, claimed_at: 'x' },
    ]))
    const result = await allocateOffset(regPath, { user: 'bob', hostname: 'srv' })
    expect(result.offset).toBe(200)
  })

  it('已有 100, 300 → 分配 200（找最小空缺）', async () => {
    writeFileSync(regPath, JSON.stringify([
      { offset: 100, user: 'a', hostname: 's', pid_at_init: 1, claimed_at: 'x' },
      { offset: 300, user: 'b', hostname: 's', pid_at_init: 1, claimed_at: 'x' },
    ]))
    const result = await allocateOffset(regPath, { user: 'c', hostname: 's' })
    expect(result.offset).toBe(200)
  })

  it('同一 user 重复申请 → 复用原 offset', async () => {
    await allocateOffset(regPath, { user: 'alice', hostname: 'srv' })
    const r2 = await allocateOffset(regPath, { user: 'alice', hostname: 'srv' })
    expect(r2.offset).toBe(100)
    expect(readRegistry(regPath)).toHaveLength(1)
  })
})
