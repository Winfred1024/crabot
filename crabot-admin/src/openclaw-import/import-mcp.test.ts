/**
 * MCP 导入编排测试：冲突过滤 + 复用 crabot importFromJson。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.6 / §8
 */
import { describe, it, expect, vi } from 'vitest'
import { importMcpServers } from './import-mcp.js'
import type { OpenClawMcpConfig } from './openclaw-config.js'

const mcp: OpenClawMcpConfig = {
  servers: {
    fs: { command: 'npx', args: ['srv-fs'] },
    git: { command: 'uvx', args: ['srv-git'] },
    remote: { url: 'https://x', transport: 'streamable-http' },
  },
}

function makeDeps(existing: string[] = []) {
  const calls: string[] = []
  return {
    calls,
    deps: {
      existingMcpNames: new Set(existing),
      importMcpJson: vi.fn(async (json: string) => {
        calls.push(json)
      }),
    },
  }
}

describe('importMcpServers', () => {
  it('选中的 stdio server 无冲突 → importFromJson 收到 mcpServers，结果 imported', async () => {
    const { calls, deps } = makeDeps()

    const results = await importMcpServers(mcp, ['fs', 'git'], deps)

    expect(deps.importMcpJson).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(calls[0])
    expect(Object.keys(payload.mcpServers).sort()).toEqual(['fs', 'git'])
    expect(results.filter((r) => r.status === 'imported').map((r) => r.name).sort()).toEqual(['fs', 'git'])
  })

  it('同名已存在 → 跳过 conflict，不进 json', async () => {
    const { calls, deps } = makeDeps(['fs'])

    const results = await importMcpServers(mcp, ['fs', 'git'], deps)

    const payload = JSON.parse(calls[0])
    expect(Object.keys(payload.mcpServers)).toEqual(['git'])
    expect(results).toContainEqual({ kind: 'mcp', name: 'fs', status: 'skipped', reason: 'conflict' })
  })

  it('http server（importFromJson 不支持）→ 跳过 not-migratable', async () => {
    const { deps } = makeDeps()

    const results = await importMcpServers(mcp, ['remote'], deps)

    expect(deps.importMcpJson).not.toHaveBeenCalled()
    expect(results).toEqual([{ kind: 'mcp', name: 'remote', status: 'skipped', reason: 'not-migratable' }])
  })

  it('无可导入项 → 不调 importFromJson', async () => {
    const { deps } = makeDeps()

    await importMcpServers(mcp, [], deps)

    expect(deps.importMcpJson).not.toHaveBeenCalled()
  })
})
