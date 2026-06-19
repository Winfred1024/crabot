/**
 * 导出编排：写 manifest → gather → pack → 清理 staging。
 * 设计依据：2026-06-19-crabot-backup-migration-design.md §4 / §7
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildManifest } from './manifest.js'
import { gatherCategories, type GatherDeps } from './gather.js'
import { packArchive } from './pack.js'
import type { BackupSelection } from './types.js'

export async function exportArchive(params: {
  selection: BackupSelection
  outPath: string
  stagingRoot: string
  runtimeVersion: string
  createdAt: string
  deps: GatherDeps
}): Promise<void> {
  const { selection, outPath, stagingRoot, runtimeVersion, createdAt, deps } = params
  await fs.mkdir(stagingRoot, { recursive: true })
  try {
    const manifest = buildManifest({
      categories: selection.categories,
      includeSecrets: selection.includeSecrets,
      runtimeVersion,
      createdAt,
    })
    await fs.writeFile(path.join(stagingRoot, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await gatherCategories({ staging: stagingRoot, selection, deps })
    await packArchive({ staging: stagingRoot, outPath })
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true })
  }
}
