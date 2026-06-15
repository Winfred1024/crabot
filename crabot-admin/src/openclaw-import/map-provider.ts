/**
 * 把可迁的 OpenClaw provider 映射成 crabot createProvider 入参。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.1
 * 复用 analyzeProviders 的判定，避免与可迁性逻辑重复。
 */
import type { CreateModelProviderParams, ModelInfo } from '../types.js'
import { analyzeProviders } from './analyze-providers.js'
import type { OpenClawModelProviderConfig } from './openclaw-config.js'

/** 不可迁（OAuth / SecretRef / 不支持的 api）返回 null。 */
export function mapMigratableProvider(
  sourceName: string,
  cfg: OpenClawModelProviderConfig,
): CreateModelProviderParams | null {
  const [analyzed] = analyzeProviders({ providers: { [sourceName]: cfg } })
  if (!analyzed?.migratable || analyzed.format === null || analyzed.api_key === null) {
    return null
  }

  const models: ModelInfo[] = (cfg.models ?? []).map((m) => ({
    model_id: m.id,
    display_name: m.name,
    type: 'llm',
  }))

  return {
    name: sourceName,
    type: 'manual',
    format: analyzed.format,
    endpoint: analyzed.endpoint,
    api_key: analyzed.api_key,
    models,
  }
}
