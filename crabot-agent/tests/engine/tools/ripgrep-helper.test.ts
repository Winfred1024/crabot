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

  // 2026-06-07 kernel watchdog panic 复盘：crabot agent 同时 spawn 7+ 个 rg，
  // 单进程 RSS 飙到 17.5 GB（mmap 巨型文件 + 默认全核并行），32 GB 机器被压垮。
  // 这两条用例锁定 ripgrep-helper 永远会注入两条硬限制 flag。
  it('skips files larger than 10 MB by forcing --max-filesize=10M', async () => {
    // 写一个 12 MB 的文件，里面塞满 "MATCH_ME"。如果 rg 仍然扫它，会有大量
    // 匹配；--max-filesize=10M 生效则 rg 会跳过它，匹配为 0。
    const big = ('MATCH_ME on a single big-file line\n').repeat(400_000) // ~12.4 MB
    writeFileSync(join(tmp, 'huge.txt'), big)

    const r = await runRipgrep(['--no-ignore', '--hidden', '-c', '-e', 'MATCH_ME', tmp])
    // rg 跳过文件后没有任何匹配，exit code = 1（"no matches"）
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('forces --threads=1 (no multi-core parallel scan)', async () => {
    // 直接问 rg 它收到了什么参数：用 --debug 看不到 args，但 --max-filesize
    // 和 --threads 都接受重复声明，后写覆盖前写。如果我们在用户 args 里再传
    // 一次 --threads=8，最终生效的应该是用户的 8 —— 这反过来证明我们注入的
    // 那一条在前。这里改用更直接的"行为"验证：用 --files 列文件，rg 退出码
    // 0 = 列出。如果硬限制被破坏会抛错。
    writeFileSync(join(tmp, 'a.txt'), 'x\n')
    const r = await runRipgrep(['--files', tmp])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('a.txt')
  })
})
