/**
 * 分析 OpenClaw `models.providers`，逐个判定可迁性。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.1
 * 判定优先级：oauth > secret-ref > unsupported-format > 可迁。
 */
import type { ApiFormat } from '../types.js'
import type { OpenClawModelApi, OpenClawModelsConfig, OpenClawSecretInput } from './openclaw-config.js'

export type ProviderSkipReason = 'oauth' | 'secret-ref' | 'unsupported-format'

export type AnalyzedProvider = {
  /** OpenClaw 配置里的 provider key */
  source_name: string
  /** OpenClaw baseUrl → crabot endpoint */
  endpoint: string
  /** 映射后的 crabot format；不支持的 api 为 null */
  format: ApiFormat | null
  /** 明文 API key；SecretRef / OAuth 时为 null */
  api_key: string | null
  migratable: boolean
  skip_reason?: ProviderSkipReason
}

/** OpenClaw 模型 api → crabot ApiFormat；不支持的返回 null。 */
function mapApiToFormat(api: OpenClawModelApi | undefined): ApiFormat | null {
  switch (api) {
    case 'openai-completions':
    case 'ollama':
      return 'openai'
    case 'openai-responses':
      return 'openai-responses'
    case 'anthropic-messages':
      return 'anthropic'
    case 'google-generative-ai':
      return 'gemini'
    default:
      // bedrock-converse-stream / github-copilot / azure-openai-responses
      // / openai-codex-responses / undefined → crabot 无对应 format
      return null
  }
}

function isSecretRef(apiKey: OpenClawSecretInput | undefined): boolean {
  return typeof apiKey === 'object' && apiKey !== null
}

export function analyzeProviders(models: OpenClawModelsConfig | undefined): AnalyzedProvider[] {
  const providers = models?.providers
  if (!providers) return []

  return Object.entries(providers).map(([source_name, cfg]) => {
    const endpoint = cfg.baseUrl
    const format = mapApiToFormat(cfg.api)

    if (cfg.auth === 'oauth') {
      return { source_name, endpoint, format, api_key: null, migratable: false, skip_reason: 'oauth' }
    }
    if (isSecretRef(cfg.apiKey)) {
      return { source_name, endpoint, format, api_key: null, migratable: false, skip_reason: 'secret-ref' }
    }
    if (format === null) {
      return { source_name, endpoint, format: null, api_key: null, migratable: false, skip_reason: 'unsupported-format' }
    }

    return {
      source_name,
      endpoint,
      format,
      api_key: typeof cfg.apiKey === 'string' ? cfg.apiKey : null,
      migratable: true,
    }
  })
}
