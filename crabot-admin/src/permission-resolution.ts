/**
 * Permission resolution helpers
 *
 * 用于把 friend 侧 ResolvedPermissions 与 session 侧 ResolvedPermissions 按字段并集合并：
 *   - tool_access: 按 OR
 *   - cli_access: 按 rank 取大（none < read < write）
 *   - storage: access 取更宽松（readwrite > read），workspace_path 暂用 friend 侧（a 优先）
 *   - memory_scopes: 取并集去重
 *
 * 设计意图：让 hook 层用统一一份 ResolvedPermissions 判断 cli_access / tool_access，
 * 不再在 agent 侧分私聊/群聊两条解析路径。
 */

import type { ResolvedPermissions, ToolAccessConfig, CliAccessConfig, CliPerm, StoragePermission } from './types.js'
import { TOOL_CATEGORIES, CLI_DOMAINS } from './types.js'

export function unionCliPerm(a: CliPerm, b: CliPerm): CliPerm {
  const rank = { none: 0, read: 1, write: 2 } as const
  return rank[a] >= rank[b] ? a : b
}

export function unionStorage(
  a: StoragePermission | null,
  b: StoragePermission | null,
): StoragePermission | null {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  // 取更宽松的 access；workspace_path 简化保留 friend 侧（a）的；TODO: 后续按需支持 path 合并
  const access: 'read' | 'readwrite' = (a.access === 'readwrite' || b.access === 'readwrite') ? 'readwrite' : 'read'
  return { workspace_path: a.workspace_path, access }
}

export function unionResolved(
  a: ResolvedPermissions | null,
  b: ResolvedPermissions | null,
): ResolvedPermissions | null {
  if (!a && !b) return null
  if (!a) return b
  if (!b) return a

  const tool_access = {} as ToolAccessConfig
  for (const k of TOOL_CATEGORIES) {
    tool_access[k] = a.tool_access[k] || b.tool_access[k]
  }

  const cli_access = {} as CliAccessConfig
  for (const d of CLI_DOMAINS) {
    cli_access[d] = unionCliPerm(a.cli_access[d], b.cli_access[d])
  }

  const storage = unionStorage(a.storage, b.storage)
  const memory_scopes = Array.from(new Set([...a.memory_scopes, ...b.memory_scopes]))

  return { tool_access, cli_access, storage, memory_scopes }
}
