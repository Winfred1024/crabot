/**
 * 备份概览组装集成测试（真实 tar.gz fixture，无 mock）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §4 / §5 / §8
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { buildBackupOverview } from './build-overview.js'

let tmpRoot: string

/** 在 tmp 下搭一个贴近真实结构的 backup 目录并打成 tar.gz，返回归档路径。 */
async function makeArchive(opts: { includeWorkspace: boolean; schemaVersion?: number }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpRoot, 'bk-'))
  const root = path.join(dir, 'bk-root')
  const HOME = '/h'
  const stateDir = `${HOME}/.openclaw`
  const configPath = `${stateDir}/openclaw.json`
  const workspaceDir = `${stateDir}/workspace`
  const payload = path.join(root, 'payload', 'posix', 'h', '.openclaw')

  const manifest = {
    schemaVersion: opts.schemaVersion ?? 1,
    createdAt: '2026-06-15T00:00:00.000Z',
    archiveRoot: 'bk-root',
    runtimeVersion: '1.2.3',
    platform: 'darwin',
    nodeVersion: 'v22',
    options: { includeWorkspace: opts.includeWorkspace },
    paths: { stateDir, configPath, oauthDir: `${stateDir}/credentials`, workspaceDirs: opts.includeWorkspace ? [workspaceDir] : [] },
    assets: [],
    skipped: [],
  }
  const config = {
    channels: {
      telegram: { accounts: { bot1: { botToken: '123:abc' } } },
      lark: { accounts: { main: { appId: 'cli_x', appSecret: 's'.repeat(32) } } },
      whatsapp: { enabled: true },
    },
    models: { providers: { openai: { baseUrl: 'https://api.openai.com', apiKey: 'sk-x', api: 'openai-completions' } } },
    mcp: { servers: { fs: { command: 'npx', args: ['srv'] } } },
  }

  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  await fs.mkdir(payload, { recursive: true })
  await fs.writeFile(path.join(payload, 'openclaw.json'), JSON.stringify(config), 'utf8')
  // skills
  await fs.mkdir(path.join(payload, 'skills', 'foo'), { recursive: true })
  await fs.writeFile(path.join(payload, 'skills', 'foo', 'SKILL.md'), '# foo', 'utf8')
  await fs.mkdir(path.join(payload, 'skills', 'bar'), { recursive: true })
  await fs.writeFile(path.join(payload, 'skills', 'bar', 'SKILL.md'), '# bar', 'utf8')
  if (opts.includeWorkspace) {
    await fs.mkdir(path.join(payload, 'workspace', 'memory'), { recursive: true })
    await fs.writeFile(path.join(payload, 'workspace', 'MEMORY.md'), '# mem', 'utf8')
    await fs.writeFile(path.join(payload, 'workspace', 'memory', '2026-06-15.md'), 'daily', 'utf8')
    await fs.writeFile(path.join(payload, 'workspace', 'notes.txt'), 'note', 'utf8')
  }

  const archivePath = path.join(dir, 'backup.tar.gz')
  await tar.c({ file: archivePath, gzip: true, cwd: dir }, ['bk-root'])
  return archivePath
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-overview-'))
})
afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('buildBackupOverview', () => {
  it('完整备份 → 串起 manifest + 三分析器 + skills/memory/workspace', async () => {
    const archive = await makeArchive({ includeWorkspace: true })

    const r = await buildBackupOverview(archive)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    const o = r.overview

    expect(o.manifest).toMatchObject({ schemaVersion: 1, includeWorkspace: true, createdAt: '2026-06-15T00:00:00.000Z' })
    // provider：明文 key + openai-completions → 可迁；概览脱敏（不含 api_key 明文，只 has_api_key）
    expect(o.providers).toHaveLength(1)
    expect(o.providers[0]).toMatchObject({ source_name: 'openai', format: 'openai', migratable: true, has_api_key: true })
    expect('api_key' in o.providers[0]).toBe(false)
    // channel：telegram + lark 可迁，whatsapp 灰显
    expect(o.channels.map((c) => c.channel).sort()).toEqual(['lark', 'telegram', 'whatsapp'])
    expect(o.channels.filter((c) => c.migratable).map((c) => c.channel).sort()).toEqual(['lark', 'telegram'])
    expect(o.channels.find((c) => c.channel === 'lark')).toMatchObject({ account_id: 'main', credentials: 'available' })
    // mcp
    expect(o.mcpServers).toHaveLength(1)
    expect(o.mcpServers[0]).toMatchObject({ name: 'fs', transport: 'stdio' })
    // skills
    expect(o.skills.sort()).toEqual(['bar', 'foo'])
    // memory：MEMORY.md + memory/2026-06-15.md = 2
    expect(o.memory).toEqual({ present: true, fileCount: 2 })
    // workspace 非记忆文件：notes.txt = 1
    expect(o.workspace).toEqual({ present: true, fileCount: 1 })
  })

  it('备份不含 workspace → memory/workspace 标记为缺失', async () => {
    const archive = await makeArchive({ includeWorkspace: false })

    const r = await buildBackupOverview(archive)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.overview.manifest.includeWorkspace).toBe(false)
    expect(r.overview.memory.present).toBe(false)
    expect(r.overview.workspace.present).toBe(false)
    // skills 在 state 下，不受 workspace 影响，仍应检出
    expect(r.overview.skills.sort()).toEqual(['bar', 'foo'])
  })

  it('schemaVersion 非 1 → ok:false', async () => {
    const archive = await makeArchive({ includeWorkspace: true, schemaVersion: 2 })

    const r = await buildBackupOverview(archive)

    expect(r.ok).toBe(false)
  })
})
