/**
 * 把分析出的 MCP server 转成 crabot importFromJson 能吃的 Claude Desktop 格式。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.6
 * importFromJson 仅支持 stdio（有 command）；http 类（url）无法走该路径，列入 skipped。
 */
import type { AnalyzedMcpServer } from './analyze-mcp.js'

type McpServerEntry = { command: string; args?: string[]; env?: Record<string, string> }

export type McpImportPayload = {
  payload: { mcpServers: Record<string, McpServerEntry> }
  /** 无法迁移的 http MCP server 名（importFromJson 不支持） */
  skipped: string[]
}

export function buildMcpImportPayload(servers: AnalyzedMcpServer[]): McpImportPayload {
  const mcpServers: Record<string, McpServerEntry> = {}
  const skipped: string[] = []

  for (const server of servers) {
    if (server.transport === 'stdio' && server.command) {
      mcpServers[server.name] = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
      }
    } else {
      skipped.push(server.name)
    }
  }

  return { payload: { mcpServers }, skipped }
}
