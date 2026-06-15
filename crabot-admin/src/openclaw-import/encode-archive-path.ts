/**
 * 把绝对源路径编码成归档内 payload 路径。
 *
 * 移植自 OpenClaw `src/commands/backup-shared.ts` 的
 * encodeAbsolutePathForBackupArchive / buildBackupArchivePath，须与之一字不差，
 * 否则按 manifest.paths 反查文件会落空。
 */
import path from 'node:path'

export function encodeAbsolutePathForBackupArchive(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, '/')
  const windowsMatch = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (windowsMatch) {
    const drive = windowsMatch[1]?.toUpperCase() ?? 'UNKNOWN'
    const rest = windowsMatch[2] ?? ''
    return path.posix.join('windows', drive, rest)
  }
  if (normalized.startsWith('/')) {
    return path.posix.join('posix', normalized.slice(1))
  }
  return path.posix.join('relative', normalized)
}

export function buildArchivePayloadPath(archiveRoot: string, sourcePath: string): string {
  return path.posix.join(archiveRoot, 'payload', encodeAbsolutePathForBackupArchive(sourcePath))
}
