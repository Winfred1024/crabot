import { describe, it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import * as tar from 'tar'
import { runCrabotImport, type ImportDeps } from './run-import.js'

async function makeArchive(payload: Record<string, Record<string, unknown>>): Promise<string> {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-run-'))
  await fs.writeFile(
    path.join(staging, 'manifest.json'),
    JSON.stringify({ schemaVersion: 1, product: 'crabot', categories: Object.keys(payload) }),
  )
  for (const [cat, files] of Object.entries(payload)) {
    await fs.mkdir(path.join(staging, 'payload', cat), { recursive: true })
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(staging, 'payload', cat, name), JSON.stringify(content))
    }
  }
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-run-out-'))
  const archive = path.join(out, 'a.tar.gz')
  await tar.c({ gzip: true, file: archive, cwd: staging }, await fs.readdir(staging))
  return archive
}

describe('runCrabotImport', () => {
  it('tasks 类别逐条过 upsert 并汇总，结束调 finalize', async () => {
    const archive = await makeArchive({ tasks: { 'tasks.json': [{ id: 't1' }, { id: 't2' }] } })
    const upserted: string[] = []
    let finalized = false
    const deps: ImportDeps = {
      upsertTask: async (t) => { upserted.push((t as { id: string }).id); return 'imported' },
      finalize: async () => { finalized = true },
    }
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['tasks'], onConflict: 'skip', deps,
    })
    expect(upserted).toEqual(['t1', 't2'])
    expect(summary.results.filter((r) => r.status === 'imported')).toHaveLength(2)
    expect(finalized).toBe(true)
  })

  it('未提供某类别 deps 时记 error 不崩', async () => {
    const archive = await makeArchive({ tasks: { 'tasks.json': [{ id: 't1' }] } })
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['tasks'], onConflict: 'skip', deps: { finalize: async () => {} },
    })
    expect(summary.errors.length).toBeGreaterThan(0)
  })

  it('未选中的类别不处理', async () => {
    const archive = await makeArchive({ tasks: { 'tasks.json': [{ id: 't1' }] } })
    let called = false
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['config'], onConflict: 'skip',
      deps: { upsertTask: async () => { called = true; return 'imported' }, finalize: async () => {} },
    })
    expect(called).toBe(false)
    expect(summary.results).toHaveLength(0)
  })

  it('upsert 抛错时该条记 failed，不中断其它条', async () => {
    const archive = await makeArchive({ tasks: { 'tasks.json': [{ id: 't1' }, { id: 't2' }] } })
    const deps: ImportDeps = {
      upsertTask: async (t) => {
        if ((t as { id: string }).id === 't1') throw new Error('boom')
        return 'imported'
      },
      finalize: async () => {},
    }
    const summary = await runCrabotImport({
      archivePath: archive, categories: ['tasks'], onConflict: 'skip', deps,
    })
    expect(summary.results.find((r) => r.id === 't1')?.status).toBe('failed')
    expect(summary.results.find((r) => r.id === 't2')?.status).toBe('imported')
  })
})
