/**
 * workspace 导入测试：提取 workspace 文件到目标目录（真实归档 fixture）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.4
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { importWorkspace } from './import-workspace.js'

let tmpRoot: string
let archivePath: string
const WS = 'bk-root/payload/posix/h/.openclaw/workspace'

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ws-'))
  const ws = path.join(tmpRoot, 'bk-root', 'payload', 'posix', 'h', '.openclaw', 'workspace')
  await fs.mkdir(path.join(ws, 'notes'), { recursive: true })
  await fs.writeFile(path.join(ws, 'todo.txt'), 'buy milk', 'utf8')
  await fs.writeFile(path.join(ws, 'notes', 'idea.md'), 'an idea', 'utf8')
  archivePath = path.join(tmpRoot, 'backup.tar.gz')
  await tar.c({ file: archivePath, gzip: true, cwd: tmpRoot }, ['bk-root'])
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('importWorkspace', () => {
  it('把 workspace 文件提取到 destDir，结果 imported', async () => {
    const dest = path.join(tmpRoot, 'crabot-ws', 'openclaw-workspace')

    const results = await importWorkspace({ archivePath, workspaceArchivePrefix: WS, destDir: dest })

    expect(await fs.readFile(path.join(dest, 'todo.txt'), 'utf8')).toBe('buy milk')
    expect(await fs.readFile(path.join(dest, 'notes', 'idea.md'), 'utf8')).toBe('an idea')
    expect(results).toEqual([{ kind: 'workspace', name: 'workspace', status: 'imported' }])
  })

  it('workspace 无文件 → 空结果', async () => {
    const dest = path.join(tmpRoot, 'crabot-ws2')

    const results = await importWorkspace({ archivePath, workspaceArchivePrefix: 'bk-root/payload/posix/h/.openclaw/nope', destDir: dest })

    expect(results).toEqual([])
  })
})
