import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SkillManager } from '../src/mcp-skill-manager.js'
import type { SkillRegistryEntry } from '../src/mcp-skill-manager.js'
import { getBuiltinSkills, BUILTIN_SKILL_IDS } from '../src/builtin-skills.js'
import { SubAgentManager } from '../src/subagent-manager.js'
import { getBuiltinSubAgents, BUILTIN_SUBAGENT_IDS } from '../src/builtin-subagents.js'

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

describe('getBuiltinSubAgents', () => {
  it('返回 4 个 builtin subagent', () => {
    const list = getBuiltinSubAgents()
    expect(list).toHaveLength(4)
    expect(list.map((s) => s.id).sort()).toEqual([
      BUILTIN_SUBAGENT_IDS.codePlanner,
      BUILTIN_SUBAGENT_IDS.codeWriter,
      BUILTIN_SUBAGENT_IDS.researchCollector,
      BUILTIN_SUBAGENT_IDS.goalAuditor,
    ].sort())
  })

  it('全部 is_builtin=true + enabled=true', () => {
    for (const s of getBuiltinSubAgents()) {
      expect(s.is_builtin).toBe(true)
      expect(s.enabled).toBe(true)
    }
  })

  it('code_planner 使用 powerful role + 挂 writing-plans skill', () => {
    const p = getBuiltinSubAgents().find((s) => s.name === 'code_planner')!
    expect(p.model_role).toBe('powerful')
    expect(p.allowed_skill_ids).toContain(BUILTIN_SKILL_IDS.writingPlans)
  })

  it('code_writer 使用 cost_effective role + 挂 systematic-debugging + verification-before-completion', () => {
    const w = getBuiltinSubAgents().find((s) => s.name === 'code_writer')!
    expect(w.model_role).toBe('cost_effective')
    expect(w.allowed_skill_ids).toContain(BUILTIN_SKILL_IDS.systematicDebugging)
    expect(w.allowed_skill_ids).toContain(BUILTIN_SKILL_IDS.verificationBeforeCompletion)
  })

  it('research_collector 使用 vision role + 通用调查员 capabilities 全开', () => {
    // memory: feedback_research_collector_is_general — 2026-05-21 把 capabilities 全开恢复
    // 原意（通用调查员，不是 web 专科），断言同步跟上代码 entry。
    const r = getBuiltinSubAgents().find((s) => s.name === 'research_collector')!
    expect(r.model_role).toBe('vision')
    expect(r.builtin_capabilities.file_system).toBe(true)
    expect(r.builtin_capabilities.crab_memory).toBe(true)
    expect(r.allowed_mcp_server_ids).toEqual([])
  })
})

describe('SubAgentManager.seedBuiltin via getBuiltinSubAgents', () => {
  let tmpDir2: string
  let mgr2: SubAgentManager

  beforeEach(async () => {
    tmpDir2 = mkdtempSync(join(tmpdir(), 'subagent-seed-e2e-'))
    mgr2 = new SubAgentManager(tmpDir2)
    await mgr2.initialize()
  })

  afterEach(() => {
    rmSync(tmpDir2, { recursive: true, force: true })
  })

  it('空 registry 注入全 4 个', async () => {
    await mgr2.seedBuiltin(getBuiltinSubAgents())
    expect(mgr2.list()).toHaveLength(4)
  })

  it('idempotent — 第二次调用不变', async () => {
    await mgr2.seedBuiltin(getBuiltinSubAgents())
    await mgr2.seedBuiltin(getBuiltinSubAgents())
    expect(mgr2.list()).toHaveLength(4)
  })
})

describe('SubAgentManager.pruneObsoleteBuiltins', () => {
  let tmpDir3: string
  let mgr3: SubAgentManager

  beforeEach(async () => {
    tmpDir3 = mkdtempSync(join(tmpdir(), 'subagent-prune-'))
    mgr3 = new SubAgentManager(tmpDir3)
    await mgr3.initialize()
  })

  afterEach(() => {
    rmSync(tmpDir3, { recursive: true, force: true })
  })

  it('删除 is_builtin=true 但不在 active list 的 entry', async () => {
    const seedTs = '2026-05-19T00:00:00.000Z'
    await mgr3.seedBuiltin([
      {
        id: 'builtin-obsolete', name: 'obsolete', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
        provider_id: null, model_id: null, model_role: 'vision',
        builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
        allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
        enabled: true, is_builtin: true, created_at: seedTs, updated_at: seedTs,
      },
      {
        id: 'builtin-active', name: 'active', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
        provider_id: null, model_id: null, model_role: 'powerful',
        builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
        allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
        enabled: true, is_builtin: true, created_at: seedTs, updated_at: seedTs,
      },
    ])
    expect(mgr3.list()).toHaveLength(2)

    await mgr3.pruneObsoleteBuiltins(['builtin-active'])
    expect(mgr3.list().map((e) => e.id)).toEqual(['builtin-active'])
  })

  it('不删除非 builtin 项（即使不在 active list）', async () => {
    await mgr3.create({
      name: 'user-custom', description: '', when_to_use: 'x', role: 'r', workflow: 'w', deliverables: 'd',
      provider_id: 'p', model_id: 'm', model_role: null,
      builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
      allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
    })
    const userId = mgr3.list()[0].id

    await mgr3.pruneObsoleteBuiltins(['builtin-active'])
    expect(mgr3.list()).toHaveLength(1)
    expect(mgr3.list()[0].id).toBe(userId)
  })

  it('active list 为空时仍正常工作（删全部 builtin）', async () => {
    const seedTs = '2026-05-19T00:00:00.000Z'
    await mgr3.seedBuiltin([
      {
        id: 'builtin-a', name: 'a', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
        provider_id: null, model_id: null, model_role: 'vision',
        builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
        allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
        enabled: true, is_builtin: true, created_at: seedTs, updated_at: seedTs,
      },
    ])

    await mgr3.pruneObsoleteBuiltins([])
    expect(mgr3.list()).toHaveLength(0)
  })

  it('空 registry 不报错', async () => {
    await expect(mgr3.pruneObsoleteBuiltins(['builtin-a'])).resolves.not.toThrow()
  })

  it('无需删除时不调 save（活动状态不变）', async () => {
    const seedTs = '2026-05-19T00:00:00.000Z'
    await mgr3.seedBuiltin([
      {
        id: 'builtin-x', name: 'x', description: '', when_to_use: '', role: '', workflow: '', deliverables: '',
        provider_id: null, model_id: null, model_role: 'vision',
        builtin_capabilities: { file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false },
        allowed_mcp_server_ids: [], allowed_skill_ids: [], max_turns: 10,
        enabled: true, is_builtin: true, created_at: seedTs, updated_at: seedTs,
      },
    ])

    await mgr3.pruneObsoleteBuiltins(['builtin-x'])
    expect(mgr3.list().map((e) => e.id)).toEqual(['builtin-x'])
  })
})

describe('getBuiltinSubAgents > goal_auditor', () => {
  it('goal_auditor 配置正确', () => {
    const g = getBuiltinSubAgents().find((s) => s.name === 'goal_auditor')
    expect(g).toBeDefined()
    if (!g) return
    expect(g.id).toBe('builtin-goal-auditor')
    expect(g.model_role).toBe('powerful')
    expect(g.max_turns).toBe(50)
    expect(g.system_only).toBe(true)
    expect(g.is_builtin).toBe(true)
    expect(g.enabled).toBe(true)
    expect(g.builtin_capabilities).toEqual({
      file_system: true,
      shell: true,
      task_intel: false,
      crab_memory: false,
      crab_messaging: false,
    })
    expect(g.allowed_skill_ids).toContain('builtin-skill-verification-before-completion')
  })

  it('goal_auditor 的 prompt 五段都齐全（tool call 协议）', () => {
    const g = getBuiltinSubAgents().find((s) => s.name === 'goal_auditor')!
    expect(g.role.length).toBeGreaterThan(100)
    expect(g.workflow.length).toBeGreaterThan(100)
    // tool call 协议：要求调 submit_audit_result，不再 emit AUDIT_RESULT 自由文本
    expect(g.deliverables).toContain('submit_audit_result')
    expect(g.deliverables).toMatch(/pass.*boolean|failed_criteria|evidence/)
    expect(g.verification).toBeTruthy()
    expect(g.verification).toContain('submit_audit_result')
    expect(g.when_to_use).toContain('system_only')
  })
})
