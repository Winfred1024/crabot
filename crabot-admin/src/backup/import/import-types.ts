/**
 * Crabot 备份导入的类型。
 * 设计依据：2026-06-19-crabot-backup-import-design.md §2 / §6
 */
import type { BackupCategory } from '../types.js'

export type OnConflict = 'skip' | 'overwrite'

export type ImportStatus = 'imported' | 'skipped' | 'overwritten' | 'failed'

export type ImportItemResult = {
  kind: BackupCategory | string
  id: string
  status: ImportStatus
  reason?: string
}

export type CrabotImportSummary = {
  results: ImportItemResult[]
  errors: string[]
}
