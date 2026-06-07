import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectMode } from '../mode.mjs'

describe('detectMode', () => {
  let etcDir

  beforeEach(() => { etcDir = mkdtempSync(join(tmpdir(), 'crabot-etc-')) })
  afterEach(() => { rmSync(etcDir, { recursive: true, force: true }) })

  it('etc/crabot/cluster.version 不存在 → user', () => {
    expect(detectMode(etcDir)).toBe('user')
  })

  it('etc/crabot/cluster.version 存在 → system', () => {
    writeFileSync(join(etcDir, 'cluster.version'), '0')
    expect(detectMode(etcDir)).toBe('system')
  })
})
