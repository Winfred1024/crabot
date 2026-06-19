/**
 * 导出端：从 JSON 数组类别里只保留用户自建记录（丢内置）。
 * 内置标记字段随类别不同：schedules/subagents/skills/mcp 用 is_builtin，templates 用 is_system。
 * 设计依据：2026-06-19-crabot-backup-import-design.md §3
 */

export type BuiltinFlagField = 'is_builtin' | 'is_system'

export type FilterResult<T> = { kept: T[]; keptIds: Set<string> }

export function filterUserRecords<T extends Record<string, unknown>>(
  rows: T[],
  flagField: BuiltinFlagField,
): FilterResult<T> {
  if (!Array.isArray(rows)) return { kept: [], keptIds: new Set() }
  const kept = rows.filter((r) => r[flagField] !== true)
  const keptIds = new Set<string>()
  for (const r of kept) {
    if (typeof r.id === 'string') keptIds.add(r.id)
  }
  return { kept, keptIds }
}
