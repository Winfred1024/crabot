/**
 * Crabot 原生备份归档的类型。
 * 设计依据：2026-06-19-crabot-backup-migration-design.md §4 / §5
 */

export const BACKUP_CATEGORIES = ['config', 'channels', 'skills', 'memory', 'tasks'] as const
export type BackupCategory = (typeof BACKUP_CATEGORIES)[number]

/** 一次导出的选择：含哪些类别 + 是否含密钥。 */
export type BackupSelection = {
  categories: BackupCategory[]
  includeSecrets: boolean
}

/** 归档根的 manifest.json。 */
export type BackupManifest = {
  schemaVersion: 1
  product: 'crabot'
  runtimeVersion: string
  createdAt: string
  includeSecrets: boolean
  categories: BackupCategory[]
}
