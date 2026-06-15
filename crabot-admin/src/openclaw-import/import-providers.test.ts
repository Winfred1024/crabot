/**
 * provider 导入编排测试：冲突跳过 + 调 createProvider（注入 fake dep）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.1 / §8（冲突以 crabot 为准、跳过）
 */
import { describe, it, expect, vi } from 'vitest'
import { importProviders } from './import-providers.js'
import type { OpenClawModelsConfig } from './openclaw-config.js'
import type { CreateModelProviderParams } from '../types.js'

const models: OpenClawModelsConfig = {
  providers: {
    openai: { baseUrl: 'https://api.openai.com', apiKey: 'sk-x', api: 'openai-completions', models: [] },
    oauthp: { baseUrl: 'u', auth: 'oauth', api: 'anthropic-messages' },
  },
}

function makeDeps(existing: string[] = []) {
  const created: CreateModelProviderParams[] = []
  return {
    created,
    deps: {
      existingProviderNames: new Set(existing),
      createProvider: vi.fn(async (p: CreateModelProviderParams) => {
        created.push(p)
      }),
    },
  }
}

describe('importProviders', () => {
  it('选中的可迁 provider 无冲突 → 调 createProvider，结果 imported', async () => {
    const { created, deps } = makeDeps()

    const results = await importProviders(models, ['openai'], deps)

    expect(deps.createProvider).toHaveBeenCalledTimes(1)
    expect(created[0]).toMatchObject({ name: 'openai', format: 'openai', api_key: 'sk-x' })
    expect(results).toEqual([{ kind: 'provider', name: 'openai', status: 'imported' }])
  })

  it('crabot 已存在同名 → 跳过，reason=conflict，不调 createProvider', async () => {
    const { deps } = makeDeps(['openai'])

    const results = await importProviders(models, ['openai'], deps)

    expect(deps.createProvider).not.toHaveBeenCalled()
    expect(results).toEqual([{ kind: 'provider', name: 'openai', status: 'skipped', reason: 'conflict' }])
  })

  it('选中但不可迁（OAuth）→ 跳过，reason=not-migratable', async () => {
    const { deps } = makeDeps()

    const results = await importProviders(models, ['oauthp'], deps)

    expect(deps.createProvider).not.toHaveBeenCalled()
    expect(results).toEqual([{ kind: 'provider', name: 'oauthp', status: 'skipped', reason: 'not-migratable' }])
  })

  it('未选中的 provider → 不处理（不在结果里）', async () => {
    const { deps } = makeDeps()

    const results = await importProviders(models, [], deps)

    expect(results).toEqual([])
  })
})
