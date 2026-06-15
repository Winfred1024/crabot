/**
 * 归档子树提取测试（真实 tar.gz fixture）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.5（skill 整目录）/ §5.3 / §5.4
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { extractArchiveSubtree } from './extract-subtree.js'

let tmpRoot: string
let archivePath: string
const PREFIX = 'bk-root/payload/posix/h/.openclaw/skills'

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-subtree-'))
  const src = path.join(tmpRoot, 'bk-root', 'payload', 'posix', 'h', '.openclaw', 'skills')
  await fs.mkdir(path.join(src, 'foo', 'scripts'), { recursive: true })
  await fs.writeFile(path.join(src, 'foo', 'SKILL.md'), '# foo', 'utf8')
  await fs.writeFile(path.join(src, 'foo', 'scripts', 'run.py'), 'print(1)', 'utf8')
  await fs.mkdir(path.join(src, 'bar'), { recursive: true })
  await fs.writeFile(path.join(src, 'bar', 'SKILL.md'), '# bar', 'utf8')
  // 一个不该被提取的兄弟目录
  await fs.mkdir(path.join(tmpRoot, 'bk-root', 'payload', 'posix', 'h', '.openclaw', 'other'), { recursive: true })
  await fs.writeFile(path.join(tmpRoot, 'bk-root', 'payload', 'posix', 'h', '.openclaw', 'other', 'x.txt'), 'no', 'utf8')

  archivePath = path.join(tmpRoot, 'backup.tar.gz')
  await tar.c({ file: archivePath, gzip: true, cwd: tmpRoot }, ['bk-root'])
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('extractArchiveSubtree', () => {
  it('把 prefix 下的文件提取到 destDir（剥掉 prefix，保留相对结构）', async () => {
    const dest = path.join(tmpRoot, 'out-skills')

    const count = await extractArchiveSubtree(archivePath, PREFIX, dest)

    expect(await fs.readFile(path.join(dest, 'foo', 'SKILL.md'), 'utf8')).toBe('# foo')
    expect(await fs.readFile(path.join(dest, 'foo', 'scripts', 'run.py'), 'utf8')).toBe('print(1)')
    expect(await fs.readFile(path.join(dest, 'bar', 'SKILL.md'), 'utf8')).toBe('# bar')
    expect(count).toBe(3) // 三个文件
  })

  it('不提取 prefix 以外的文件', async () => {
    const dest = path.join(tmpRoot, 'out-skills2')

    await extractArchiveSubtree(archivePath, PREFIX, dest)

    await expect(fs.readFile(path.join(dest, '..', 'other', 'x.txt'), 'utf8')).rejects.toThrow()
  })

  it('prefix 下无文件 → 返回 0', async () => {
    const dest = path.join(tmpRoot, 'out-empty')

    const count = await extractArchiveSubtree(archivePath, 'bk-root/payload/posix/h/.openclaw/nonexistent', dest)

    expect(count).toBe(0)
  })
})
