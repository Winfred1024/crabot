/**
 * memory 导入测试：OpenClaw 记忆 markdown → Memory v2 write_long_term（真实归档 fixture）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.3
 * 判断：每个记忆 markdown 文件 → 一条 fact entry，content=原文（语义错配下的务实选择）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { importMemory } from './import-memory.js'

let tmpRoot: string
let archivePath: string
const WS = 'bk-root/payload/posix/h/.openclaw/workspace'

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-mem-'))
  const ws = path.join(tmpRoot, 'bk-root', 'payload', 'posix', 'h', '.openclaw', 'workspace')
  await fs.mkdir(path.join(ws, 'memory'), { recursive: true })
  await fs.writeFile(path.join(ws, 'MEMORY.md'), '# 主记忆\n要点 A', 'utf8')
  await fs.writeFile(path.join(ws, 'memory', '2026-06-15.md'), '今天的日记', 'utf8')
  await fs.writeFile(path.join(ws, 'memory', 'empty.md'), '   ', 'utf8')
  archivePath = path.join(tmpRoot, 'backup.tar.gz')
  await tar.c({ file: archivePath, gzip: true, cwd: tmpRoot }, ['bk-root'])
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('importMemory', () => {
  it('每个非空记忆文件 → write_long_term(type=fact, content=原文)', async () => {
    const writes: Array<{ type: string; content: string }> = []
    const deps = { writeLongTerm: vi.fn(async (p: { type: string; content: string }) => { writes.push(p) }) }

    const results = await importMemory({
      archivePath,
      memoryFiles: [
        { name: 'MEMORY.md', entryPath: `${WS}/MEMORY.md` },
        { name: 'memory/2026-06-15.md', entryPath: `${WS}/memory/2026-06-15.md` },
      ],
      deps,
    })

    expect(deps.writeLongTerm).toHaveBeenCalledTimes(2)
    expect(writes.every((w) => w.type === 'fact')).toBe(true)
    expect(writes.find((w) => w.content.includes('要点 A'))).toBeTruthy()
    expect(results.filter((r) => r.status === 'imported')).toHaveLength(2)
  })

  it('空白文件 → 跳过，不写', async () => {
    const deps = { writeLongTerm: vi.fn(async () => {}) }

    const results = await importMemory({
      archivePath,
      memoryFiles: [{ name: 'memory/empty.md', entryPath: `${WS}/memory/empty.md` }],
      deps,
    })

    expect(deps.writeLongTerm).not.toHaveBeenCalled()
    expect(results).toEqual([])
  })
})
