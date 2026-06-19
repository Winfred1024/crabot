import { describe, it, expect } from 'vitest'
import { mergeById } from './merge-by-id.js'

type Row = { id: string; v: number }

describe('mergeById', () => {
  it('新 id 总是 imported', () => {
    const existing = new Map<string, Row>([['a', { id: 'a', v: 1 }]])
    const { merged, results } = mergeById(existing, [{ id: 'b', v: 2 }], 'skip', 'tasks')
    expect(merged.get('b')).toEqual({ id: 'b', v: 2 })
    expect(results).toEqual([{ kind: 'tasks', id: 'b', status: 'imported' }])
  })

  it('skip：已有 id 不覆盖', () => {
    const existing = new Map<string, Row>([['a', { id: 'a', v: 1 }]])
    const { merged, results } = mergeById(existing, [{ id: 'a', v: 99 }], 'skip', 'tasks')
    expect(merged.get('a')).toEqual({ id: 'a', v: 1 })
    expect(results).toEqual([{ kind: 'tasks', id: 'a', status: 'skipped', reason: 'conflict' }])
  })

  it('overwrite：已有 id 替换', () => {
    const existing = new Map<string, Row>([['a', { id: 'a', v: 1 }]])
    const { merged, results } = mergeById(existing, [{ id: 'a', v: 99 }], 'overwrite', 'tasks')
    expect(merged.get('a')).toEqual({ id: 'a', v: 99 })
    expect(results).toEqual([{ kind: 'tasks', id: 'a', status: 'overwritten' }])
  })

  it('不可变：不修改传入的 existing Map', () => {
    const existing = new Map<string, Row>([['a', { id: 'a', v: 1 }]])
    mergeById(existing, [{ id: 'a', v: 99 }], 'overwrite', 'tasks')
    expect(existing.get('a')).toEqual({ id: 'a', v: 1 })
  })

  it('缺 id 的记录计 failed', () => {
    const existing = new Map<string, Row>()
    const { results } = mergeById(existing, [{ v: 1 } as unknown as Row], 'skip', 'tasks')
    expect(results[0].status).toBe('failed')
  })
})
