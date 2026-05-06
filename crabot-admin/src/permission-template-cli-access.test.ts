import { describe, it, expect } from 'vitest'
import {
  createCliAccessConfig,
  CLI_DOMAINS,
  type CliPerm,
  type CliAccessConfig,
  type PermissionTemplate,
} from './types.js'
import { createToolAccessConfig } from './types.js'

describe('CliAccessConfig', () => {
  it('CLI_DOMAINS 列出全部 10 个 domain', () => {
    expect(new Set(CLI_DOMAINS)).toEqual(new Set([
      'provider', 'agent', 'mcp', 'skill', 'schedule',
      'channel', 'friend', 'permission', 'config', 'undo',
    ]))
  })

  it('createCliAccessConfig 用 default 填满 10 个域', () => {
    const cfg: CliAccessConfig = createCliAccessConfig('none')
    for (const d of CLI_DOMAINS) {
      expect(cfg[d]).toBe<CliPerm>('none')
    }
  })

  it('PermissionTemplate 类型必带 cli_access 字段', () => {
    const t: PermissionTemplate = {
      id: 'x',
      name: 'X',
      is_system: false,
      tool_access: createToolAccessConfig(false),
      cli_access: createCliAccessConfig('none'),
      storage: null,
      memory_scopes: [],
      created_at: 't',
      updated_at: 't',
    }
    expect(t.cli_access.schedule).toBe('none')
  })
})
