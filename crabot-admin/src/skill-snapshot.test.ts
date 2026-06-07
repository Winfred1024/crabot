import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { SkillManager, readSkillDirFiles, writeSkillDirFiles } from './mcp-skill-manager'

async function makeTmpDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

describe('readSkillDirFiles', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir('crabot-readskill-')
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('空目录返回 {}', async () => {
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toEqual({})
  })

  it('SKILL.md 不会被读', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), 'content', 'utf-8')
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toEqual({})
  })

  it('.skill_dir / .DS_Store / 隐藏文件不会被读', async () => {
    await fs.writeFile(path.join(tmpDir, '.skill_dir'), '/some/path', 'utf-8')
    await fs.writeFile(path.join(tmpDir, '.DS_Store'), 'macos', 'utf-8')
    await fs.writeFile(path.join(tmpDir, '.hidden'), 'h', 'utf-8')
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toEqual({})
  })

  it('文本文件按相对路径作 key 直存', async () => {
    await fs.writeFile(path.join(tmpDir, 'foo.md'), 'foo content', 'utf-8')
    await fs.mkdir(path.join(tmpDir, 'references'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'references', 'arch.md'), 'arch', 'utf-8')
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toEqual({
      'foo.md': 'foo content',
      'references/arch.md': 'arch',
    })
  })

  it('二进制文件用 base64: 前缀编码', async () => {
    const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    await fs.writeFile(path.join(tmpDir, 'img.png'), binBytes)
    const result = await readSkillDirFiles(tmpDir)
    expect(result!['img.png']).toBe(`base64:${binBytes.toString('base64')}`)
  })

  it('单文件 > 1MB 跳过且记录 warning', async () => {
    const bigBuf = Buffer.alloc(1024 * 1024 + 1, 'a')
    await fs.writeFile(path.join(tmpDir, 'big.txt'), bigBuf)
    await fs.writeFile(path.join(tmpDir, 'small.txt'), 'ok', 'utf-8')
    const result = await readSkillDirFiles(tmpDir)
    expect('big.txt' in (result ?? {})).toBe(false)
    expect((result ?? {})['small.txt']).toBe('ok')
  })

  it('总大小 > 5MB 返回 undefined', async () => {
    // 6 个 ~900KB 文件 → 累计超 5MB
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(path.join(tmpDir, `f${i}.txt`), Buffer.alloc(900 * 1024, 'a'))
    }
    const result = await readSkillDirFiles(tmpDir)
    expect(result).toBeUndefined()
  })

  it('源目录不存在时抛 ENOENT（调用方决定怎么处理）', async () => {
    await expect(readSkillDirFiles(path.join(tmpDir, 'nonexistent'))).rejects.toThrow()
  })
})

describe('SkillManager.update — snapshot 行为', () => {
  let tmpData: string
  let manager: SkillManager
  let skillSrcDir: string

  beforeEach(async () => {
    tmpData = await makeTmpDir('crabot-data-')
    manager = new SkillManager(tmpData)
    await manager.initialize()
    skillSrcDir = await makeTmpDir('crabot-skill-src-')
    await fs.writeFile(
      path.join(skillSrcDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: t\nversion: 1.0.0\n---\nv1 content',
      'utf-8',
    )
  })
  afterEach(async () => {
    await fs.rm(tmpData, { recursive: true, force: true })
    await fs.rm(skillSrcDir, { recursive: true, force: true })
  })

  it('content 变化 + 非 builtin → previous_snapshot 写入', async () => {
    const created = await manager.importFromLocalPath(skillSrcDir)
    expect(created.previous_snapshot).toBeUndefined()

    await fs.writeFile(
      path.join(skillSrcDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: t\nversion: 1.1.0\n---\nv2 content',
      'utf-8',
    )
    const updated = await manager.update(created.id, {
      content: 'v2 content',
      version: '1.1.0',
    })
    expect(updated.previous_snapshot).toBeDefined()
    expect(updated.previous_snapshot!.content).toContain('v1 content')
    expect(updated.previous_snapshot!.version).toBe('1.0.0')
    expect(updated.previous_snapshot!.snapshotted_at).toBeDefined()
  })

  it('仅 enabled toggle（content 不变）→ previous_snapshot 保留原值', async () => {
    const created = await manager.importFromLocalPath(skillSrcDir)
    // 先做一次 content update 制造 previous_snapshot
    const afterFirstUpdate = await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    const firstSnapshotted = afterFirstUpdate.previous_snapshot!.snapshotted_at

    // 再 toggle enabled，previous_snapshot 不应被覆盖
    const afterToggle = await manager.update(created.id, { enabled: false })
    expect(afterToggle.previous_snapshot).toBeDefined()
    expect(afterToggle.previous_snapshot!.snapshotted_at).toBe(firstSnapshotted)
  })

  it('连续两次 content update → 第一版被覆盖（N=1）', async () => {
    const created = await manager.importFromLocalPath(skillSrcDir)
    await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    const afterSecond = await manager.update(created.id, { content: 'v3', version: '1.2.0' })
    expect(afterSecond.previous_snapshot!.content).toBe('v2')
    expect(afterSecond.previous_snapshot!.version).toBe('1.1.0')
  })

  it('skill_dir 不存在 → previous_snapshot.files 为 undefined，不报错', async () => {
    // 模拟 skill_dir 字段缺失的纯 JSON skill：直接用 create() 不带 skill_dir
    const created = await manager.create({
      name: 'pure-json-skill',
      description: 't',
      version: '1.0.0',
      content: 'v1',
    })
    expect(created.skill_dir).toBeUndefined()
    const updated = await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    expect(updated.previous_snapshot).toBeDefined()
    expect(updated.previous_snapshot!.files).toBeUndefined()
  })

  it('skill_dir 有附属文件 → previous_snapshot.files 包含它们', async () => {
    await fs.writeFile(path.join(skillSrcDir, 'helper.md'), 'helper v1', 'utf-8')
    const created = await manager.importFromLocalPath(skillSrcDir)

    // update() 读 skill_dir 当时的磁盘状态（snapshot 在 update 应用前抓拍）
    // Task 2 的 writeSkillDirFiles 之后才会改文件；这里只验证 read 阶段
    const updated = await manager.update(created.id, { content: 'v2', version: '1.1.0' })

    expect(updated.previous_snapshot!.files).toEqual({ 'helper.md': 'helper v1' })
  })

  it('is_builtin = true → previous_snapshot 永不写入', async () => {
    // 手工塞一个 builtin entry（实际 builtin 由 builtin-skills.ts 注入）
    const builtin = await manager.create({
      name: 'fake-builtin',
      description: 't',
      version: '1.0.0',
      content: 'v1',
    })
    // 强制改 is_builtin = true（绕过正常路径，专门测 update 的分支）
    const map = (manager as unknown as { skills: Map<string, typeof builtin> }).skills
    map.set(builtin.id, { ...builtin, is_builtin: true })

    const updated = await manager.update(builtin.id, { content: 'v2', version: '1.1.0' })
    expect(updated.previous_snapshot).toBeUndefined()
  })
})

describe('writeSkillDirFiles', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await makeTmpDir('crabot-writeskill-')
  })
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('写 SKILL.md content', async () => {
    await writeSkillDirFiles(tmpDir, 'hello', {})
    const got = await fs.readFile(path.join(tmpDir, 'SKILL.md'), 'utf-8')
    expect(got).toBe('hello')
  })

  it('写多个文本附属文件', async () => {
    await writeSkillDirFiles(tmpDir, 'main', {
      'helper.md': 'h',
      'references/arch.md': 'arch',
    })
    expect(await fs.readFile(path.join(tmpDir, 'SKILL.md'), 'utf-8')).toBe('main')
    expect(await fs.readFile(path.join(tmpDir, 'helper.md'), 'utf-8')).toBe('h')
    expect(await fs.readFile(path.join(tmpDir, 'references', 'arch.md'), 'utf-8')).toBe('arch')
  })

  it('base64: 前缀文件解码回二进制', async () => {
    const binBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    await writeSkillDirFiles(tmpDir, 'main', {
      'img.png': `base64:${binBytes.toString('base64')}`,
    })
    const got = await fs.readFile(path.join(tmpDir, 'img.png'))
    expect(Buffer.compare(got, binBytes)).toBe(0)
  })

  it('清理 files 之外的文件（restore 时新增的要删）', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), 'old', 'utf-8')
    await fs.writeFile(path.join(tmpDir, 'extra.md'), 'extra', 'utf-8')
    await writeSkillDirFiles(tmpDir, 'new', { 'helper.md': 'h' })
    expect(await fs.readFile(path.join(tmpDir, 'SKILL.md'), 'utf-8')).toBe('new')
    expect(await fs.readFile(path.join(tmpDir, 'helper.md'), 'utf-8')).toBe('h')
    await expect(fs.access(path.join(tmpDir, 'extra.md'))).rejects.toThrow()
  })

  it('清理空子目录', async () => {
    await fs.mkdir(path.join(tmpDir, 'orphan'), { recursive: true })
    await writeSkillDirFiles(tmpDir, 'new', {})
    await expect(fs.access(path.join(tmpDir, 'orphan'))).rejects.toThrow()
  })

  it('.skill_dir 等 sentinel 文件不会被清理', async () => {
    await fs.writeFile(path.join(tmpDir, '.skill_dir'), '/some/path', 'utf-8')
    await fs.writeFile(path.join(tmpDir, '.DS_Store'), 'macos', 'utf-8')
    await writeSkillDirFiles(tmpDir, 'new', {})
    expect(await fs.readFile(path.join(tmpDir, '.skill_dir'), 'utf-8')).toBe('/some/path')
    expect(await fs.readFile(path.join(tmpDir, '.DS_Store'), 'utf-8')).toBe('macos')
  })

  it('files = undefined 时只写 SKILL.md，不动其它', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), 'old', 'utf-8')
    await fs.writeFile(path.join(tmpDir, 'keep.md'), 'keep', 'utf-8')
    await writeSkillDirFiles(tmpDir, 'new', undefined)
    expect(await fs.readFile(path.join(tmpDir, 'SKILL.md'), 'utf-8')).toBe('new')
    expect(await fs.readFile(path.join(tmpDir, 'keep.md'), 'utf-8')).toBe('keep')
  })

  it('嵌套路径自动 mkdir -p', async () => {
    await writeSkillDirFiles(tmpDir, 'main', {
      'a/b/c/deep.md': 'deep',
    })
    expect(await fs.readFile(path.join(tmpDir, 'a', 'b', 'c', 'deep.md'), 'utf-8')).toBe('deep')
  })
})

describe('SkillManager.restore', () => {
  let tmpData: string
  let manager: SkillManager
  let skillSrcDir: string

  beforeEach(async () => {
    tmpData = await makeTmpDir('crabot-data-')
    manager = new SkillManager(tmpData)
    await manager.initialize()
    skillSrcDir = await makeTmpDir('crabot-skill-src-')
    await fs.writeFile(
      path.join(skillSrcDir, 'SKILL.md'),
      '---\nname: t\ndescription: t\nversion: 1.0.0\n---\nv1',
      'utf-8',
    )
  })
  afterEach(async () => {
    await fs.rm(tmpData, { recursive: true, force: true })
    await fs.rm(skillSrcDir, { recursive: true, force: true })
  })

  it('无 previous_snapshot → throw', async () => {
    const created = await manager.importFromLocalPath(skillSrcDir)
    await expect(manager.restore(created.id)).rejects.toThrow(/没有上一版可恢复/)
  })

  it('is_builtin → throw', async () => {
    const builtin = await manager.create({
      name: 'fake-builtin', description: 't', version: '1.0.0', content: 'v1',
    })
    const map = (manager as unknown as { skills: Map<string, typeof builtin> }).skills
    map.set(builtin.id, { ...builtin, is_builtin: true, previous_snapshot: {
      content: 'old', version: '0.9.0', updated_at: 't', snapshotted_at: 't',
    }})
    await expect(manager.restore(builtin.id)).rejects.toThrow(/是内置的，不能 restore/)
  })

  it('正常 swap：current ↔ previous，磁盘 SKILL.md 也写回', async () => {
    const created = await manager.importFromLocalPath(skillSrcDir)
    await fs.writeFile(
      path.join(skillSrcDir, 'SKILL.md'),
      '---\nname: t\ndescription: t\nversion: 1.1.0\n---\nv2',
      'utf-8',
    )
    await manager.update(created.id, { content: 'v2_content', version: '1.1.0' })

    const restored = await manager.restore(created.id)

    // content + version 复位
    expect(restored.content).toContain('v1')
    expect(restored.version).toBe('1.0.0')
    // 磁盘也复位
    const onDisk = await fs.readFile(path.join(skillSrcDir, 'SKILL.md'), 'utf-8')
    expect(onDisk).toContain('v1')
    // 新 previous 是刚才的 current
    expect(restored.previous_snapshot!.content).toBe('v2_content')
    expect(restored.previous_snapshot!.version).toBe('1.1.0')
  })

  it('连续两次 restore → 来回 swap', async () => {
    const created = await manager.importFromLocalPath(skillSrcDir)
    await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    await manager.restore(created.id)  // 第一次 restore，content 回 v1
    const second = await manager.restore(created.id)  // 第二次 restore，content 回 v2
    expect(second.content).toBe('v2')
  })

  it('附属文件也被 restore（包括新增的要删）', async () => {
    await fs.writeFile(path.join(skillSrcDir, 'helper.md'), 'helper v1', 'utf-8')
    const created = await manager.importFromLocalPath(skillSrcDir)

    // update：admin 不会动 helper.md（admin 只 read，没 write 外部 dir）
    // 模拟用户在 update 之后又往 skillSrcDir 加了 extra.md（模拟 "--overwrite 时用户改了多个文件"）
    await manager.update(created.id, { content: 'v2_content', version: '1.1.0' })
    // update 之后才加 extra.md（模拟"现在 disk 上多了一个文件"）
    await fs.writeFile(path.join(skillSrcDir, 'extra.md'), 'extra', 'utf-8')

    await manager.restore(created.id)

    // helper.md 应该仍是 v1（snapshot 捕获时是 v1，restore 写回 v1）
    expect(await fs.readFile(path.join(skillSrcDir, 'helper.md'), 'utf-8')).toBe('helper v1')
    // extra.md 被删（不在 snapshot.files 内）
    await expect(fs.access(path.join(skillSrcDir, 'extra.md'))).rejects.toThrow()
  })

  it('skill_dir 不存在（纯 JSON skill）也能 restore（只 swap content）', async () => {
    const created = await manager.create({
      name: 'pure-json', description: 't', version: '1.0.0', content: 'v1',
    })
    await manager.update(created.id, { content: 'v2', version: '1.1.0' })
    const restored = await manager.restore(created.id)
    expect(restored.content).toBe('v1')
  })
})
