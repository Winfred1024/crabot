/**
 * provider 导入编排：对选中的 provider 做冲突检测 + 创建。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.1 / §8
 * 冲突以 crabot 为准、跳过；不可迁（OAuth/SecretRef/不支持）跳过。
 */
import type { CreateModelProviderParams } from '../types.js'
import type { OpenClawModelsConfig } from './openclaw-config.js'
import { mapMigratableProvider } from './map-provider.js'
import type { ImportItemResult } from './import-types.js'

export type ProviderImportDeps = {
  existingProviderNames: Set<string>
  createProvider: (params: CreateModelProviderParams) => Promise<void>
}

export async function importProviders(
  models: OpenClawModelsConfig | undefined,
  selectedNames: string[],
  deps: ProviderImportDeps,
): Promise<ImportItemResult[]> {
  const providers = models?.providers ?? {}
  const selected = new Set(selectedNames)
  const results: ImportItemResult[] = []

  for (const [name, cfg] of Object.entries(providers)) {
    if (!selected.has(name)) continue

    if (deps.existingProviderNames.has(name)) {
      results.push({ kind: 'provider', name, status: 'skipped', reason: 'conflict' })
      continue
    }

    const params = mapMigratableProvider(name, cfg)
    if (!params) {
      results.push({ kind: 'provider', name, status: 'skipped', reason: 'not-migratable' })
      continue
    }

    await deps.createProvider(params)
    results.push({ kind: 'provider', name, status: 'imported' })
  }

  return results
}
