import { describe, it, expect } from 'vitest'
import { snapshotSessionConfig } from './session-config-snapshot-migration.js'
import { PermissionTemplateManager } from './permission-template-manager.js'
import type { SessionPermissionConfig } from './types.js'

describe('snapshotSessionConfig', () => {
  const mgr = new PermissionTemplateManager()
  mgr.initSystemTemplates()

  it('缺 cli_access 的旧 config → 补全模板对应值', () => {
    const old: SessionPermissionConfig = {
      template_id: 'group_default',
      tool_access: { messaging: true },
      memory_scopes: ['scope-a'],
      updated_at: '2026-01-01T00:00:00Z',
    }
    const snapped = snapshotSessionConfig(old, mgr)
    expect(snapped.cli_access).toEqual(mgr.get('group_default')!.cli_access)
    expect(snapped.tool_access?.messaging).toBe(true)
    expect(snapped.memory_scopes).toEqual(['scope-a'])
  })

  it('已是全字段 config → 原样返回（幂等）', () => {
    const tpl = mgr.get('group_scheduler')!
    const full: SessionPermissionConfig = {
      template_id: 'group_scheduler',
      tool_access: { ...tpl.tool_access },
      cli_access: { ...tpl.cli_access },
      storage: null,
      memory_scopes: ['x'],
      updated_at: '2026-01-01T00:00:00Z',
    }
    const snapped = snapshotSessionConfig(full, mgr)
    expect(snapped.cli_access).toEqual(tpl.cli_access)
    expect(snapped).toEqual(full)
  })

  it('template_id 缺失 / 无效 → fallback 到 group_default', () => {
    const noTpl: SessionPermissionConfig = {
      tool_access: { messaging: true },
      memory_scopes: ['scope-a'],
      updated_at: '2026-01-01T00:00:00Z',
    }
    const snapped = snapshotSessionConfig(noTpl, mgr)
    expect(snapped.cli_access).toEqual(mgr.get('group_default')!.cli_access)
  })
})
