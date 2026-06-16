import { describe, it, expect } from 'vitest'
import { addVendor, removeVendor, setMode, validateEntry } from '../vendor-doc.mjs'

describe('addVendor', () => {
  it('空 doc 追加第一个 vendor', () => {
    const doc = { mode: 'merge', vendors: [] }
    const out = addVendor(doc, { id: 'a', name: 'A', format: 'openai', endpoint: 'x' })
    expect(out.vendors).toEqual([{ id: 'a', name: 'A', format: 'openai', endpoint: 'x' }])
    expect(doc.vendors).toEqual([]) // 不可变：原 doc 未被改
  })

  it('缺 vendors 键时也能追加', () => {
    const out = addVendor({ mode: 'merge' }, { id: 'a', name: 'A', format: 'openai', endpoint: 'x' })
    expect(out.vendors).toHaveLength(1)
  })

  it('id 重复抛错', () => {
    const doc = { vendors: [{ id: 'a', name: 'A', format: 'openai', endpoint: 'x' }] }
    expect(() => addVendor(doc, { id: 'a', name: 'B', format: 'openai', endpoint: 'y' }))
      .toThrow(/已存在/)
  })
})

describe('removeVendor', () => {
  it('按 id 删除', () => {
    const doc = { vendors: [{ id: 'a' }, { id: 'b' }] }
    const out = removeVendor(doc, 'a')
    expect(out.vendors).toEqual([{ id: 'b' }])
    expect(doc.vendors).toHaveLength(2) // 不可变
  })

  it('删不存在的 id 无副作用', () => {
    const doc = { vendors: [{ id: 'a' }] }
    expect(removeVendor(doc, 'zzz').vendors).toEqual([{ id: 'a' }])
  })
})

describe('setMode', () => {
  it('设置 mode', () => {
    expect(setMode({ vendors: [] }, 'replace').mode).toBe('replace')
  })
  it('非法 mode 抛错', () => {
    expect(() => setMode({}, 'bogus')).toThrow(/mode/)
  })
})

describe('validateEntry', () => {
  it('合法条目返回空错误数组', () => {
    expect(validateEntry({ id: 'a', name: 'A', format: 'openai', endpoint: 'x' })).toEqual([])
  })
  it('缺字段 + 非法 format 报多条', () => {
    const errs = validateEntry({ id: '', name: '', format: 'bad', endpoint: '' })
    expect(errs).toContain('id 不能为空')
    expect(errs).toContain('name 不能为空')
    expect(errs).toContain('endpoint 不能为空')
    expect(errs.some(e => e.includes('format'))).toBe(true)
  })
  it('openai-responses 不被接受（固定流程不可自定义）', () => {
    const errs = validateEntry({ id: 'a', name: 'A', format: 'openai-responses', endpoint: 'x' })
    expect(errs.some(e => e.includes('format'))).toBe(true)
  })
})
