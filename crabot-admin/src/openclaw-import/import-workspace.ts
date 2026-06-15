/**
 * workspace 导入编排：把 OpenClaw workspace 文件提取到目标目录。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.4
 * 提取到 crabot workspace 下的独立子目录（如 openclaw-workspace/），避免 clobber 现有文件。
 */
import { extractArchiveSubtree } from './extract-subtree.js'
import type { ImportItemResult } from './import-types.js'

export async function importWorkspace(params: {
  archivePath: string
  workspaceArchivePrefix: string
  destDir: string
}): Promise<ImportItemResult[]> {
  const count = await extractArchiveSubtree(params.archivePath, params.workspaceArchivePrefix, params.destDir)
  if (count === 0) return []
  return [{ kind: 'workspace', name: 'workspace', status: 'imported' }]
}
