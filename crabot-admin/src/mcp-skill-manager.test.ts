import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    // 严格：连 .tmp.* 也不能留
    expect(remaining).toEqual([])
  })

  it('catch 块清掉 tmpDir：copyDir 中途 fs.copyFile 失败', async () => {
    const srcDir = path.join(tmpRoot, 'src-mid-fail')
    await fs.mkdir(srcDir, { recursive: true })
    await fs.writeFile(
      path.join(srcDir, 'SKILL.md'),
      `---\nname: midfail\ndescription: d\nversion: 1.0.0\n---\nbody`,
    )
    // mock fs.copyFile 让 copyDir 走到中途失败 → 触发 catch 块
    const spy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('disk full simulated'))
    try {
      await expect(
        (manager as any).installSkillFromDirectory(srcDir, { source_type: 'imported' }),
      ).rejects.toThrow(/disk full/)
    } finally {
      spy.mockRestore()
    }
    const skillsRoot = path.join(dataDir, 'skills')
    const remaining = await fs.readdir(skillsRoot).catch(() => [])
    // catch 块必须把 .tmp.* 清掉
    expect(remaining).toEqual([])
  })

  it('overwrite 路径 rename 失败时回滚 snapshot 到 targetDir', async () => {
    // 第一次正常安装
    const srcDir1 = path.join(tmpRoot, 'src-v1')
    await fs.mkdir(srcDir1, { recursive: true })
    await fs.writeFile(
      path.join(srcDir1, 'SKILL.md'),
      `---\nname: rollback-target\ndescription: d\nversion: 1.0.0\n---\nv1-body`,
    )
    const { entry: e1 } = await (manager as any).installSkillFromDirectory(
      srcDir1,
      { source_type: 'imported' },
    )
    const targetDir = path.join(dataDir, 'skills', e1.id)
    // 第二次覆盖时让最终 rename(tmpDir → targetDir) 失败
    const srcDir2 = path.join(tmpRoot, 'src-v2')
    await fs.mkdir(srcDir2, { recursive: true })
    await fs.writeFile(
      path.join(srcDir2, 'SKILL.md'),
      `---\nname: rollback-target\ndescription: d\nversion: 2.0.0\n---\nv2-body`,
    )

    // rename 会被调用 2 次：
    //   call 1: targetDir → .snapshots/<id>-<ts>（旧目录搬到 snapshot）
    //   call 2: tmpDir → targetDir（新目录就位） ← 让它 throw
    const origRename = fs.rename
    let renameCallCount = 0
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      renameCallCount += 1
      if (renameCallCount === 2) {
        throw new Error('rename target failed simulated')
      }
      return origRename(src, dst)
    })

    try {
      await expect(
        (manager as any).installSkillFromDirectory(srcDir2, { source_type: 'imported' }, true),
      ).rejects.toThrow(/rename target failed/)
    } finally {
      spy.mockRestore()
    }

    // 回滚验证：旧 targetDir 应该被恢复（v1-body 还在）
    const body = await fs.readFile(path.join(targetDir, 'SKILL.md'), 'utf-8')
    expect(body).toContain('v1-body')

    // .tmp.* 必须清干净
    const skillsRoot = path.join(dataDir, 'skills')
    const remaining = await fs.readdir(skillsRoot)
    expect(remaining.filter(n => n.startsWith('.tmp.'))).toEqual([])
  })
})
