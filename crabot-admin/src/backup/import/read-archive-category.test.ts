import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as tar from 'tar'
import { readJsonArrayFromArchive } from './read-archive-category.js'

describe('readJsonArrayFromArchive', () => {
  let archive: string

  beforeEach(async () => {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-read-'))
    await fs.mkdir(path.join(staging, 'payload', 'tasks'), { recursive: true })
    await fs.writeFile(
      path.join(staging, 'payload', 'tasks', 'tasks.json'),
      JSON.stringify([{ id: 't1' }, { id: 't2' }]),
    )
    const out = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-read-out-'))
    archive = path.join(out, 'a.tar.gz')
    await tar.c({ gzip: true, file: archive, cwd: staging }, await fs.readdir(staging))
  })

  it('读出指定 payload 路径的 JSON 数组', async () => {
    const rows = await readJsonArrayFromArchive(archive, 'payload/tasks/tasks.json')
    expect(rows.map((r) => (r as { id: string }).id)).toEqual(['t1', 't2'])
  })

  it('文件不存在返回空数组', async () => {
    const rows = await readJsonArrayFromArchive(archive, 'payload/tasks/missing.json')
    expect(rows).toEqual([])
  })

  it('非数组内容返回空数组', async () => {
    const rows = await readJsonArrayFromArchive(archive, 'manifest.json')
    expect(rows).toEqual([])
  })
})
