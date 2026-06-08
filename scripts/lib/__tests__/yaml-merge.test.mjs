import { describe, it, expect } from 'vitest'
import { mergeByName } from '../yaml-merge.mjs'

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
