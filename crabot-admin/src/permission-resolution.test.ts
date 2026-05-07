import { describe, it, expect } from 'vitest'
import { unionCliPerm, unionResolved, unionStorage } from './permission-resolution.js'
import { createToolAccessConfig, createCliAccessConfig } from './types.js'
import type { ResolvedPermissions } from './types.js'

describe('unionCliPerm', () => {
  it('write 取胜', () => {
    expect(unionCliPerm('write', 'none')).toBe('write')
    expect(unionCliPerm('none', 'write')).toBe('write')
    expect(unionCliPerm('write', 'read')).toBe('write')
    expect(unionCliPerm('read', 'write')).toBe('write')
  })
  it('read > none', () => {
    expect(unionCliPerm('read', 'none')).toBe('read')
    expect(unionCliPerm('none', 'read')).toBe('read')
  })
  it('两个相同时返回该值', () => {
    expect(unionCliPerm('none', 'none')).toBe('none')
    expect(unionCliPerm('write', 'write')).toBe('write')
  })
})

describe('unionStorage', () => {
  it('一方 null → 取另一方拷贝', () => {
    const s = { workspace_path: '/a', access: 'read' as const }
    expect(unionStorage(null, s)).toEqual(s)
    expect(unionStorage(s, null)).toEqual(s)
  })
  it('两方 null → null', () => {
    expect(unionStorage(null, null)).toBeNull()
  })
  it('同 path → access 取较宽（readwrite > read）', () => {
    const a = { workspace_path: '/x', access: 'read' as const }
    const b = { workspace_path: '/x', access: 'readwrite' as const }
    expect(unionStorage(a, b)).toEqual({ workspace_path: '/x', access: 'readwrite' })
    expect(unionStorage(b, a)).toEqual({ workspace_path: '/x', access: 'readwrite' })
  })
  it('不同 path → 取受限侧（read 胜 readwrite，避免提权）', () => {
    const aRead = { workspace_path: '/x', access: 'read' as const }
    const bRW = { workspace_path: '/y', access: 'readwrite' as const }
    expect(unionStorage(aRead, bRW)).toEqual(aRead)
    expect(unionStorage(bRW, aRead)).toEqual(aRead)
  })
  it('不同 path、access 同级 → 取 a 侧', () => {
    const a = { workspace_path: '/x', access: 'read' as const }
    const b = { workspace_path: '/y', access: 'read' as const }
    expect(unionStorage(a, b)).toEqual(a)
  })
  it('不返回输入引用（clone）', () => {
    const a = { workspace_path: '/x', access: 'read' as const }
    const r = unionStorage(a, null)!
    expect(r).not.toBe(a)
    expect(r).toEqual(a)
  })
})

describe('unionResolved', () => {
  const make = (toolBool: boolean, cliVal: 'none' | 'read' | 'write'): ResolvedPermissions => ({
    tool_access: createToolAccessConfig(toolBool),
    cli_access: createCliAccessConfig(cliVal),
    storage: null,
    memory_scopes: [],
  })

  it('两边 null → null', () => {
    expect(unionResolved(null, null)).toBeNull()
  })

  it('一边 null → 另一边（结构相等但不共享引用）', () => {
    const a = make(true, 'write')
    const left = unionResolved(a, null)!
    expect(left).toEqual(a)
    expect(left).not.toBe(a)
    expect(left.tool_access).not.toBe(a.tool_access)
    const right = unionResolved(null, a)!
    expect(right).toEqual(a)
    expect(right).not.toBe(a)
  })

  it('tool_access 按 OR 合并', () => {
    const a = make(false, 'none')
    const b: ResolvedPermissions = {
      tool_access: { ...createToolAccessConfig(false), messaging: true, task: true },
      cli_access: createCliAccessConfig('none'),
      storage: null,
      memory_scopes: [],
    }
    const r = unionResolved(a, b)!
    expect(r.tool_access.messaging).toBe(true)
    expect(r.tool_access.task).toBe(true)
    expect(r.tool_access.shell).toBe(false)
  })

  it('cli_access 按 rank 取大', () => {
    const a: ResolvedPermissions = {
      tool_access: createToolAccessConfig(false),
      cli_access: { ...createCliAccessConfig('none'), provider: 'read' },
      storage: null,
      memory_scopes: [],
    }
    const b: ResolvedPermissions = {
      tool_access: createToolAccessConfig(false),
      cli_access: { ...createCliAccessConfig('none'), schedule: 'write', provider: 'none' },
      storage: null,
      memory_scopes: [],
    }
    const r = unionResolved(a, b)!
    expect(r.cli_access.schedule).toBe('write')
    expect(r.cli_access.provider).toBe('read')  // a 的 read 胜
    expect(r.cli_access.mcp).toBe('none')
  })

  it('memory_scopes 取并集去重', () => {
    const a: ResolvedPermissions = {
      tool_access: createToolAccessConfig(false),
      cli_access: createCliAccessConfig('none'),
      storage: null,
      memory_scopes: ['x', 'y'],
    }
    const b: ResolvedPermissions = {
      tool_access: createToolAccessConfig(false),
      cli_access: createCliAccessConfig('none'),
      storage: null,
      memory_scopes: ['y', 'z'],
    }
    expect(unionResolved(a, b)!.memory_scopes.sort()).toEqual(['x', 'y', 'z'])
  })
})
