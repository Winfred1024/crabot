import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { SubAgentManager } from './subagent-manager.js'
import type { SubAgentRegistryEntry } from './types.js'

const makeEntry = (id: string, name: string): SubAgentRegistryEntry => ({
  id,
  name,
  description: 'Test subagent',
  when_to_use: 'Use this when testing',
  role: 'Test role',
  workflow: 'Test workflow',
  deliverables: 'Test deliverables',
  builtin_capabilities: {
    file_system: false,
    shell: false,
    task_intel: false,
    crab_memory: false,
    crab_messaging: false,
  },
  allowed_mcp_server_ids: [],
  allowed_skill_ids: [],
  max_turns: 20,
  provider_id: null,
  model_id: null,
  model_role: 'powerful',
  enabled: true,
  is_builtin: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

describe('SubAgentManager.upsertById', () => {
  let tmpData: string
  let manager: SubAgentManager

  beforeEach(async () => {
    tmpData = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-upsert-'))
    manager = new SubAgentManager(tmpData)
    await manager.initialize()
  })

  afterEach(async () => {
    await fs.rm(tmpData, { recursive: true, force: true })
  })

  it('新 id → 返回 imported，get 可查到', async () => {
    const result = await manager.upsertById(makeEntry('sa-import-1', 'researcher'), 'skip')
    expect(result).toBe('imported')
    expect(manager.get('sa-import-1')?.name).toBe('researcher')
  })

  it('同 id + skip → 返回 skipped，值不变', async () => {
    await manager.upsertById(makeEntry('sa-import-2', 'Original'), 'skip')
    const result = await manager.upsertById(makeEntry('sa-import-2', 'Updated'), 'skip')
    expect(result).toBe('skipped')
    expect(manager.get('sa-import-2')?.name).toBe('Original')
  })

  it('同 id + overwrite → 返回 overwritten，值更新', async () => {
    await manager.upsertById(makeEntry('sa-import-3', 'Original'), 'skip')
    const result = await manager.upsertById(makeEntry('sa-import-3', 'Updated'), 'overwrite')
    expect(result).toBe('overwritten')
    expect(manager.get('sa-import-3')?.name).toBe('Updated')
  })
})
