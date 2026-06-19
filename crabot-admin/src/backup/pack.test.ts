import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { packArchive } from './pack.js'
import { listArchiveEntries, readArchiveTextFile } from '../openclaw-import/archive-reader.js'

describe('packArchive', () => {
  let staging: string
  let outDir: string

  beforeEach(async () => {
    staging = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-staging-'))
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-out-'))
    await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ product: 'crabot' }))
    await fs.mkdir(path.join(staging, 'payload', 'config'), { recursive: true })
    await fs.writeFile(path.join(staging, 'payload', 'config', 'tasks.json'), '[]')
  })

  it('打出的 tar.gz 含 manifest.json 与 payload', async () => {
    const out = path.join(outDir, 'b.tar.gz')
    await packArchive({ staging, outPath: out })
    const entries = await listArchiveEntries(out)
    expect(entries).toContain('manifest.json')
    expect(entries.some((e) => e.endsWith('payload/config/tasks.json'))).toBe(true)
    const manifest = await readArchiveTextFile(out, 'manifest.json')
    expect(JSON.parse(manifest!).product).toBe('crabot')
  })
})
