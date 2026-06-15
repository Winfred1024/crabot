/**
 * OpenClaw provider 可迁性分析测试。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.1
 */
import { describe, it, expect } from 'vitest'
import { analyzeProviders } from './analyze-providers.js'
import type { OpenClawModelsConfig } from './openclaw-config.js'

describe('analyzeProviders', () => {
  it('明文 apiKey + 支持的 api → 可迁，format 映射，带上 api_key 值', () => {
    const models: OpenClawModelsConfig = {
      providers: {
        openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-literal', api: 'openai-completions' },
      },
    }

    const result = analyzeProviders(models)

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      source_name: 'openai',
      endpoint: 'https://api.openai.com/v1',
      format: 'openai',
      api_key: 'sk-literal',
      migratable: true,
    })
    expect(result[0].skip_reason).toBeUndefined()
  })

  it('apiKey 是 SecretRef（env/file/exec 引用）→ 不可迁，reason=secret-ref，不带明文', () => {
    const models: OpenClawModelsConfig = {
      providers: {
        openai: {
          baseUrl: 'https://api.openai.com/v1',
          apiKey: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' },
          api: 'openai-completions',
        },
      },
    }

    const result = analyzeProviders(models)

    expect(result[0].migratable).toBe(false)
    expect(result[0].skip_reason).toBe('secret-ref')
    expect(result[0].api_key).toBeNull()
  })

  it('auth=oauth → 不可迁，reason=oauth', () => {
    const models: OpenClawModelsConfig = {
      providers: {
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          auth: 'oauth',
          api: 'anthropic-messages',
        },
      },
    }

    const result = analyzeProviders(models)

    expect(result[0].migratable).toBe(false)
    expect(result[0].skip_reason).toBe('oauth')
  })

  it('不支持的 api（bedrock/copilot/azure/codex）→ 不可迁，reason=unsupported-format', () => {
    const models: OpenClawModelsConfig = {
      providers: {
        bedrock: { baseUrl: 'https://bedrock', apiKey: 'x', api: 'bedrock-converse-stream' },
      },
    }

    const result = analyzeProviders(models)

    expect(result[0].migratable).toBe(false)
    expect(result[0].skip_reason).toBe('unsupported-format')
    expect(result[0].format).toBeNull()
  })

  it('api→format 映射全表', () => {
    const models: OpenClawModelsConfig = {
      providers: {
        a: { baseUrl: 'x', apiKey: 'k', api: 'openai-completions' },
        b: { baseUrl: 'x', apiKey: 'k', api: 'openai-responses' },
        c: { baseUrl: 'x', apiKey: 'k', api: 'anthropic-messages' },
        d: { baseUrl: 'x', apiKey: 'k', api: 'google-generative-ai' },
        e: { baseUrl: 'x', apiKey: 'k', api: 'ollama' },
      },
    }

    const byName = Object.fromEntries(analyzeProviders(models).map((p) => [p.source_name, p.format]))

    expect(byName).toEqual({ a: 'openai', b: 'openai-responses', c: 'anthropic', d: 'gemini', e: 'openai' })
  })

  it('OAuth 优先于 SecretRef/unsupported 判定（最先拦截，避免误建壳）', () => {
    const models: OpenClawModelsConfig = {
      providers: {
        x: { baseUrl: 'x', auth: 'oauth', apiKey: { source: 'env', provider: 'd', id: 'K' }, api: 'bedrock-converse-stream' },
      },
    }

    expect(analyzeProviders(models)[0].skip_reason).toBe('oauth')
  })

  it('空/缺失 providers → 空数组', () => {
    expect(analyzeProviders(undefined)).toEqual([])
    expect(analyzeProviders({})).toEqual([])
    expect(analyzeProviders({ providers: {} })).toEqual([])
  })
})
