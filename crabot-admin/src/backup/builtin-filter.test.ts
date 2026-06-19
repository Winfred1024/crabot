import { describe, it, expect } from 'vitest'
import { filterUserRecords } from './builtin-filter.js'

describe('filterUserRecords', () => {
  it('按 is_builtin 过滤，返回保留数组 + 保留 id 集', () => {
    const rows = [
      { id: 'a', is_builtin: true },
      { id: 'b', is_builtin: false },
      { id: 'c' },
    ]
    const r = filterUserRecords(rows, 'is_builtin')
    expect(r.kept.map((x) => x.id)).toEqual(['b', 'c'])
    expect([...r.keptIds]).toEqual(['b', 'c'])
  })

  it('按 is_system 过滤（templates）', () => {
    const rows = [
      { id: 'sys', is_system: true },
      { id: 'usr', is_system: false },
    ]
    const r = filterUserRecords(rows, 'is_system')
    expect(r.kept.map((x) => x.id)).toEqual(['usr'])
  })

  it('非数组输入返回空', () => {
    const r = filterUserRecords({} as unknown as unknown[], 'is_builtin')
    expect(r.kept).toEqual([])
    expect(r.keptIds.size).toBe(0)
  })

  it('缺 id 字段的记录仍保留但不进 id 集', () => {
    const rows = [{ name: 'x', is_builtin: false }]
    const r = filterUserRecords(rows, 'is_builtin')
    expect(r.kept).toHaveLength(1)
    expect(r.keptIds.size).toBe(0)
  })
})
