/**
 * Test that friend permission resolution surfaces cli_access correctly.
 * 不依赖完整 Admin server fixture，直接构造 manager + 模拟 friend 字面量。
 */
import { describe, it, expect } from 'vitest'
import { PermissionTemplateManager } from './permission-template-manager.js'
import {
  createToolAccessConfig,
  createCliAccessConfig,
  CLI_DOMAINS,
  type Friend,
  type FriendPermissionConfig,
} from './types.js'

describe('Friend permission resolution surfaces cli_access', () => {
  const mgr = new PermissionTemplateManager()
  mgr.initSystemTemplates()

  it('master friend → master_private 模板的 cli_access（全 write）', () => {
    const r = mgr.resolvePermissions('master_private', null)
    expect(r.cli_access).toBeDefined()
    for (const d of CLI_DOMAINS) {
      expect(r.cli_access[d]).toBe('write')
    }
  })

  it('non-master friend with template → 模板的 cli_access', () => {
    const r = mgr.resolvePermissions('standard', null)
    expect(r.cli_access).toBeDefined()
    for (const d of CLI_DOMAINS) {
      expect(r.cli_access[d]).toBe('none')
    }
  })

  it('FriendPermissionConfig 字面量必带 cli_access (类型层校验)', () => {
    const cfg: FriendPermissionConfig = {
      tool_access: createToolAccessConfig(false),
      cli_access: createCliAccessConfig('none'),
      storage: null,
      memory_scopes: [],
      updated_at: 't',
    }
    expect(cfg.cli_access.schedule).toBe('none')
  })

  it('Friend 类型存在且符合预期形状（cross-check 不破坏既有 friend 模型）', () => {
    const f: Friend = {
      id: 'f1',
      display_name: 'Test',
      permission: 'normal',
      channel_identities: [],
      created_at: 't',
      updated_at: 't',
    }
    expect(f.permission).toBe('normal')
  })
})
