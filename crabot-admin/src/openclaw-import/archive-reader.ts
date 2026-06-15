/**
 * 读取 OpenClaw backup 的 tar.gz 归档。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §4
 * 只列条目 + 按需读单个小文件（manifest.json / openclaw.json），
 * 不为概览全解压；大体量 payload（workspace）的落盘留给 Phase 2 执行期。
 */
import * as tar from 'tar'

/** 列出归档内全部条目路径（不落盘）。 */
export async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = []
  await tar.t({
    file: archivePath,
    onentry: (entry) => {
      entries.push(entry.path)
      entry.resume()
    },
  })
  return entries
}

/** 读出指定条目的 UTF-8 文本内容；条目不存在返回 null。 */
export async function readArchiveTextFile(archivePath: string, entryPath: string): Promise<string | null> {
  let found: string | null = null
  await tar.t({
    file: archivePath,
    onentry: (entry) => {
      if (entry.path !== entryPath) {
        entry.resume()
        return
      }
      const chunks: Buffer[] = []
      entry.on('data', (chunk: Buffer) => chunks.push(chunk))
      entry.on('end', () => {
        found = Buffer.concat(chunks).toString('utf8')
      })
    },
  })
  return found
}
