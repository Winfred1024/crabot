/**
 * MCP 导入编排：冲突过滤后复用 crabot mcp-skill-manager.importFromJson。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.6 / §8
 * http MCP（importFromJson 不支持）→ not-migratable；同名 → conflict。
 */
import type { OpenClawMcpConfig } from './openclaw-config.js'
import { analyzeMcpServers } from './analyze-mcp.js'
import { buildMcpImportPayload } from './build-mcp-import.js'
import type { ImportItemResult } from './import-types.js'

export type McpImportDeps = {
  existingMcpNames: Set<string>
  importMcpJson: (json: string) => Promise<void>
}

export async function importMcpServers(
  mcp: OpenClawMcpConfig | undefined,
  selectedNames: string[],
  deps: McpImportDeps,
): Promise<ImportItemResult[]> {
  const selected = new Set(selectedNames)
  const servers = analyzeMcpServers(mcp).filter((s) => selected.has(s.source_name))
  const { payload, skipped } = buildMcpImportPayload(servers)

  const results: ImportItemResult[] = []
  // http 类（无 command）无法走 importFromJson
  for (const name of skipped) {
    results.push({ kind: 'mcp', name, status: 'skipped', reason: 'not-migratable' })
  }

  const toImport: Record<string, (typeof payload.mcpServers)[string]> = {}
  for (const [name, entry] of Object.entries(payload.mcpServers)) {
    if (deps.existingMcpNames.has(name)) {
      results.push({ kind: 'mcp', name, status: 'skipped', reason: 'conflict' })
      continue
    }
    toImport[name] = entry
    results.push({ kind: 'mcp', name, status: 'imported' })
  }

  if (Object.keys(toImport).length > 0) {
    await deps.importMcpJson(JSON.stringify({ mcpServers: toImport }))
  }

  return results
}
