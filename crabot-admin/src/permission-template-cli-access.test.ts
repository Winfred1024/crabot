import { describe, it, expect } from 'vitest'
import {
  createCliAccessConfig,
  CLI_DOMAINS,
  type CliPerm,
  type CliAccessConfig,
  type PermissionTemplate,
} from './types.js'
import { createToolAccessConfig } from './types.js'
import { PermissionTemplateManager } from './permission-template-manager.js'

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

describe('PermissionTemplateManager.initSystemTemplates 的 cli_access 默认', () => {
  const mgr = new PermissionTemplateManager()
  mgr.initSystemTemplates()

  it('master_private: cli_access 全部 write', () => {
    const t = mgr.get('master_private')!
    for (const d of CLI_DOMAINS) {
      expect(t.cli_access[d]).toBe('write')
    }
  })

  it('group_default: cli_access 全部 none（群默认收紧）', () => {
    const t = mgr.get('group_default')!
    for (const d of CLI_DOMAINS) {
      expect(t.cli_access[d]).toBe('none')
    }
  })

  it('standard: cli_access 全部 none（friend 默认无 self-management）', () => {
    const t = mgr.get('standard')!
    for (const d of CLI_DOMAINS) {
      expect(t.cli_access[d]).toBe('none')
    }
  })

  it('minimal: cli_access 全部 none（兜底）', () => {
    const t = mgr.get('minimal')!
    for (const d of CLI_DOMAINS) {
      expect(t.cli_access[d]).toBe('none')
    }
  })

  it('group_scheduler: schedule=write，其他 none', () => {
    const t = mgr.get('group_scheduler')!
    expect(t).toBeDefined()
    expect(t.cli_access.schedule).toBe('write')
    for (const d of CLI_DOMAINS) {
      if (d === 'schedule') continue
      expect(t.cli_access[d]).toBe('none')
    }
  })

  it('group_scheduler: tool_access 至少含 messaging/memory/task', () => {
    const t = mgr.get('group_scheduler')!
    expect(t.tool_access.messaging).toBe(true)
    expect(t.tool_access.memory).toBe(true)
    expect(t.tool_access.task).toBe(true)
  })
})

describe('PermissionTemplateManager.resolvePermissions cli_access 合并', () => {
  const mgr = new PermissionTemplateManager()
  mgr.initSystemTemplates()

  it('无 sessionConfig 直接返回模板的 cli_access 拷贝', () => {
    const r = mgr.resolvePermissions('master_private', null)
    expect(r.cli_access.provider).toBe('write')
  })

  it('resolvePermissions: sessionConfig 全字段时，完全脱离模板（快照式）', () => {
    const sessionCli = createCliAccessConfig('none')
    sessionCli.schedule = 'write'
    const r = mgr.resolvePermissions('group_default', {
      template_id: 'group_default',
      cli_access: sessionCli,
      tool_access: { messaging: true },  // 其他都 false
      storage: null,
      memory_scopes: ['custom-scope'],
      updated_at: '2026-01-01T00:00:00Z',
    })
    expect(r.cli_access.schedule).toBe('write')
    expect(r.cli_access.provider).toBe('none')
    expect(r.tool_access.messaging).toBe(true)
    expect(r.tool_access.memory).toBe(false)
    expect(r.memory_scopes).toEqual(['custom-scope'])
  })

  it('resolvePermissions: sessionConfig 为 null 时，纯模板', () => {
    const r = mgr.resolvePermissions('group_default', null)
    expect(r.cli_access.schedule).toBe('none')
    expect(r.tool_access.memory).toBe(true)
  })
})

describe('PermissionTemplateManager.normalize 补缺失 cli_access', () => {
  it('旧数据无 cli_access 字段时填入全 none', () => {
    const mgr = new PermissionTemplateManager()
    mgr.loadFromArray([{
      id: 'legacy',
      name: 'Legacy',
      is_system: false,
      tool_access: createToolAccessConfig(false),
      // cli_access intentionally missing — 模拟旧持久化数据
      storage: null,
      memory_scopes: [],
      created_at: 't',
      updated_at: 't',
    } as never])
    const t = mgr.get('legacy')!
    expect(t.cli_access).toBeDefined()
    for (const d of CLI_DOMAINS) {
      expect(t.cli_access[d]).toBe('none')
    }
  })
})

describe('PermissionTemplateManager.upsertById', () => {
  const makeTemplate = (id: string, name: string): PermissionTemplate => ({
    id,
    name,
    is_system: false,
    tool_access: createToolAccessConfig(false),
    cli_access: createCliAccessConfig('none'),
    storage: null,
    memory_scopes: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })

  it('新 id → 返回 imported，get 可查到', () => {
    const mgr = new PermissionTemplateManager()
    const result = mgr.upsertById(makeTemplate('tpl-import-1', 'Guest'), 'skip')
    expect(result).toBe('imported')
    expect(mgr.get('tpl-import-1')?.name).toBe('Guest')
  })

  it('同 id + skip → 返回 skipped，值不变', () => {
    const mgr = new PermissionTemplateManager()
    mgr.upsertById(makeTemplate('tpl-import-2', 'Original'), 'skip')
    const result = mgr.upsertById(makeTemplate('tpl-import-2', 'Updated'), 'skip')
    expect(result).toBe('skipped')
    expect(mgr.get('tpl-import-2')?.name).toBe('Original')
  })

  it('同 id + overwrite → 返回 overwritten，值更新', () => {
    const mgr = new PermissionTemplateManager()
    mgr.upsertById(makeTemplate('tpl-import-3', 'Original'), 'skip')
    const result = mgr.upsertById(makeTemplate('tpl-import-3', 'Updated'), 'overwrite')
    expect(result).toBe('overwritten')
    expect(mgr.get('tpl-import-3')?.name).toBe('Updated')
  })
})
