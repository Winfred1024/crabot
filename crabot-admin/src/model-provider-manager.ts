/**
 * 模型供应商管理器
 *
 * 负责模型供应商的配置、验证、存储和分发
 * Agent/Memory 直连 Provider，不经过中间代理
 */

import fs from 'fs/promises'
import path from 'path'
import { generateId, generateTimestamp } from 'crabot-shared'
import type {
  ModelProvider,
  ModelInfo,
  PresetVendor,
  GlobalModelConfig,
  ModuleModelConfig,
  LLMConnectionInfo,
  CreateModelProviderParams,
  UpdateModelProviderParams,
  ImportFromVendorParams,
  ImportFromVendorResult,
  ResolveModelConfigParams,
  OAuthCredential,
  ModelType,
  ProxyConfig,
} from './types.js'
import { findPresetVendor } from './preset-vendors.js'

/**
 * Codex `/models` 响应里只有 `visibility === 'list'` 的 SKU 会出现在 UI；
 * `hide` 用于内部模型（如 codex-auto-review），不应暴露给用户。
 */
function parseCodexModels(raw: unknown[]): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const entry of raw) {
    const item = entry as Record<string, unknown>
    const slug = typeof item.slug === 'string' ? item.slug : ''
    if (!slug) continue
    if (item.visibility !== 'list') continue
    if (item.supported_in_api === false) continue

    const modalities = Array.isArray(item.input_modalities) ? (item.input_modalities as unknown[]) : []
    const supportsVision = modalities.includes('image')

    models.push({
      model_id: slug,
      display_name: (typeof item.display_name === 'string' && item.display_name) || slug,
      type: 'llm',
      supports_vision: supportsVision,
      context_window: typeof item.context_window === 'number' ? item.context_window : undefined,
    })
  }
  return models
}

/**
 * OpenAI 兼容 `/models` 响应解析：{data: [{id, ...}]}
 */
function parseOpenAIModels(raw: unknown[]): ModelInfo[] {
  const models: ModelInfo[] = []
  for (const entry of raw) {
    const item = entry as Record<string, unknown>
    const modelId =
      (typeof item.id === 'string' && item.id) ||
      (typeof item.model === 'string' && item.model) ||
      (typeof item.slug === 'string' && item.slug) ||
      ''
    if (!modelId) continue

    // v3 起 admin 只识别 LLM 模型；embedding 类型已被移除（memory 模块不再需要）。
    // 列出来的 embedding 模型直接跳过，不再注入到 provider.models。
    if (modelId.includes('embedding') || modelId.includes('embed')) continue

    const type: ModelType = 'llm'

    const capabilities = item.capabilities as { vision?: boolean } | undefined
    const modalities = Array.isArray(item.input) ? (item.input as unknown[]) : []
    const supportsVision = capabilities?.vision === true || modalities.includes('image')

    models.push({
      model_id: modelId,
      display_name:
        (typeof item.display_name === 'string' && item.display_name) ||
        (typeof item.name === 'string' && item.name) ||
        modelId,
      type,
      supports_vision: supportsVision,
      context_window:
        (typeof item.context_window === 'number' ? item.context_window : undefined) ??
        (typeof item.context_length === 'number' ? item.context_length : undefined) ??
        (typeof item.context_tokens === 'number' ? item.context_tokens : undefined),
    })
  }
  return models
}

export class ModelProviderManager {
  private providers: Map<string, ModelProvider> = new Map()
  private globalConfig: GlobalModelConfig = {}
  private moduleConfigs: Map<string, ModuleModelConfig> = new Map()
  private agentConfigRefsProvider: ((providerId: string) => string[]) | null = null

  private readonly dataDir: string
  private readonly providersFilePath: string
  private readonly globalConfigFilePath: string
  private readonly moduleConfigsDir: string
  private refreshInFlight: Map<string, Promise<import('./oauth/openai-codex-oauth.js').OAuthLoginResult>> = new Map()

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.providersFilePath = path.join(dataDir, 'model_providers.json')
    this.globalConfigFilePath = path.join(dataDir, 'global_model_config.json')
    this.moduleConfigsDir = path.join(dataDir, 'module_model_configs')
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.mkdir(this.moduleConfigsDir, { recursive: true })
    await this.loadData()
  }

  // ============================================================================
  // Provider CRUD
  // ============================================================================

  async createProvider(params: CreateModelProviderParams): Promise<ModelProvider> {
    const now = generateTimestamp()
    const provider: ModelProvider = {
      id: generateId(),
      name: params.name,
      type: params.type,
      format: params.format,
      endpoint: params.endpoint,
      api_key: params.api_key,
      preset_vendor: params.preset_vendor,
      ...(params.auth_type && { auth_type: params.auth_type }),
      models: params.models,
      status: 'active',
      created_at: now,
      updated_at: now,
    }

    this.providers.set(provider.id, provider)
    await this.saveProviders()

    console.log(`[ModelProviderManager] Created provider ${provider.id} (${provider.name})`)
    return provider
  }

  getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id)
  }

  listProviders(): ModelProvider[] {
    return Array.from(this.providers.values())
  }

  async updateProvider(id: string, params: UpdateModelProviderParams): Promise<ModelProvider> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    // 更新本地数据
    if (params.name !== undefined) provider.name = params.name
    if (params.endpoint !== undefined) provider.endpoint = params.endpoint
    if (params.api_key !== undefined) provider.api_key = params.api_key
    if (params.models !== undefined) provider.models = params.models
    if (params.status !== undefined) provider.status = params.status

    provider.updated_at = generateTimestamp()

    this.providers.set(id, provider)
    await this.saveProviders()

    console.log(`[ModelProviderManager] Updated provider ${id}`)
    return provider
  }

  async deleteProvider(id: string): Promise<void> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    this.providers.delete(id)
    await this.saveProviders()

    console.log(`[ModelProviderManager] Deleted provider ${id}`)
  }

  // ============================================================================
  // Provider references
  // ============================================================================

  setAgentConfigRefsProvider(fn: (providerId: string) => string[]): void {
    this.agentConfigRefsProvider = fn
  }

  // ============================================================================
  // OAuth Credential Management
  // ============================================================================

  async setOAuthCredential(providerId: string, credential: OAuthCredential): Promise<void> {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Provider not found: ${providerId}`)

    const updated = {
      ...provider,
      auth_type: 'oauth' as const,
      oauth_credential: credential,
      updated_at: generateTimestamp(),
    }
    this.providers.set(providerId, updated)
    await this.saveProviders()
  }

  async clearOAuthCredential(providerId: string): Promise<void> {
    const provider = this.providers.get(providerId)
    if (!provider) throw new Error(`Provider not found: ${providerId}`)

    const updated = {
      ...provider,
      oauth_credential: undefined,
      api_key: '',
      updated_at: generateTimestamp(),
    }
    this.providers.set(providerId, updated)
    await this.saveProviders()
  }

  getOAuthCredential(providerId: string): OAuthCredential | undefined {
    return this.providers.get(providerId)?.oauth_credential
  }

  // ============================================================================
  // Validation
  // ============================================================================

  async testProviderModel(id: string, modelId?: string): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }

    if (modelId) {
      const model = provider.models.find(m => m.model_id === modelId)
      if (!model) {
        throw new Error(`Model "${modelId}" not found in provider "${provider.name}"`)
      }
      return this.measureFirstByteLatency(provider, model.model_id)
    }

    return this.measureEndpointLatency(provider)
  }

  /**
   * base_url 测速。成功/失败都落到 provider.status —— 列表端点不通 = 整个 provider 不可用，
   * 这个判断对所有模型一致，可作为列表卡片的状态信号。
   */
  private async measureEndpointLatency(provider: ModelProvider): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    const authToken = await this.resolveAuthToken(provider)
    if (typeof authToken !== 'string') {
      return authToken
    }

    let url: string
    let headers: Record<string, string>
    try {
      const built = await this.buildEndpointProbe(provider, authToken)
      url = built.url
      headers = built.headers
    } catch (error) {
      return { success: false, latency_ms: 0, error: error instanceof Error ? error.message : String(error) }
    }

    const startTime = Date.now()
    try {
      const response = await fetch(url, { method: 'GET', headers })
      const latency_ms = Date.now() - startTime

      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        const errMsg = `HTTP ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`
        provider.status = 'error'
        provider.validation_error = errMsg
        await this.saveProviders()
        return { success: false, latency_ms, error: errMsg }
      }

      provider.status = 'active'
      provider.last_validated_at = generateTimestamp()
      provider.validation_error = undefined
      await this.saveProviders()
      return { success: true, latency_ms }
    } catch (error) {
      const latency_ms = Date.now() - startTime
      const errMsg = error instanceof Error ? error.message : String(error)
      provider.status = 'error'
      provider.validation_error = errMsg
      await this.saveProviders()
      return { success: false, latency_ms, error: errMsg }
    }
  }

  /**
   * 首字测速（TTFT）。不写 provider.status —— 单个模型 4xx 不应该把整个 provider
   * 标红（可能只是模型 ID 错或被下线）。是否影响 provider 可用性由 base_url 测速决定。
   */
  private async measureFirstByteLatency(
    provider: ModelProvider,
    modelId: string
  ): Promise<{ success: boolean; latency_ms: number; error?: string }> {
    const authToken = await this.resolveAuthToken(provider)
    if (typeof authToken !== 'string') {
      return authToken
    }

    let url: string
    let headers: Record<string, string>
    let body: string
    if (provider.format === 'openai') {
      url = `${provider.endpoint}/chat/completions`
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }
      body = JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: true,
      })
    } else if (provider.format === 'anthropic') {
      url = `${provider.endpoint}/v1/messages`
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': authToken,
        'anthropic-version': '2023-06-01',
      }
      body = JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: true,
      })
    } else if (provider.format === 'gemini') {
      url = `${provider.endpoint}/models/${modelId}:streamGenerateContent?alt=sse&key=${authToken}`
      headers = { 'Content-Type': 'application/json' }
      body = JSON.stringify({
        contents: [{ parts: [{ text: 'hi' }] }],
      })
    } else if (provider.format === 'openai-responses') {
      // Codex 后端（chatgpt.com/backend-api）协议契约：必填 reasoning + include + ChatGPT-Account-Id
      const isCodexBackend = provider.endpoint.includes('chatgpt.com/backend-api')
      url = `${provider.endpoint}/responses`
      headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }
      if (isCodexBackend && provider.oauth_credential?.account_id) {
        headers['ChatGPT-Account-Id'] = provider.oauth_credential.account_id
      }
      const requestBody: Record<string, unknown> = {
        model: modelId,
        instructions: '',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        stream: true,
      }
      if (isCodexBackend) {
        requestBody.reasoning = { effort: 'medium', summary: 'auto' }
        requestBody.include = ['reasoning.encrypted_content']
      }
      body = JSON.stringify(requestBody)
    } else {
      return { success: false, latency_ms: 0, error: `Unsupported format: ${provider.format}` }
    }

    const ac = new AbortController()
    const startTime = Date.now()
    try {
      const response = await fetch(url, { method: 'POST', headers, body, signal: ac.signal })
      if (!response.ok) {
        const errBody = await response.text().catch(() => '')
        return {
          success: false,
          latency_ms: Date.now() - startTime,
          error: `HTTP ${response.status}${errBody ? `: ${errBody.slice(0, 200)}` : ''}`,
        }
      }
      if (!response.body) {
        return { success: false, latency_ms: Date.now() - startTime, error: 'No response body' }
      }

      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          return {
            success: false,
            latency_ms: Date.now() - startTime,
            error: 'Stream ended without any data',
          }
        }
        if (value && value.length > 0) {
          const ttft = Date.now() - startTime
          ac.abort()
          return { success: true, latency_ms: ttft }
        }
      }
    } catch (error) {
      return {
        success: false,
        latency_ms: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * 测速前置鉴权检查。OAuth 未登录时直接短路（让用户去登录），
   * 否则交给 ensureFreshAuthToken（不会抛，刷新失败会 fallback 到旧 token）。
   */
  private async resolveAuthToken(
    provider: ModelProvider
  ): Promise<string | { success: false; latency_ms: 0; error: string }> {
    if (provider.auth_type === 'oauth' && !provider.oauth_credential) {
      return { success: false, latency_ms: 0, error: 'OAuth 未登录，请先完成 ChatGPT 登录' }
    }
    return this.ensureFreshAuthToken(provider)
  }

  /**
   * 距离过期不足 60s 时触发 OAuth 刷新（in-flight 去重）。
   * 刷新失败 fallback 到旧 token，让上游 401 自然暴露问题，避免测速链路把磁盘故障吞成"鉴权失败"。
   */
  private async ensureFreshAuthToken(provider: ModelProvider): Promise<string> {
    if (provider.auth_type !== 'oauth' || !provider.oauth_credential) {
      return provider.api_key
    }

    const credential = provider.oauth_credential
    if (Date.now() <= credential.expires_at - 60_000) {
      return credential.access_token
    }

    try {
      let refreshPromise = this.refreshInFlight.get(provider.id)
      if (!refreshPromise) {
        refreshPromise = (async () => {
          const { refreshOAuthToken } = await import('./oauth/openai-codex-oauth.js')
          return refreshOAuthToken(credential.refresh_token)
        })()
        this.refreshInFlight.set(provider.id, refreshPromise)
        refreshPromise.finally(() => this.refreshInFlight.delete(provider.id))
      }
      const refreshed = await refreshPromise
      await this.setOAuthCredential(provider.id, {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: refreshed.expires_at,
        account_id: refreshed.account_id,
        email: refreshed.email,
      })
      return refreshed.access_token
    } catch (err) {
      console.error(`[ModelProviderManager] OAuth token refresh failed for ${provider.id}:`, err)
      return credential.access_token
    }
  }

  private async buildEndpointProbe(
    provider: ModelProvider,
    authToken: string
  ): Promise<{ url: string; headers: Record<string, string> }> {
    if (provider.format === 'openai') {
      return {
        url: `${provider.endpoint}/models`,
        headers: { Authorization: `Bearer ${authToken}` },
      }
    }
    if (provider.format === 'openai-responses') {
      const { resolveCodexClientVersion } = await import('./oauth/codex-client-version.js')
      const clientVersion = await resolveCodexClientVersion()
      return {
        url: `${provider.endpoint}/models?client_version=${encodeURIComponent(clientVersion)}`,
        headers: { Authorization: `Bearer ${authToken}` },
      }
    }
    if (provider.format === 'anthropic') {
      return {
        url: `${provider.endpoint}/v1/models`,
        headers: { 'x-api-key': authToken, 'anthropic-version': '2023-06-01' },
      }
    }
    if (provider.format === 'gemini') {
      return {
        url: `${provider.endpoint}/models?key=${authToken}`,
        headers: {},
      }
    }
    throw new Error(`Unsupported format: ${provider.format}`)
  }

  async refreshModels(id: string): Promise<{ models: ModelInfo[]; added: string[]; removed: string[] }> {
    const provider = this.providers.get(id)
    if (!provider) {
      throw new Error('Provider not found')
    }
    if (provider.type !== 'preset' || !provider.preset_vendor) {
      throw new Error('Only preset providers support model refresh')
    }

    const vendor = findPresetVendor(provider.preset_vendor)
    if (!vendor) {
      throw new Error(`Unknown vendor: ${provider.preset_vendor}`)
    }

    const authToken = await this.ensureFreshAuthToken(provider)

    const freshModels = await this.fetchVendorModels(
      { ...vendor, endpoint: provider.endpoint },
      authToken
    )

    const oldIds = new Set(provider.models.map(m => m.model_id))
    const newIds = new Set(freshModels.map(m => m.model_id))

    const added = freshModels.filter(m => !oldIds.has(m.model_id)).map(m => m.model_id)
    const removed = provider.models.filter(m => !newIds.has(m.model_id)).map(m => m.model_id)

    const mergedModels = freshModels

    provider.models = mergedModels
    provider.updated_at = generateTimestamp()
    this.providers.set(id, provider)
    await this.saveProviders()

    return { models: mergedModels, added, removed }
  }

  getProviderReferences(id: string): { references: string[] } {
    const refs: string[] = []

    if (this.globalConfig.default_llm_provider_id === id) {
      refs.push('全局默认 LLM 模型')
    }

    for (const [moduleId, config] of this.moduleConfigs.entries()) {
      if (config.llm_provider_id === id) {
        refs.push(`模块 "${moduleId}" 的 LLM 配置`)
      }
    }

    if (this.agentConfigRefsProvider) {
      refs.push(...this.agentConfigRefsProvider(id))
    }

    return { references: refs }
  }

  // ============================================================================
  // Vendor Import
  // ============================================================================

  async importFromVendor(params: ImportFromVendorParams): Promise<ImportFromVendorResult> {
    const vendor = findPresetVendor(params.vendor_id)
    if (!vendor) {
      throw new Error(`Unknown vendor: ${params.vendor_id}`)
    }

    // 允许用户覆盖 endpoint（用于非本地部署，如远程 Ollama）
    const endpoint = params.endpoint?.trim() || vendor.endpoint

    // 获取模型列表
    const models = await this.fetchVendorModels({ ...vendor, endpoint }, params.api_key)

    // 创建 provider
    const provider = await this.createProvider({
      name: vendor.name,
      type: 'preset',
      format: vendor.format,
      endpoint,
      api_key: params.api_key,
      preset_vendor: vendor.id,
      auth_type: vendor.auth_type,
      models,
    })

    return { provider, models }
  }

  private async fetchVendorModels(vendor: PresetVendor, apiKey: string): Promise<ModelInfo[]> {
    if (!vendor.models_api) {
      return vendor.default_models ? [...vendor.default_models] : []
    }

    // 无凭证时用静态列表兜底（OAuth provider 首次导入前没有 token）
    if (!apiKey) {
      return vendor.default_models ? [...vendor.default_models] : []
    }

    try {
      const url = await this.buildVendorModelsUrl(vendor)
      const response = await this.httpRequest(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      })

      const data = JSON.parse(response)

      // Codex 订阅后端：{models: [{slug, visibility, input_modalities, ...}]}
      // OpenAI 标准：{data: [{id, ...}]}
      const models = vendor.format === 'openai-responses' && Array.isArray(data.models)
        ? parseCodexModels(data.models as unknown[])
        : parseOpenAIModels(Array.isArray(data.data) ? (data.data as unknown[]) : [])

      // 拉不到任何模型时，退回默认列表，避免清空导致用户无法选择
      if (models.length === 0 && vendor.default_models) {
        return [...vendor.default_models]
      }

      return models
    } catch (error) {
      console.error(`Failed to fetch models from ${vendor.name}:`, error)
      return vendor.default_models ? [...vendor.default_models] : []
    }
  }

  /**
   * 为需要 `/models` 的厂商构造带 query 的 URL。
   * 目前仅 Codex 订阅需要 `client_version` 参数，其它厂商走原样 endpoint。
   */
  private async buildVendorModelsUrl(vendor: PresetVendor): Promise<string> {
    const base = `${vendor.endpoint}${vendor.models_api}`
    if (vendor.format !== 'openai-responses') {
      return base
    }
    const { resolveCodexClientVersion } = await import('./oauth/codex-client-version.js')
    const clientVersion = await resolveCodexClientVersion()
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}client_version=${encodeURIComponent(clientVersion)}`
  }

  // ============================================================================
  // Config Resolution
  // ============================================================================

  async resolveModelConfig(params: ResolveModelConfigParams): Promise<LLMConnectionInfo> {
    // v3: role 仅 'llm'。embedding 路径已移除。
    // 1. 查找模块专属配置
    const moduleConfig = this.moduleConfigs.get(params.module_id)
    if (moduleConfig) {
      const providerId = moduleConfig.llm_provider_id
      const modelId = moduleConfig.llm_model_id

      if (providerId && modelId) {
        return this.buildConnectionInfo(providerId, modelId)
      }
    }

    // 2. 使用全局默认配置
    const providerId = this.globalConfig.default_llm_provider_id
    const modelId = this.globalConfig.default_llm_model_id

    if (!providerId || !modelId) {
      throw new Error(`No ${params.role} configuration found for module ${params.module_id}`)
    }

    return this.buildConnectionInfo(providerId, modelId)
  }

  async buildConnectionInfo(providerId: string, modelId: string): Promise<LLMConnectionInfo> {
    const provider = this.providers.get(providerId)
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`)
    }

    const model = provider.models.find((m) => m.model_id === modelId)
    if (!model) {
      throw new Error(`Model not found: ${modelId} in provider ${providerId}`)
    }

    const apikey = await this.ensureFreshAuthToken(provider)

    // 直连 Provider：返回 provider 原始连接信息
    // endpoint 存储完整 base URL（含版本前缀，如 OpenAI 的 /v1、智谱的 /api/paas/v4、
    // DeepSeek 则无版本前缀），adapter 只在其后拼具体 path（如 /chat/completions）
    const base = {
      endpoint: provider.endpoint,
      apikey,
      model_id: model.model_id,
      format: provider.format,
      provider_id: providerId,
      ...(provider.oauth_credential?.account_id
        ? { account_id: provider.oauth_credential.account_id }
        : {}),
    }

    return {
      ...base,
      ...(model.max_tokens !== undefined && { max_tokens: model.max_tokens }),
      ...(model.supports_vision && { supports_vision: true }),
    } as LLMConnectionInfo
  }

  // ============================================================================
  // Global Config
  // ============================================================================

  getGlobalConfig(): GlobalModelConfig {
    return { ...this.globalConfig }
  }

  /**
   * 获取代理配置
   */
  getProxyConfig(): ProxyConfig {
    return this.globalConfig.proxy ?? { mode: 'system' }
  }

  /**
   * 更新代理配置
   */
  async updateProxyConfig(proxy: ProxyConfig): Promise<void> {
    this.globalConfig = { ...this.globalConfig, proxy }
    await this.saveGlobalConfig()
  }

  async updateGlobalConfig(config: Partial<GlobalModelConfig>): Promise<GlobalModelConfig> {
    this.globalConfig = { ...this.globalConfig, ...config }
    await this.saveGlobalConfig()
    return this.globalConfig
  }

  // ============================================================================
  // Module Config
  // ============================================================================

  getModuleConfig(moduleId: string): ModuleModelConfig | undefined {
    return this.moduleConfigs.get(moduleId)
  }

  listModuleConfigs(): ModuleModelConfig[] {
    return Array.from(this.moduleConfigs.values())
  }

  async updateModuleConfig(
    moduleId: string,
    config: Partial<Omit<ModuleModelConfig, 'module_id'>>
  ): Promise<ModuleModelConfig> {
    const existing = this.moduleConfigs.get(moduleId) || { module_id: moduleId }
    const updated = { ...existing, ...config }
    this.moduleConfigs.set(moduleId, updated)
    await this.saveModuleConfig(moduleId)
    return updated
  }

  async deleteModuleConfig(moduleId: string): Promise<void> {
    this.moduleConfigs.delete(moduleId)
    const filePath = path.join(this.moduleConfigsDir, `${moduleId}.json`)
    try {
      await fs.unlink(filePath)
    } catch {
      // Ignore if file doesn't exist
    }
  }

  // ============================================================================
  // Persistence
  // ============================================================================

  private async loadData(): Promise<void> {
    // Load providers
    try {
      const data = await fs.readFile(this.providersFilePath, 'utf-8')
      const providers = JSON.parse(data) as ModelProvider[]
      for (const provider of providers) {
        this.providers.set(provider.id, provider)
      }
      console.log(`[ModelProviderManager] Loaded ${this.providers.size} providers`)
    } catch {
      console.log('[ModelProviderManager] No existing providers data')
    }

    // Load global config（只取已知字段，防止历史脏数据污染内存和后续写入）
    try {
      const data = await fs.readFile(this.globalConfigFilePath, 'utf-8')
      const raw = JSON.parse(data)
      // v3 起 default_embedding_* 字段已移除，老 raw 数据里如有这些字段直接忽略。
      this.globalConfig = {
        default_llm_provider_id: raw.default_llm_provider_id,
        default_llm_model_id: raw.default_llm_model_id,
        proxy: raw.proxy,
      }
      console.log('[ModelProviderManager] Loaded global config')
    } catch {
      console.log('[ModelProviderManager] No existing global config')
    }

    // Load module configs
    try {
      const files = await fs.readdir(this.moduleConfigsDir)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const filePath = path.join(this.moduleConfigsDir, file)
        const data = await fs.readFile(filePath, 'utf-8')
        const config = JSON.parse(data) as ModuleModelConfig
        this.moduleConfigs.set(config.module_id, config)
      }
      console.log(`[ModelProviderManager] Loaded ${this.moduleConfigs.size} module configs`)
    } catch {
      console.log('[ModelProviderManager] No existing module configs')
    }
  }

  // ============================================================================
  // 原子写入
  // ============================================================================

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  private async saveProviders(): Promise<void> {
    const providers = Array.from(this.providers.values())
    await this.atomicWriteFile(this.providersFilePath, JSON.stringify(providers, null, 2))
  }

  private async saveGlobalConfig(): Promise<void> {
    await this.atomicWriteFile(this.globalConfigFilePath, JSON.stringify(this.globalConfig, null, 2))
  }

  private async saveModuleConfig(moduleId: string): Promise<void> {
    const config = this.moduleConfigs.get(moduleId)
    if (!config) return

    const filePath = path.join(this.moduleConfigsDir, `${moduleId}.json`)
    await this.atomicWriteFile(filePath, JSON.stringify(config, null, 2))
  }

  // ============================================================================
  // HTTP Helper
  // ============================================================================

  private async httpRequest(
    url: string,
    options: {
      method: string
      headers?: Record<string, string>
      body?: string
    }
  ): Promise<string> {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
    })

    const data = await response.text()

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${data}`)
    }

    return data
  }
}