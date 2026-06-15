/**
 * tar.gz 归档读取测试（真实 fixture，无 mock）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §4
 * 只列条目 + 按需读单个小文件，避免为概览全解压 GB 级 workspace。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { listArchiveEntries, readArchiveTextFile } from './archive-reader.js'

let tmpRoot: string
let archivePath: string

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-archive-test-'))
  const src = path.join(tmpRoot, 'backup-root')
  await fs.mkdir(path.join(src, 'skills', 'foo'), { recursive: true })
  await fs.writeFile(path.join(src, 'manifest.json'), JSON.stringify({ schemaVersion: 1 }), 'utf8')
  await fs.writeFile(path.join(src, 'openclaw.json'), JSON.stringify({ plugins: {} }), 'utf8')
  await fs.writeFile(path.join(src, 'skills', 'foo', 'SKILL.md'), '# foo skill', 'utf8')

  archivePath = path.join(tmpRoot, 'backup.tar.gz')
  await tar.c({ file: archivePath, gzip: true, cwd: tmpRoot }, ['backup-root'])
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('listArchiveEntries', () => {
  it('列出归档内全部条目路径', async () => {
    const entries = await listArchiveEntries(archivePath)

    expect(entries).toContain('backup-root/manifest.json')
    expect(entries).toContain('backup-root/openclaw.json')
    expect(entries).toContain('backup-root/skills/foo/SKILL.md')
  })
})

describe('readArchiveTextFile', () => {
  it('读出指定条目的文本内容', async () => {
    const content = await readArchiveTextFile(archivePath, 'backup-root/manifest.json')

    expect(content).not.toBeNull()
    expect(JSON.parse(content!)).toEqual({ schemaVersion: 1 })
  })

  it('条目不存在 → 返回 null', async () => {
    const content = await readArchiveTextFile(archivePath, 'backup-root/does-not-exist.json')

    expect(content).toBeNull()
  })
})
