import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import AdmZip from 'adm-zip'
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

describe('importFromZip 完整保留 scripts/references/assets', () => {
  let tmpRoot: string
  let dataDir: string
  let manager: SkillManager

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-zip-'))
    dataDir = path.join(tmpRoot, 'data')
    await fs.mkdir(dataDir, { recursive: true })
    manager = new SkillManager(dataDir)
    await manager.initialize()
  })
  afterEach(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

  function buildZipBase64(entries: Array<{ name: string; content: string }>): string {
    const zip = new AdmZip()
    for (const e of entries) zip.addFile(e.name, Buffer.from(e.content, 'utf-8'))
    return zip.toBuffer().toString('base64')
  }

  it('zip 含 scripts/foo.py 上传后 scripts/foo.py 落到 <data_dir>/skills/<id>/', async () => {
    const b64 = buildZipBase64([
      { name: 'SKILL.md', content: '---\nname: zip-skill\ndescription: d\nversion: 1.0.0\n---\nbody' },
      { name: 'scripts/foo.py', content: 'print(1)' },
      { name: 'references/api.md', content: '# api' },
    ])
    const { entry } = await manager.importFromZip(b64, 'test.zip')
    expect(entry.skill_dir).toBeDefined()
    const skillDir = entry.skill_dir!
    expect(await fs.readFile(path.join(skillDir, 'scripts', 'foo.py'), 'utf-8')).toBe('print(1)')
    expect(await fs.readFile(path.join(skillDir, 'references', 'api.md'), 'utf-8')).toBe('# api')
  })

  it('zip 包了一层 wrapper 目录 my-skill/SKILL.md，能自动 strip', async () => {
    const b64 = buildZipBase64([
      { name: 'my-skill/SKILL.md', content: '---\nname: wrapped\ndescription: d\nversion: 1.0.0\n---\nbody' },
      { name: 'my-skill/scripts/x.py', content: 'x' },
    ])
    const { entry } = await manager.importFromZip(b64, 'wrapped.zip')
    expect(entry.skill_dir).toBeDefined()
    const skillDir = entry.skill_dir!
    expect(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')).toContain('body')
    expect(await fs.readFile(path.join(skillDir, 'scripts', 'x.py'), 'utf-8')).toBe('x')
  })

  it('拒绝 zip slip：entry 名含 ../', async () => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: slip\ndescription: d\nversion: 1.0.0\n---\nbody'))
    zip.addFile('evil.sh', Buffer.from('pwn'))
    // adm-zip 的 addFile 会调用 canonical() 把 ../ 去掉；只能 add 后再回填 entryName 才能造出带 ../ 的恶意 zip
    for (const e of zip.getEntries()) {
      if (e.entryName === 'evil.sh') e.entryName = '../evil.sh'
    }
    const b64 = zip.toBuffer().toString('base64')
    await expect(manager.importFromZip(b64, 'slip.zip')).rejects.toThrow(/path traversal|非法路径|invalid/i)
  })

  it('拒绝 zip slip：path.resolve 防御兜底（第二道防线）', async () => {
    // 在 POSIX 上 path.join(absRoot, anything) 总会规范化到 absRoot 下，
    // 第一道防御 (entryName.includes('..')) 已经覆盖了所有真实攻击样本。
    // 这里通过 mock path.join 模拟一个"第一道漏过、第二道必须拦下"的场景，
    // 验证 path.resolve 防御逻辑确实生效（防御深度，防止未来重构破坏不变量）。
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: defend\ndescription: d\nversion: 1.0.0\n---\nbody'))
    zip.addFile('benign.txt', Buffer.from('pwn'))
    const b64 = zip.toBuffer().toString('base64')

    // 注意：entryName 不含 ..，第一道防御不会触发
    // 但我们让 path.join 在处理 benign.txt 时返回一个解析后越界的路径
    const origJoin = path.join.bind(path)
    const spy = vi.spyOn(path, 'join').mockImplementation((...args: string[]) => {
      const result = origJoin(...args)
      // 只在拼接 benign.txt 这一次时改成越界路径，其他调用照常
      if (args[args.length - 1] === 'benign.txt') {
        return '/tmp/crabot-zipslip-evil-out-of-bounds'
      }
      return result
    })

    try {
      await expect(manager.importFromZip(b64, 'defend.zip')).rejects.toThrow(/path traversal|非法路径|invalid/i)
    } finally {
      spy.mockRestore()
    }
  })

  it('importFromZip 成功后 <skillsRoot> 不留 .extract.* 残留', async () => {
    const b64 = buildZipBase64([
      { name: 'SKILL.md', content: '---\nname: cleanup-test\ndescription: d\nversion: 1.0.0\n---\nbody' },
      { name: 'scripts/x.py', content: 'x' },
    ])
    await manager.importFromZip(b64, 'cleanup.zip')
    const skillsRoot = path.join(dataDir, 'skills')
    const remaining = await fs.readdir(skillsRoot)
    expect(remaining.filter(n => n.startsWith('.extract.'))).toEqual([])
  })
})
