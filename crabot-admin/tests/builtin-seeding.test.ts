import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillManager } from '../src/mcp-skill-manager.js'
import type { SkillRegistryEntry } from '../src/mcp-skill-manager.js'
import { getBuiltinSkills, BUILTIN_SKILL_IDS } from '../src/builtin-skills.js'

function makeEntry(id: string, name: string): SkillRegistryEntry {
  return {
    id,
    name,
    description: `desc ${name}`,
    version: '1.0.0',
    content: `# ${name}\n\ncontent ${name}`,
    is_builtin: true,
    is_essential: false,
    can_disable: true,
    enabled: true,
    created_at: '2026-05-18T00:00:00Z',
    updated_at: '2026-05-18T00:00:00Z',
  }
}

describe('SkillManager.seedBuiltinSkills', () => {
  let tmpDir: string
  let mgr: SkillManager

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-seed-'))
    mgr = new SkillManager(tmpDir)
    await mgr.initialize()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('空 registry 注入全部', async () => {
    await mgr.seedBuiltinSkills([makeEntry('builtin-a', 'a'), makeEntry('builtin-b', 'b')])
    expect(mgr.list().map((s) => s.id).sort()).toEqual(['builtin-a', 'builtin-b'])
  })

  it('已存在同 id 时跳过（不覆盖）', async () => {
    await mgr.seedBuiltinSkills([makeEntry('builtin-a', 'a-original')])
    await mgr.seedBuiltinSkills([makeEntry('builtin-a', 'a-overwrite')])
    expect(mgr.get('builtin-a')?.name).toBe('a-original')
  })

  it('文件持久化跨实例可读', async () => {
    await mgr.seedBuiltinSkills([makeEntry('builtin-c', 'c')])
    const mgr2 = new SkillManager(tmpDir)
    await mgr2.initialize()
    expect(mgr2.get('builtin-c')?.name).toBe('c')
  })
})

describe('getBuiltinSkills', () => {
  it('返回 3 个 builtin skill', () => {
    const list = getBuiltinSkills()
    expect(list).toHaveLength(3)
    expect(list.map((s) => s.id).sort()).toEqual([
      BUILTIN_SKILL_IDS.writingPlans,
      BUILTIN_SKILL_IDS.systematicDebugging,
      BUILTIN_SKILL_IDS.verificationBeforeCompletion,
    ].sort())
  })

  it('content 字段非空且含 attribution header', () => {
    for (const s of getBuiltinSkills()) {
      expect(s.content.length).toBeGreaterThan(100)
      expect(s.content).toContain('Source: superpowers v5.0.7')
    }
  })

  it('全部 is_builtin=true + enabled=true', () => {
    for (const s of getBuiltinSkills()) {
      expect(s.is_builtin).toBe(true)
      expect(s.enabled).toBe(true)
    }
  })
})
