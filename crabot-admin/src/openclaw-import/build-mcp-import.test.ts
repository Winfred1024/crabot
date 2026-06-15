/**
 * MCP 导入 payload 构建测试：AnalyzedMcpServer[] → crabot importFromJson 能吃的格式。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.6
 * 复用 mcp-skill-manager.importFromJson（Claude Desktop mcpServers 格式，仅 stdio）。
 */
import { describe, it, expect } from 'vitest'
import { buildMcpImportPayload } from './build-mcp-import.js'
import type { AnalyzedMcpServer } from './analyze-mcp.js'

describe('buildMcpImportPayload', () => {
  it('stdio server → mcpServers.{name}={command,args,env}', () => {
    const servers: AnalyzedMcpServer[] = [
      { source_name: 'fs', name: 'fs', transport: 'stdio', command: 'npx', args: ['srv'], env: { K: 'v' }, migratable: true, requires_local_env: true },
    ]

    const r = buildMcpImportPayload(servers)

    expect(r.payload).toEqual({ mcpServers: { fs: { command: 'npx', args: ['srv'], env: { K: 'v' } } } })
    expect(r.skipped).toEqual([])
  })

  it('http server（无 command）→ 不进 payload，列入 skipped', () => {
    const servers: AnalyzedMcpServer[] = [
      { source_name: 'remote', name: 'remote', transport: 'streamable-http', url: 'https://x', migratable: true },
    ]

    const r = buildMcpImportPayload(servers)

    expect(r.payload).toEqual({ mcpServers: {} })
    expect(r.skipped).toEqual(['remote'])
  })

  it('混合 → stdio 进 payload，http 进 skipped', () => {
    const servers: AnalyzedMcpServer[] = [
      { source_name: 'fs', name: 'fs', transport: 'stdio', command: 'npx', migratable: true, requires_local_env: true },
      { source_name: 'remote', name: 'remote', transport: 'sse', url: 'https://x', migratable: true },
    ]

    const r = buildMcpImportPayload(servers)

    expect(Object.keys(r.payload.mcpServers)).toEqual(['fs'])
    expect(r.skipped).toEqual(['remote'])
  })

  it('空 → 空 payload', () => {
    expect(buildMcpImportPayload([])).toEqual({ payload: { mcpServers: {} }, skipped: [] })
  })
})
