import { describe, it, expect } from 'vitest'
import { withStreamTimeout } from '../../src/engine/stream-timeout'
import { StreamTimeoutError, isRetryableError } from '../../src/engine/retry-utils'

/** 可被 signal 取消的延时；超时/取消时 reject AbortError */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function drain<T>(gen: AsyncGenerator<T>, sink?: T[]): Promise<void> {
  for await (const c of gen) sink?.push(c)
}

describe('withStreamTimeout', () => {
  it('在超时内正常透传所有 chunk', async () => {
    const out: number[] = []
    await drain(
      withStreamTimeout<number>(async function* () { yield 1; yield 2; yield 3 }, undefined, { ttfbMs: 1000, idleMs: 1000 }),
      out,
    )
    expect(out).toEqual([1, 2, 3])
  })

  it('首 chunk 超 TTFB 未到 → StreamTimeoutError(ttfb)', async () => {
    const gen = withStreamTimeout<number>(
      async function* (signal) { await delay(1000, signal); yield 1 },
      undefined,
      { ttfbMs: 50, idleMs: 1000 },
    )
    await expect(drain(gen)).rejects.toMatchObject({ name: 'StreamTimeoutError', phase: 'ttfb' })
  })

  it('相邻 chunk 间隔超空闲阈值 → StreamTimeoutError(idle)，已收到的 chunk 保留', async () => {
    const out: number[] = []
    const gen = withStreamTimeout<number>(
      async function* (signal) { yield 1; await delay(1000, signal); yield 2 },
      undefined,
      { ttfbMs: 1000, idleMs: 50 },
    )
    await expect(drain(gen, out)).rejects.toMatchObject({ name: 'StreamTimeoutError', phase: 'idle' })
    expect(out).toEqual([1])
  })

  it('用户取消 → 原样抛 AbortError，不翻译成 StreamTimeoutError', async () => {
    const ctrl = new AbortController()
    const gen = withStreamTimeout<number>(
      async function* (signal) { await delay(1000, signal); yield 1 },
      ctrl.signal,
      { ttfbMs: 1000, idleMs: 1000 },
    )
    const p = drain(gen)
    ctrl.abort()
    let caught: unknown
    try { await p } catch (e) { caught = e }
    expect((caught as Error).name).toBe('AbortError')
    expect(caught).not.toBeInstanceOf(StreamTimeoutError)
  })

  it('StreamTimeoutError 被判定为可重试', () => {
    expect(isRetryableError(new StreamTimeoutError('ttfb', 90_000))).toBe(true)
    expect(isRetryableError(new StreamTimeoutError('idle', 120_000))).toBe(true)
  })
})
