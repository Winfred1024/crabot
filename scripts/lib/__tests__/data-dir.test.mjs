import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveDataDir } from '../data-dir.mjs'

describe('resolveDataDir', () => {
  it('env DATA_DIR 优先级最高', () => {
    expect(resolveDataDir({ envValue: '/explicit/path', offset: 0 }))
      .toBe('/explicit/path')
    expect(resolveDataDir({ envValue: '/explicit/path', offset: 100 }))
      .toBe('/explicit/path')
  })

  it('offset=0 时默认 ~/.crabot/data', () => {
    expect(resolveDataDir({ envValue: undefined, offset: 0 }))
      .toBe(resolve(homedir(), '.crabot/data'))
  })

  it('offset>0 时默认 ~/.crabot/data-<OFF>', () => {
    expect(resolveDataDir({ envValue: undefined, offset: 100 }))
      .toBe(resolve(homedir(), '.crabot/data-100'))
    expect(resolveDataDir({ envValue: undefined, offset: 200 }))
      .toBe(resolve(homedir(), '.crabot/data-200'))
  })
})
