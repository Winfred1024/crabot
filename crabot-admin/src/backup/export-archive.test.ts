import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { exportArchive } from './export-archive.js'
import { listArchiveEntries, readArchiveTextFile } from '../openclaw-import/archive-reader.js'

describe('exportArchive', () => {
  let adminDir: string
  let memoryDir: string
  let workDir: string

  beforeEach(async () => {
    adminDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-admin-'))
    memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-mem-'))
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-work-'))
    await fs.writeFile(path.join(adminDir, 'tasks.json'), '[]')
    await fs.writeFile(path.join(adminDir, 'schedules.json'), '[]')
  })

  it('产出含 manifest 与所选类别的归档，并清理 staging', async () => {
    const out = path.join(workDir, 'crabot-backup.tar.gz')
    const stagingRoot = path.join(workDir, 'staging')
    await exportArchive({
      selection: { categories: ['tasks'], includeSecrets: false },
      outPath: out,
      stagingRoot,
      runtimeVersion: '9.9.9',
      createdAt: '2026-06-19T00:00:00Z',
      deps: { adminDataDir: adminDir, memoryDataDir: memoryDir },
    })
    const entries = await listArchiveEntries(out)
    expect(entries.some((e) => e.endsWith('payload/tasks/tasks.json'))).toBe(true)
    const manifest = JSON.parse((await readArchiveTextFile(out, 'manifest.json'))!)
    expect(manifest.runtimeVersion).toBe('9.9.9')
    expect(manifest.categories).toEqual(['tasks'])
    // staging 已清理
    await expect(fs.access(stagingRoot)).rejects.toThrow()
  })
})
