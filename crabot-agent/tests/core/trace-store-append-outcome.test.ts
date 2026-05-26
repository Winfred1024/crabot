import { describe, expect, it } from 'vitest'
import { TraceStore } from '../../src/core/trace-store.js'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function makeStore(): { store: TraceStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'trace-store-test-'))
  const store = new TraceStore(100, dir)
  return {
    store,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('TraceStore.appendTraceOutcome', () => {
  it('给已 endTrace 的 trace patch outcome.summary 不重置 ended_at / duration_ms / status', () => {
    const { store, cleanup } = makeStore()
    try {
      const trace = store.startTrace({
        moduleId: 't',
        trigger: { type: 'sub_agent_call', summary: 'orig' },
      })
      store.endTrace(trace.trace_id, 'completed', { summary: 'old summary' })
      const stored = store.getTrace(trace.trace_id)!
      const oldEndedAt = stored.ended_at
      const oldDuration = stored.duration_ms
      const oldStatus = stored.status

      // 模拟时间差
      const before = Date.now()
      while (Date.now() === before) { /* spin */ }

      store.appendTraceOutcome(trace.trace_id, { summary: 'new summary' })
      const after = store.getTrace(trace.trace_id)!
      expect(after.outcome?.summary).toBe('new summary')
      expect(after.ended_at).toBe(oldEndedAt)
      expect(after.duration_ms).toBe(oldDuration)
      expect(after.status).toBe(oldStatus)
    } finally {
      cleanup()
    }
  })

  it('给已 endTrace 的 trace patch outcome.error 同时保留 summary 之前的值', () => {
    const { store, cleanup } = makeStore()
    try {
      const trace = store.startTrace({
        moduleId: 't',
        trigger: { type: 'sub_agent_call', summary: 'orig' },
      })
      store.endTrace(trace.trace_id, 'completed', { summary: 'keep me' })
      store.appendTraceOutcome(trace.trace_id, { error: '审计未通过' })
      const after = store.getTrace(trace.trace_id)!
      expect(after.outcome?.summary).toBe('keep me')
      expect(after.outcome?.error).toBe('审计未通过')
    } finally {
      cleanup()
    }
  })

  it('trace 不存在时静默返回（不抛错）', () => {
    const { store, cleanup } = makeStore()
    try {
      expect(() => store.appendTraceOutcome('nonexistent-id', { summary: 'x' })).not.toThrow()
    } finally {
      cleanup()
    }
  })

  it('对 outcome 未设置的 trace（边界 case）初始化空 summary 再 merge partial', () => {
    const { store, cleanup } = makeStore()
    try {
      const trace = store.startTrace({
        moduleId: 't',
        trigger: { type: 'sub_agent_call', summary: 'orig' },
      })
      // 不 endTrace，直接 patch（边界 case）
      store.appendTraceOutcome(trace.trace_id, { summary: 'patched' })
      const after = store.getTrace(trace.trace_id)!
      expect(after.outcome?.summary).toBe('patched')
    } finally {
      cleanup()
    }
  })
})
