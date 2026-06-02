import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runRipgrep } from '../../../src/engine/tools/ripgrep-helper'

describe('runRipgrep', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ripgrep-helper-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns exitCode 0 + stdout when matches are found', async () => {
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'src', 'a.txt'), 'foo\nbar\n')

    const r = await runRipgrep(['--no-ignore', '--hidden', '-e', 'foo', tmp])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('foo')
    expect(r.truncated).toBe(false)
  })

  it('returns exitCode 1 + empty stdout when no matches', async () => {
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'src', 'a.txt'), 'foo\n')

    const r = await runRipgrep(['--no-ignore', '--hidden', '-e', 'zzz_nope_zzz', tmp])
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('returns exitCode 2 for invalid path', async () => {
    const r = await runRipgrep([
      '--no-ignore',
      '-e',
      'foo',
      join(tmp, 'does-not-exist'),
    ])
    expect(r.exitCode).toBe(2)
  })

  it('caps stdout by maxBytes and kills the rg process', async () => {
    // 写一个会产生大量 stdout 的场景：1000 行匹配，每行 ~50 字节，~50KB 总输出
    const big = Array.from({ length: 1000 }, (_, i) => `line-${i}: MATCH_ME some content here`).join('\n')
    writeFileSync(join(tmp, 'big.txt'), big)

    const r = await runRipgrep(
      ['--no-ignore', '--hidden', '--line-number', '-e', 'MATCH_ME', tmp],
      { maxBytes: 4096 },
    )

    expect(r.truncated).toBe(true)
    // 截断时 stdout 应该接近但不超过 maxBytes
    expect(r.stdout.length).toBeLessThanOrEqual(4096)
    expect(r.stdout.length).toBeGreaterThan(0)
  })

  it('respects AbortSignal pre-aborted state', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runRipgrep(['--version'], { signal: ac.signal })
    expect(r.truncated).toBe(true)
  })
})
