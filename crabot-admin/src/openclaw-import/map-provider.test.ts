/**
 * provider 映射测试：OpenClaw provider → crabot CreateModelProviderParams。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.1
 */
import { describe, it, expect } from 'vitest'
import { mapMigratableProvider } from './map-provider.js'
import type { OpenClawModelProviderConfig } from './openclaw-config.js'

describe('mapMigratableProvider', () => {
  it('可迁 provider → CreateModelProviderParams（type=manual，format/endpoint/api_key/models 映射）', () => {
    const cfg: OpenClawModelProviderConfig = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      api: 'openai-completions',
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    }

    const params = mapMigratableProvider('openai', cfg)

    expect(params).toEqual({
      name: 'openai',
      type: 'manual',
      format: 'openai',
      endpoint: 'https://api.openai.com/v1',
      api_key: 'sk-x',
      models: [{ model_id: 'gpt-4o', display_name: 'GPT-4o', type: 'llm' }],
    })
  })

  it('OAuth provider → null（不建壳）', () => {
    expect(mapMigratableProvider('x', { baseUrl: 'u', auth: 'oauth', api: 'anthropic-messages' })).toBeNull()
  })

  it('SecretRef 密钥 → null（明文不在备份）', () => {
    expect(
      mapMigratableProvider('x', { baseUrl: 'u', apiKey: { source: 'env', provider: 'd', id: 'K' }, api: 'openai-completions' }),
    ).toBeNull()
  })

  it('不支持的 api → null', () => {
    expect(mapMigratableProvider('x', { baseUrl: 'u', apiKey: 'k', api: 'bedrock-converse-stream' })).toBeNull()
  })

  it('无 models → models 为空数组', () => {
    const params = mapMigratableProvider('x', { baseUrl: 'u', apiKey: 'k', api: 'ollama' })

    expect(params?.models).toEqual([])
    expect(params?.format).toBe('openai')
  })
})
