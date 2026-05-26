import { describe, it, expect, vi } from 'vitest'
import { AdminModule } from '../src/index.js'

// buildSubAgentConfigsForPush 是 AdminModule 的 private 方法。
// 用 Object.create 跳构造函数 + 注入 mock 依赖，验证以下行为：
//
// 1. mode='role' + 实例 model_config[role] 未配 + resolvedModelConfig 已含全局默认 →
//    使用全局默认（即 handleGetAgentConfig 应用过的 fallback='global_default'）。
// 2. mode='role' + 实例和全局都未配 → 跳过 + 打 warning，不抛错。
// 3. mode='specific' → 走 buildConnectionInfo，不看 resolvedModelConfig。

function buildAdmin(opts: {
  enabledEntries: Array<{
    id: string
    name: string
    provider_id: string | null
    model_id: string | null
    model_role: string | null
    role?: string
    description?: string
    when_to_use?: string
    workflow?: string
    deliverables?: string
    verification?: string
    builtin_capabilities?: string[]
    allowed_mcp_server_ids?: string[]
    allowed_skill_ids?: string[]
    max_turns?: number
    hook_preset?: string
  }>
  buildConnectionInfo?: (providerId: string, modelId: string) => Promise<unknown>
}): unknown {
  const admin = Object.create(AdminModule.prototype) as Record<string, unknown>
  admin.subAgentManager = {
    listEnabled: () =>
      opts.enabledEntries.map((e) => ({
        role: 'worker',
        description: '',
        when_to_use: '',
        workflow: '',
        deliverables: '',
        verification: '',
        builtin_capabilities: [],
        allowed_mcp_server_ids: [],
        allowed_skill_ids: [],
        max_turns: 30,
        hook_preset: 'default',
        ...e,
      })),
  }
  admin.modelProviderManager = {
    buildConnectionInfo:
      opts.buildConnectionInfo ??
      (async (providerId: string, modelId: string) => ({
        endpoint: `https://api.example.com/${providerId}`,
        apikey: 'sk-fake',
        model_id: modelId,
        format: 'openai',
        provider_id: providerId,
      })),
  }
  return admin
}

const GLOBAL_DEFAULT_LLM = {
  endpoint: 'https://global-default.example.com',
  apikey: 'sk-global',
  model_id: 'gpt-global',
  format: 'openai',
  provider_id: 'global-provider',
}

describe('buildSubAgentConfigsForPush — global_default fallback', () => {
  it('mode=role + 实例未配 + resolvedModelConfig 有全局默认 → 用全局默认', async () => {
    const admin = buildAdmin({
      enabledEntries: [
        {
          id: 'sub-1',
          name: 'code_planner',
          provider_id: null,
          model_id: null,
          model_role: 'powerful',
        },
      ],
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const instanceConfig = {
      instance_id: 'crabot-agent',
      model_config: {}, // 实例未配 powerful slot
    }
    // resolvedModelConfig 由 handleGetAgentConfig 应用 fallback 后产出
    const resolvedModelConfig = { powerful: GLOBAL_DEFAULT_LLM }

    const result = await (
      admin as {
        buildSubAgentConfigsForPush: (
          c: unknown,
          r: unknown,
        ) => Promise<Array<{ name: string; model: unknown }>>
      }
    ).buildSubAgentConfigsForPush(instanceConfig, resolvedModelConfig)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('code_planner')
    expect(result[0].model).toEqual(GLOBAL_DEFAULT_LLM)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('mode=role + 实例未配 + resolvedModelConfig 也无该 role → 跳过且打 warning', async () => {
    const admin = buildAdmin({
      enabledEntries: [
        {
          id: 'sub-1',
          name: 'goal_auditor',
          provider_id: null,
          model_id: null,
          model_role: 'powerful',
        },
      ],
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await (
      admin as {
        buildSubAgentConfigsForPush: (
          c: unknown,
          r: unknown,
        ) => Promise<unknown[]>
      }
    ).buildSubAgentConfigsForPush(
      { instance_id: 'crabot-agent', model_config: {} },
      {}, // 无全局默认
    )

    expect(result).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('goal_auditor'),
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('powerful'))
    warnSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('mode=specific → 走 buildConnectionInfo，不查 resolvedModelConfig', async () => {
    const buildConnSpy = vi.fn(async (providerId: string, modelId: string) => ({
      endpoint: `https://specific.example.com/${providerId}`,
      apikey: 'sk-specific',
      model_id: modelId,
      format: 'openai',
      provider_id: providerId,
    }))
    const admin = buildAdmin({
      enabledEntries: [
        {
          id: 'sub-1',
          name: 'specific_sub',
          provider_id: 'prov-x',
          model_id: 'model-y',
          model_role: null,
        },
      ],
      buildConnectionInfo: buildConnSpy,
    })

    const result = await (
      admin as {
        buildSubAgentConfigsForPush: (
          c: unknown,
          r: unknown,
        ) => Promise<Array<{ model: { provider_id: string; model_id: string } }>>
      }
    ).buildSubAgentConfigsForPush(
      { instance_id: 'crabot-agent', model_config: {} },
      { powerful: GLOBAL_DEFAULT_LLM }, // 即使有全局默认，specific 模式也不用
    )

    expect(buildConnSpy).toHaveBeenCalledWith('prov-x', 'model-y')
    expect(result).toHaveLength(1)
    expect(result[0].model.provider_id).toBe('prov-x')
    expect(result[0].model.model_id).toBe('model-y')
  })
})
