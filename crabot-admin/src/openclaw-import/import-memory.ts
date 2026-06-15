/**
 * memory 导入编排：OpenClaw 记忆 markdown → Memory v2 write_long_term。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.3
 * OpenClaw 记忆是 markdown，Memory v2 是结构化 entry（fact/lesson/concept）——语义错配。
 * 务实选择：每个非空记忆文件 → 一条 type=fact 的 entry，content=原文。空白文件跳过。
 */
import { readArchiveTextFile } from './archive-reader.js'
import type { ImportItemResult } from './import-types.js'

export type MemoryImportDeps = {
  writeLongTerm: (params: { type: string; content: string }) => Promise<void>
}

export async function importMemory(params: {
  archivePath: string
  memoryFiles: Array<{ name: string; entryPath: string }>
  deps: MemoryImportDeps
}): Promise<ImportItemResult[]> {
  const { archivePath, memoryFiles, deps } = params
  const results: ImportItemResult[] = []

  for (const file of memoryFiles) {
    const content = (await readArchiveTextFile(archivePath, file.entryPath))?.trim()
    if (!content) continue // 空白文件跳过

    await deps.writeLongTerm({ type: 'fact', content })
    results.push({ kind: 'memory', name: file.name, status: 'imported' })
  }

  return results
}
