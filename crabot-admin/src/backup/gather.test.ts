import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { gatherCategories, type GatherDeps } from './gather.js'
import { SECRET_PLACEHOLDER } from './scrub-secrets.js'

async function tmpdir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'backup-gather-'))
}

describe('gatherCategories', () => {
  let adminDir: string
  let memoryDir: string
  let staging: string

  beforeEach(async () => {
    adminDir = await tmpdir()
    memoryDir = await tmpdir()
    staging = await tmpdir()
    await fs.writeFile(
      path.join(adminDir, 'model_providers.json'),
      JSON.stringify([{ id: 'p1', name: 'openai', api_key: 'sk-real' }]),
    )
    await fs.writeFile(path.join(adminDir, 'tasks.json'), '[]')
    await fs.writeFile(path.join(adminDir, 'schedules.json'), '[]')
    await fs.mkdir(path.join(memoryDir, 'long_term', 'confirmed', 'fact'), { recursive: true })
    await fs.writeFile(path.join(memoryDir, 'long_term', 'confirmed', 'fact', 'm1.md'), '# hi')
  })

  function deps(): GatherDeps {
    return { adminDataDir: adminDir, memoryDataDir: memoryDir }
  }

  it('不含密钥时 providers 的 api_key 被置空', async () => {
    await gatherCategories({
      staging, selection: { categories: ['config'], includeSecrets: false }, deps: deps(),
    })
    const raw = await fs.readFile(path.join(staging, 'payload', 'config', 'model_providers.json'), 'utf-8')
    expect(JSON.parse(raw)[0].api_key).toBe(SECRET_PLACEHOLDER)
  })

  it('含密钥时 providers 的 api_key 原样保留', async () => {
    await gatherCategories({
      staging, selection: { categories: ['config'], includeSecrets: true }, deps: deps(),
    })
    const raw = await fs.readFile(path.join(staging, 'payload', 'config', 'model_providers.json'), 'utf-8')
    expect(JSON.parse(raw)[0].api_key).toBe('sk-real')
  })

  it('memory 类别复制 long_term 目录', async () => {
    await gatherCategories({
      staging, selection: { categories: ['memory'], includeSecrets: false }, deps: deps(),
    })
    const md = await fs.readFile(
      path.join(staging, 'payload', 'memory', 'long_term', 'confirmed', 'fact', 'm1.md'), 'utf-8',
    )
    expect(md).toBe('# hi')
  })

  it('提供 exportShortTermMemory 回调时写 short_term.json', async () => {
    const d: GatherDeps = { ...deps(), exportShortTermMemory: async () => ({ version: '1.1', short_term: [] }) }
    await gatherCategories({ staging, selection: { categories: ['memory'], includeSecrets: false }, deps: d })
    const raw = await fs.readFile(path.join(staging, 'payload', 'memory', 'short_term.json'), 'utf-8')
    expect(JSON.parse(raw).version).toBe('1.1')
  })

  it('缺失的可选文件不报错', async () => {
    await expect(
      gatherCategories({ staging, selection: { categories: ['config'], includeSecrets: true }, deps: deps() }),
    ).resolves.toBeUndefined()
  })
})
