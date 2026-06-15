/**
 * 从归档提取某个 prefix 子树到目标目录（剥掉 prefix，保留相对结构）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.5 / §5.3 / §5.4
 * 用 tar.x 的 strip + filter 流式提取，扛得住大体量 workspace。
 */
import fs from 'node:fs/promises'
import * as tar from 'tar'

/** 返回提取的文件数。 */
export async function extractArchiveSubtree(
  archivePath: string,
  archivePrefix: string,
  destDir: string,
): Promise<number> {
  const prefix = archivePrefix.replace(/\/+$/, '')
  const strip = prefix.split('/').length
  await fs.mkdir(destDir, { recursive: true })

  let count = 0
  await tar.x({
    file: archivePath,
    cwd: destDir,
    strip,
    filter: (entryPath, entry) => {
      const match = entryPath === prefix || entryPath.startsWith(`${prefix}/`)
      if (match && 'type' in entry && entry.type === 'File') count += 1
      return match
    },
  })
  return count
}
