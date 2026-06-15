/**
 * top 导入编排集成测试：真实归档 + fake managers，验证按 selection 路由到各导入器并汇总。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §8 / §9
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { runImport } from './run-import.js'

let tmpRoot: string
let archivePath: string

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-run-'))
  const root = path.join(tmpRoot, 'bk-root')
  const HOME = '/h'
  const stateDir = `${HOME}/.openclaw`
  const payload = path.join(root, 'payload', 'posix', 'h', '.openclaw')

  const manifest = {
    schemaVersion: 1,
    createdAt: '2026-06-15T00:00:00.000Z',
    archiveRoot: 'bk-root',
    runtimeVersion: '1',
    platform: 'linux',
    nodeVersion: 'v22',
    options: { includeWorkspace: true },
    paths: { stateDir, configPath: `${stateDir}/openclaw.json`, oauthDir: `${stateDir}/credentials`, workspaceDirs: [`${stateDir}/workspace`] },
    assets: [],
    skipped: [],
  }
  const config = {
    channels: { feishu: { accounts: { main: { appId: 'cli_x', appSecret: 's'.repeat(32) } } } },
    models: { providers: { openai: { baseUrl: 'https://api.openai.com', apiKey: 'sk-x', api: 'openai-completions', models: [] } } },
    mcp: { servers: { fs: { command: 'npx', args: ['srv'] } } },
  }

  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  await fs.mkdir(path.join(payload, 'skills', 'foo'), { recursive: true })
  await fs.writeFile(path.join(payload, 'openclaw.json'), JSON.stringify(config), 'utf8')
  await fs.writeFile(path.join(payload, 'skills', 'foo', 'SKILL.md'), '# foo', 'utf8')
  await fs.mkdir(path.join(payload, 'workspace', 'memory'), { recursive: true })
  await fs.writeFile(path.join(payload, 'workspace', 'MEMORY.md'), '# mem\n要点', 'utf8')
  await fs.writeFile(path.join(payload, 'workspace', 'notes.txt'), 'note', 'utf8')

  archivePath = path.join(tmpRoot, 'backup.tar.gz')
  await tar.c({ file: archivePath, gzip: true, cwd: tmpRoot }, ['bk-root'])
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

function makeDeps() {
  return {
    existingProviderNames: new Set<string>(),
    createProvider: vi.fn(async () => {}),
    existingChannelNames: new Set<string>(),
    createChannel: vi.fn(async () => {}),
    existingMcpNames: new Set<string>(),
    importMcpJson: vi.fn(async () => {}),
    existingSkillNames: new Set<string>(),
    importSkillDir: vi.fn(async () => {}),
    writeLongTerm: vi.fn(async () => {}),
    workspaceDestDir: path.join(tmpRoot, 'crabot-ws', 'openclaw-workspace'),
  }
}

describe('runImport', () => {
  it('全选 → 各导入器都被调用，summary 汇总，临时目录清理', async () => {
    const deps = makeDeps()
    const tempDir = path.join(tmpRoot, 'work-all')

    const summary = await runImport({
      archivePath,
      tempDir,
      selections: {
        providers: ['openai'],
        channels: [{ source_channel: 'feishu', account_id: 'main' }],
        mcp: ['fs'],
        skills: ['foo'],
        memory: true,
        workspace: true,
      },
      deps,
    })

    expect(deps.createProvider).toHaveBeenCalledTimes(1)
    expect(deps.createChannel).toHaveBeenCalledTimes(1)
    expect(deps.importMcpJson).toHaveBeenCalledTimes(1)
    expect(deps.importSkillDir).toHaveBeenCalledTimes(1)
    expect(deps.writeLongTerm).toHaveBeenCalledTimes(1) // MEMORY.md

    const kinds = summary.results.filter((r) => r.status === 'imported').map((r) => r.kind).sort()
    expect(kinds).toEqual(['channel', 'mcp', 'memory', 'provider', 'skill', 'workspace'])
    // workspace 落盘
    expect(await fs.readFile(path.join(deps.workspaceDestDir, 'notes.txt'), 'utf8')).toBe('note')
    // 临时目录已清理
    await expect(fs.access(tempDir)).rejects.toThrow()
  })

  it('不选的类别 → 对应导入器不被调用', async () => {
    const deps = makeDeps()
    const tempDir = path.join(tmpRoot, 'work-providers-only')

    const summary = await runImport({
      archivePath,
      tempDir,
      selections: { providers: ['openai'], channels: [], mcp: [], skills: [], memory: false, workspace: false },
      deps,
    })

    expect(deps.createProvider).toHaveBeenCalledTimes(1)
    expect(deps.createChannel).not.toHaveBeenCalled()
    expect(deps.importSkillDir).not.toHaveBeenCalled()
    expect(deps.writeLongTerm).not.toHaveBeenCalled()
    expect(summary.results.every((r) => r.kind === 'provider')).toBe(true)
  })
})
