/**
 * OpenClaw 备份配置的最小输入类型。
 *
 * 只声明导入器实际读取的字段，不照搬 OpenClaw 全量 schema。
 * 字段名与 OpenClaw 源码 `src/config/types.*.ts` 保持一致，便于对照。
 */

/** OpenClaw 密钥可以是明文，也可以是对 env/file/exec 的引用（明文不在备份里）。 */
export type OpenClawSecretRef = {
  source: 'env' | 'file' | 'exec'
  provider: string
  id: string
}

export type OpenClawSecretInput = string | OpenClawSecretRef

/** OpenClaw 模型 API（`src/config/types.models.ts` 的 MODEL_APIS）。 */
export type OpenClawModelApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'openai-codex-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'github-copilot'
  | 'bedrock-converse-stream'
  | 'ollama'
  | 'azure-openai-responses'

export type OpenClawModelDefinitionConfig = {
  id: string
  name: string
}

export type OpenClawModelProviderConfig = {
  baseUrl: string
  apiKey?: OpenClawSecretInput
  auth?: 'api-key' | 'aws-sdk' | 'oauth' | 'token'
  api?: OpenClawModelApi
  models?: OpenClawModelDefinitionConfig[]
}

export type OpenClawModelsConfig = {
  mode?: 'merge' | 'replace'
  providers?: Record<string, OpenClawModelProviderConfig>
}

/** OpenClaw `plugins.entries.<key>`：channel/插件的启用条目。 */
export type OpenClawPluginEntry = {
  enabled?: boolean
}

export type OpenClawPluginsConfig = {
  entries?: Record<string, OpenClawPluginEntry>
}

/** OpenClaw `mcp.servers.<name>`（`src/config/types.mcp.ts` 的 McpServerConfig）。 */
export type OpenClawMcpServerConfig = {
  command?: string
  args?: string[]
  env?: Record<string, string | number | boolean>
  cwd?: string
  workingDirectory?: string
  url?: string
  transport?: 'sse' | 'streamable-http'
  headers?: Record<string, string | number | boolean>
  connectionTimeoutMs?: number
}

export type OpenClawMcpConfig = {
  servers?: Record<string, OpenClawMcpServerConfig>
}

/**
 * OpenClaw `channels.<name>.accounts.<accountId>`（真实备份结构）。
 * 不同 channel 用不同字段：feishu/lark 用 appId/appSecret，telegram 用 botToken。
 * 各值都是 SecretInput（可能是 SecretRef 引用）。
 */
export type OpenClawChannelAccount = {
  appId?: OpenClawSecretInput
  appSecret?: OpenClawSecretInput
  botToken?: OpenClawSecretInput
}

export type OpenClawChannelConfig = {
  enabled?: boolean
  /** telegram 也可能把 botToken 放在 channel 顶层 */
  botToken?: OpenClawSecretInput
  accounts?: Record<string, OpenClawChannelAccount>
}

export type OpenClawChannelsConfig = Record<string, OpenClawChannelConfig>
