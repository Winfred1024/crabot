/**
 * 解析 OpenClaw SecretInput：明文返回值，引用类（SecretRef）返回 undefined。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.1
 * 备份只存引用本身（{source:'env'|'file'|'exec',...}），明文不在包里 → 视为不可迁。
 */
import type { OpenClawSecretInput } from './openclaw-config.js'

export function resolveSecret(input: OpenClawSecretInput | undefined): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
