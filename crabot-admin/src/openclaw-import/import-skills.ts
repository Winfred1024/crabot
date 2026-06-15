/**
 * skill 导入编排：整目录从归档 extract → importFromLocalPath，冲突跳过。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.5 / §7 / §8
 * skill 是目录（SKILL.md + 配套），整目录搬；crabot 已有同名 → 跳过（以 crabot 为准）。
 */
import path from 'node:path'
import { extractArchiveSubtree } from './extract-subtree.js'
import type { ImportItemResult } from './import-types.js'

export type SkillImportDeps = {
  existingSkillNames: Set<string>
  importSkillDir: (dirPath: string) => Promise<void>
}

export async function importSkills(params: {
  archivePath: string
  skillsArchivePrefix: string
  skillNames: string[]
  tempDir: string
  deps: SkillImportDeps
}): Promise<ImportItemResult[]> {
  const { archivePath, skillsArchivePrefix, skillNames, tempDir, deps } = params
  const results: ImportItemResult[] = []

  for (const name of skillNames) {
    if (deps.existingSkillNames.has(name)) {
      results.push({ kind: 'skill', name, status: 'skipped', reason: 'conflict' })
      continue
    }

    const dest = path.join(tempDir, name)
    await extractArchiveSubtree(archivePath, `${skillsArchivePrefix}/${name}`, dest)
    await deps.importSkillDir(dest)
    results.push({ kind: 'skill', name, status: 'imported' })
  }

  return results
}
