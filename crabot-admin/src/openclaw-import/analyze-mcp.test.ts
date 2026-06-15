/**
 * OpenClaw MCP server 迁移分析测试。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.6
 */
import { describe, it, expect } from 'vitest'
import { analyzeMcpServers } from './analyze-mcp.js'
import type { OpenClawMcpConfig } from './openclaw-config.js'

describe('analyzeMcpServers', () => {
  it('stdio（有 command）→ transport=stdio，拷 command/args，标 requires_local_env', () => {
    const mcp: OpenClawMcpConfig = {
      servers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } },
    }

    const result = analyzeMcpServers(mcp)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      source_name: 'fs',
      name: 'fs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-fs'],
      migratable: true,
      requires_local_env: true,
    })
  })

  it('http（有 url + transport）→ 拷 transport/url/headers，不标 requires_local_env', () => {
    const mcp: OpenClawMcpConfig = {
      servers: { remote: { url: 'https://mcp.example.com', transport: 'streamable-http', headers: { Authorization: 'Bearer x' } } },
    }

    const result = analyzeMcpServers(mcp)

    expect(result[0]).toMatchObject({
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer x' },
    })
    expect(result[0].requires_local_env).toBeUndefined()
  })

  it('env 的 number/boolean 值统一 stringify 成 string', () => {
    const mcp: OpenClawMcpConfig = {
      servers: { s: { command: 'run', env: { PORT: 8080, DEBUG: true, NAME: 'x' } } },
    }

    expect(analyzeMcpServers(mcp)[0].env).toEqual({ PORT: '8080', DEBUG: 'true', NAME: 'x' })
  })

  it('crabot 无对应字段（cwd/workingDirectory/connectionTimeoutMs）被丢弃', () => {
    const mcp: OpenClawMcpConfig = {
      servers: { s: { command: 'run', cwd: '/tmp', workingDirectory: '/tmp', connectionTimeoutMs: 5000 } },
    }

    const out = analyzeMcpServers(mcp)[0] as Record<string, unknown>
    expect(out.cwd).toBeUndefined()
    expect(out.workingDirectory).toBeUndefined()
    expect(out.connectionTimeoutMs).toBeUndefined()
  })

  it('空/缺失 → 空数组', () => {
    expect(analyzeMcpServers(undefined)).toEqual([])
    expect(analyzeMcpServers({})).toEqual([])
    expect(analyzeMcpServers({ servers: {} })).toEqual([])
  })
})
