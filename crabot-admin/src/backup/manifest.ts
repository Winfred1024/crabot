/**
 * Crabot 备份 manifest 构建与校验。Plan 2 导入侧复用 validateBackupManifest。
 * 设计依据：2026-06-19-crabot-backup-migration-design.md §4 / §6.3
 */
import { isBackupCategory } from './categories.js'
import type { BackupCategory, BackupManifest } from './types.js'

export const CURRENT_BACKUP_SCHEMA_VERSION = 1

export function buildManifest(params: {
  categories: BackupCategory[]
  includeSecrets: boolean
  runtimeVersion: string
  createdAt: string
}): BackupManifest {
  return {
    schemaVersion: 1,
    product: 'crabot',
    runtimeVersion: params.runtimeVersion,
    createdAt: params.createdAt,
    includeSecrets: params.includeSecrets,
    categories: params.categories,
  }
}

export type ManifestValidation =
  | { ok: true; categories: BackupCategory[]; includeSecrets: boolean }
  | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function validateBackupManifest(raw: unknown): ManifestValidation {
  if (!isRecord(raw)) return { ok: false, error: '无效的 manifest：不是对象' }
  if (raw.product !== 'crabot') {
    return { ok: false, error: `不是 Crabot 备份（product=${String(raw.product)}）` }
  }
  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion > CURRENT_BACKUP_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `备份版本过新（schemaVersion=${String(raw.schemaVersion)}），当前最高支持 ${CURRENT_BACKUP_SCHEMA_VERSION}`,
    }
  }
  const categories = Array.isArray(raw.categories)
    ? raw.categories.filter((c): c is BackupCategory => typeof c === 'string' && isBackupCategory(c))
    : []
  return { ok: true, categories, includeSecrets: raw.includeSecrets === true }
}
