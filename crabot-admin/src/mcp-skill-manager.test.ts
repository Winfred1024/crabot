import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { SkillManager } from './mcp-skill-manager.js'

describe('installSkillFromDirectory', () => {
  let tmpRoot: string
  let dataDir: string
  let manager: SkillManager

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-test-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('安装完整 skill 目录（含 scripts/references/assets）后所有文件落到 <data_dir>/skills/<id>/', async () => {
    const srcDir = path.join(tmpRoot, 'src-skill')
    await fs.mkdir(path.join(srcDir, 'scripts'), { recursive: true })
    await fs.mkdir(path.join(srcDir, 'references'), { recursive: true })
    await fs.writeFile(path.join(srcDir, 'SKILL.md'), `---\nname: test-skill\ndescription: desc\nversion: 1.0.0\n---\n# Body`)
    await fs.writeFile(path.join(srcDir, 'scripts', 'foo.py'), 'print("hi")')
    await fs.writeFile(path.join(srcDir, 'references', 'api.md'), '# API')

    const { entry } = await (manager as any).installSkillFromDirectory(srcDir, { source_type: 'imported', source_url: 'test://x' })

    const installedDir = path.join(dataDir, 'skills', entry.id)
    expect(await fs.readFile(path.join(installedDir, 'SKILL.md'), 'utf-8')).toContain('# Body')
    expect(await fs.readFile(path.join(installedDir, 'scripts', 'foo.py'), 'utf-8')).toBe('print("hi")')
    expect(await fs.readFile(path.join(installedDir, 'references', 'api.md'), 'utf-8')).toBe('# API')
    expect(entry.skill_dir).toBe(installedDir)
    expect(entry.source_url).toBe('test://x')
  })

  it('原子写：失败时不留半成品', async () => {
    const srcDir = path.join(tmpRoot, 'no-skill-md')
    await fs.mkdir(srcDir, { recursive: true })
    // 没有 SKILL.md
    await expect((manager as any).installSkillFromDirectory(srcDir, { source_type: 'imported' })).rejects.toThrow(/SKILL\.md/)
    const skillsRoot = path.join(dataDir, 'skills')
    const remaining = await fs.readdir(skillsRoot).catch(() => [])
    expect(remaining.filter(n => !n.startsWith('.'))).toEqual([])
  })
})
