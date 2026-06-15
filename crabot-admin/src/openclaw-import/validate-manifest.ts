/**
 * 校验 OpenClaw backup 的 manifest.json。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §4
 * 只认 schemaVersion===1；缺 options 时 includeWorkspace 保守按 false（触发记忆/workspace 灰显）。
 */

export type ManifestValidation =
  | {
      ok: true
      schemaVersion: 1
      includeWorkspace: boolean
      onlyConfig: boolean
      createdAt: string
      runtimeVersion: string
    }
  | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function validateManifest(raw: unknown): ManifestValidation {
  if (!isRecord(raw)) {
    return { ok: false, error: '无效的 manifest：不是对象' }
  }
  if (raw.schemaVersion !== 1) {
    return {
      ok: false,
      error: `不支持的备份版本（schemaVersion=${String(raw.schemaVersion)}），仅支持 schemaVersion=1`,
    }
  }

  const options = isRecord(raw.options) ? raw.options : undefined
  return {
    ok: true,
    schemaVersion: 1,
    includeWorkspace: options?.includeWorkspace === true,
    onlyConfig: options?.onlyConfig === true,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    runtimeVersion: typeof raw.runtimeVersion === 'string' ? raw.runtimeVersion : '',
  }
}
