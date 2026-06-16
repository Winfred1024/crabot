import { describe, it, expect } from 'vitest'
import { mergeByName, mergeKindDoc } from '../yaml-merge.mjs'

describe('mergeByName', () => {
  it('用户独有保留，root 同名整条覆盖', () => {
    const rootList = [
      { name: 'a', value: 'root-a' },
      { name: 'b', value: 'root-b' },
    ]
    const userList = [
      { name: 'a', value: 'user-a' },
      { name: 'c', value: 'user-c' },
    ]
    const result = mergeByName(rootList, userList, { key: 'name' })
    expect(result).toEqual([
      { name: 'a', value: 'root-a' },
      { name: 'b', value: 'root-b' },
      { name: 'c', value: 'user-c' },
    ])
  })

  it('root 空 → 全部保留用户', () => {
    const r = mergeByName([], [{ name: 'a' }, { name: 'b' }], { key: 'name' })
    expect(r).toEqual([{ name: 'a' }, { name: 'b' }])
  })

  it('用户空 → 全部用 root', () => {
    const r = mergeByName([{ name: 'a' }], [], { key: 'name' })
    expect(r).toEqual([{ name: 'a' }])
  })

  it('自定义 key（slot）', () => {
    const r = mergeByName(
      [{ slot: 'default', model: 'gpt-4' }],
      [{ slot: 'default', model: 'old' }, { slot: 'smart', model: 'opus' }],
      { key: 'slot' },
    )
    expect(r).toEqual([
      { slot: 'default', model: 'gpt-4' },
      { slot: 'smart', model: 'opus' },
    ])
  })
})

describe('mergeKindDoc', () => {
  it('vendor：按 id 合并 + mode 顶层标量透传（root 优先）', () => {
    const rootDoc = {
      mode: 'replace',
      vendors: [{ id: 'a', name: 'root-A' }, { id: 'b', name: 'root-B' }],
    }
    const userDoc = {
      mode: 'merge',
      vendors: [{ id: 'a', name: 'user-A' }, { id: 'c', name: 'user-C' }],
    }
    const out = mergeKindDoc(rootDoc, userDoc, { key: 'id' })
    expect(out.vendors).toEqual([
      { id: 'a', name: 'root-A' },
      { id: 'b', name: 'root-B' },
      { id: 'c', name: 'user-C' },
    ])
    expect(out.mode).toBe('replace') // root 优先
  })

  it('user 缺 mode 时保留 root 的', () => {
    const out = mergeKindDoc({ mode: 'merge', vendors: [] }, { vendors: [] }, { key: 'id' })
    expect(out.mode).toBe('merge')
  })

  it('root 无标量、user 有标量时透传 user 的', () => {
    const out = mergeKindDoc({ vendors: [] }, { mode: 'replace', vendors: [] }, { key: 'id' })
    expect(out.mode).toBe('replace')
  })

  it('provider/agent 单数组容器无回归', () => {
    const rootDoc = { providers: [{ name: 'p1', v: 'root' }] }
    const userDoc = { providers: [{ name: 'p1', v: 'user' }, { name: 'p2', v: 'user' }] }
    const out = mergeKindDoc(rootDoc, userDoc, { key: 'name' })
    expect(out).toEqual({
      providers: [{ name: 'p1', v: 'root' }, { name: 'p2', v: 'user' }],
    })
  })

  it('userDoc 为空对象时正常', () => {
    const out = mergeKindDoc({ vendors: [{ id: 'a' }] }, {}, { key: 'id' })
    expect(out.vendors).toEqual([{ id: 'a' }])
  })
})
