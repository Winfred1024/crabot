/**
 * 分析 OpenClaw `mcp.servers`，映射到 crabot MCP 形态。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.6
 * MCP 配置可移植，恒可迁；stdio 指向本地二进制时标 requires_local_env。
 */
import type { OpenClawMcpConfig, OpenClawMcpServerConfig } from './openclaw-config.js'

export type AnalyzedMcpServer = {
  /** OpenClaw servers 的 key */
  source_name: string
  name: string
  transport: 'stdio' | 'streamable-http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  migratable: true
  /** stdio command 依赖本机二进制，需用户自行确认环境 */
  requires_local_env?: boolean
}

/** 把 OpenClaw 的 `string | number | boolean` 值表统一 stringify。 */
function stringifyValues(
  input: Record<string, string | number | boolean> | undefined,
): Record<string, string> | undefined {
  if (!input) return undefined
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)]))
}

function mapServer(source_name: string, cfg: OpenClawMcpServerConfig): AnalyzedMcpServer {
  // 有 command → stdio；否则按声明的 http transport。
  if (cfg.command) {
    return {
      source_name,
      name: source_name,
      transport: 'stdio',
      command: cfg.command,
      ...(cfg.args ? { args: cfg.args } : {}),
      ...(stringifyValues(cfg.env) ? { env: stringifyValues(cfg.env) } : {}),
      migratable: true,
      requires_local_env: true,
    }
  }

  return {
    source_name,
    name: source_name,
    transport: cfg.transport ?? 'streamable-http',
    ...(cfg.url ? { url: cfg.url } : {}),
    ...(stringifyValues(cfg.headers) ? { headers: stringifyValues(cfg.headers) } : {}),
    migratable: true,
  }
}

export function analyzeMcpServers(mcp: OpenClawMcpConfig | undefined): AnalyzedMcpServer[] {
  const servers = mcp?.servers
  if (!servers) return []
  return Object.entries(servers).map(([name, cfg]) => mapServer(name, cfg))
}
