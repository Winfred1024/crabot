import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SkillManager } from './mcp-skill-manager'

async function makeWorkspace(skills: Array<{ name: string; description: string }>): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-scan-test-'))
  const agentSkillsDir = path.join(tmpDir, '.agents', 'skills')
  for (const skill of skills) {
    const skillDir = path.join(agentSkillsDir, skill.name)
    await fs.mkdir(skillDir, { recursive: true })
    const content = `---\nname: ${skill.name}\ndescription: ${skill.description}\nversion: 1.0.0\n---\n# ${skill.name}\n`
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8')
  }
  return tmpDir
}

describe('SkillManager.scanWorkspaceSkills', () => {
  let tmpData: string
  let manager: SkillManager

  beforeEach(async () => {
    tmpData = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-data-'))
    manager = new SkillManager(tmpData)
    await manager.initialize()
  })

  afterEach(async () => {
    await fs.rm(tmpData, { recursive: true, force: true })
  })

  it('空工作区返回 0', async () => {
    const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-ws-'))
    try {
      const count = await manager.scanWorkspaceSkills(tmpWs)
      expect(count).toBe(0)
      expect(manager.list()).toHaveLength(0)
    } finally {
      await fs.rm(tmpWs, { recursive: true, force: true })
    }
  })

  it('.agents/skills 不存在时返回 0 不抛出', async () => {
    const count = await manager.scanWorkspaceSkills('/nonexistent/path')
    expect(count).toBe(0)
  })

  it('扫描到新 skill 后注册表有对应条目', async () => {
    const ws = await makeWorkspace([
      { name: 'lark-im', description: '飞书即时通讯' },
      { name: 'lark-doc', description: '飞书文档' },
    ])
    try {
      const count = await manager.scanWorkspaceSkills(ws)
      expect(count).toBe(2)
      const skills = manager.list()
      expect(skills).toHaveLength(2)
      expect(skills.map(s => s.name).sort()).toEqual(['lark-doc', 'lark-im'])
      for (const s of skills) {
        expect(s.source_type).toBe('scanned')
        expect(s.is_builtin).toBe(false)
        expect(s.enabled).toBe(true)
        expect(s.skill_dir).toContain('.agents/skills')
      }
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('已存在同名 skill 时跳过不重复添加', async () => {
    const ws = await makeWorkspace([{ name: 'lark-im', description: '飞书 IM' }])
    try {
      await manager.scanWorkspaceSkills(ws)
      const count2 = await manager.scanWorkspaceSkills(ws)
      expect(count2).toBe(0)
      expect(manager.list()).toHaveLength(1)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('删除后再扫描会重新加回', async () => {
    const ws = await makeWorkspace([{ name: 'lark-im', description: '飞书 IM' }])
    try {
      await manager.scanWorkspaceSkills(ws)
      const [skill] = manager.list()
      await manager.delete(skill.id)
      expect(manager.list()).toHaveLength(0)

      const count = await manager.scanWorkspaceSkills(ws)
      expect(count).toBe(1)
      expect(manager.list()).toHaveLength(1)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })

  it('没有 SKILL.md 的子目录被跳过', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-ws-'))
    try {
      const agentSkillsDir = path.join(ws, '.agents', 'skills')
      await fs.mkdir(path.join(agentSkillsDir, 'empty-dir'), { recursive: true })
      const count = await manager.scanWorkspaceSkills(ws)
      expect(count).toBe(0)
    } finally {
      await fs.rm(ws, { recursive: true, force: true })
    }
  })
})
