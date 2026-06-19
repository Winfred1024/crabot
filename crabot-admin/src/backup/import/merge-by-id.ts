/**
 * 按 id 把归档记录合并进现有 Map（不可变：返回新 Map，不改入参）。
 * skip = 已有 id 保留原值；overwrite = 已有 id 用归档值替换；新 id 总是加入。
 * 设计依据：2026-06-19-crabot-backup-import-design.md §4.1
 */
import type { ImportItemResult, OnConflict } from './import-types.js'

export function mergeById<T extends { id?: string }>(
  existing: Map<string, T>,
  incoming: T[],
  onConflict: OnConflict,
  kind: string,
): { merged: Map<string, T>; results: ImportItemResult[] } {
  const merged = new Map(existing)
  const results: ImportItemResult[] = []
  for (const record of incoming) {
    const id = record.id
    if (typeof id !== 'string' || id.length === 0) {
      results.push({ kind, id: '', status: 'failed', reason: 'missing-id' })
      continue
    }
    if (!merged.has(id)) {
      merged.set(id, record)
      results.push({ kind, id, status: 'imported' })
    } else if (onConflict === 'overwrite') {
      merged.set(id, record)
      results.push({ kind, id, status: 'overwritten' })
    } else {
      results.push({ kind, id, status: 'skipped', reason: 'conflict' })
    }
  }
  return { merged, results }
}
