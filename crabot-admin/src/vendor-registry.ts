/**
 * 供应商目录（PresetVendor）registry。
 *
 * 内置目录 = BUILTIN_PRESET_VENDORS（preset-vendors.ts，代码内真相）。
 * system mode 下 root 可经 /etc/crabot/defaults/vendor.yaml 下发 override，
 * 经 init/sync 落到 DATA_DIR/admin/vendor.yaml；admin 启动时加载并按 mode 合并。
 *
 * 校验手写（不引 zod，贴合 admin 既有 yaml 加载风格）：坏条目跳过 + warn，
 * 缺失/解析失败回退纯内置，绝不 crash。
 */
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { ApiFormat, ModelInfo, PresetVendor } from './types.js'
import { BUILTIN_PRESET_VENDORS as BUILTIN } from './preset-vendors.js'

export interface VendorOverride {
  mode: 'merge' | 'replace'
  vendors: PresetVendor[]
}

// 四种协议格式都可在 vendor.yaml 自定义（含 openai-responses——它是 OpenAI 新一代
// Responses API，用普通 endpoint(/v1)+apikey 即可，如 https://api.openai.com/v1）。
const VALID_FORMATS: readonly ApiFormat[] = ['openai', 'anthropic', 'gemini', 'openai-responses']

/**
 * 受保护的内置 vendor：固定流程、不可被 vendor.yaml 覆盖或在 replace 模式下隐藏。
 * 判据是 auth_type='oauth'（如 ChatGPT 订阅）——它走专门的设备码 OAuth onboarding，
 * endpoint 固定、无法用普通 vendor 条目表达，一旦被 override 干掉会破坏订阅入口。
 * 注意：openai-responses **格式本身**是可配的（apikey 模式），受保护的只是 oauth 的那些。
 */
function isProtectedVendor(v: PresetVendor): boolean {
  return v.auth_type === 'oauth'
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function validateModelInfo(raw: unknown): ModelInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (!isNonEmptyString(m.model_id)) return null
  if (!isNonEmptyString(m.display_name)) return null
  if (m.type !== 'llm') return null
  const info: ModelInfo = { model_id: m.model_id, display_name: m.display_name, type: 'llm' }
  if (typeof m.supports_vision === 'boolean') info.supports_vision = m.supports_vision
  if (typeof m.context_window === 'number') info.context_window = m.context_window
  if (typeof m.max_tokens === 'number') info.max_tokens = m.max_tokens
  if (isNonEmptyString(m.description)) info.description = m.description
  if (Array.isArray(m.tags)) {
    const tags = m.tags.filter((t): t is string => typeof t === 'string')
    if (tags.length > 0) info.tags = tags
  }
  return info
}

/** 校验单条 vendor；非法返回 null。 */
export function validatePresetVendor(raw: unknown): PresetVendor | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (!isNonEmptyString(v.id)) return null
  if (!isNonEmptyString(v.name)) return null
  if (!isNonEmptyString(v.endpoint)) return null
  if (typeof v.format !== 'string' || !VALID_FORMATS.includes(v.format as ApiFormat)) return null
  // auth_type=oauth（ChatGPT 订阅那种设备码流程）无法用普通 vendor 条目表达，拒绝自定义。
  if (v.auth_type === 'oauth') {
    console.warn(`[vendor-registry] 跳过 vendor "${isNonEmptyString(v.id) ? v.id : '?'}"：auth_type=oauth 是内置固定 OAuth 流程，不支持自定义（自定义 vendor 只支持 apikey）`)
    return null
  }

  const vendor: PresetVendor = {
    id: v.id,
    name: v.name,
    format: v.format as ApiFormat,
    endpoint: v.endpoint,
  }
  if (isNonEmptyString(v.models_api)) vendor.models_api = v.models_api
  if (isNonEmptyString(v.docs_url)) vendor.docs_url = v.docs_url
  if (isNonEmptyString(v.api_key_help_url)) vendor.api_key_help_url = v.api_key_help_url
  if (typeof v.allows_custom_endpoint === 'boolean') vendor.allows_custom_endpoint = v.allows_custom_endpoint
  if (typeof v.recommended === 'boolean') vendor.recommended = v.recommended
  if (v.auth_type === 'apikey') vendor.auth_type = v.auth_type  // oauth 已在上面被拒
  if (Array.isArray(v.vision_id_prefixes)) {
    const prefixes = v.vision_id_prefixes.filter((p): p is string => typeof p === 'string')
    if (prefixes.length > 0) vendor.vision_id_prefixes = prefixes
  }
  if (Array.isArray(v.default_models)) {
    const models = v.default_models
      .map(validateModelInfo)
      .filter((m): m is ModelInfo => m !== null)
    if (models.length > 0) vendor.default_models = models
  }
  return vendor
}

/** 内置 + override 合出最终目录。 */
export function resolvePresetVendors(
  builtin: readonly PresetVendor[],
  override: VendorOverride | null,
): PresetVendor[] {
  if (!override) return [...builtin]

  // 受保护的内置固定流程 vendor（ChatGPT 订阅）：override 不得覆盖其 id，也不得在
  // replace 模式下隐藏它。先把这些 id 从 override 里剔除，确保任何模式下都拦不掉。
  const protectedIds = new Set(builtin.filter(isProtectedVendor).map(v => v.id))
  const safeOverride = override.vendors.filter(v => !protectedIds.has(v.id))

  if (override.mode === 'replace') {
    // replace 完全接管普通 vendor，但受保护的内置固定流程始终保留（排在最前）
    const protectedBuiltins = builtin.filter(isProtectedVendor)
    return [...protectedBuiltins, ...safeOverride]
  }
  // merge：同 id 覆盖（保持内置原位次），新 id 追加尾部；受保护项不在 safeOverride 中，
  // 故 builtin.map 必然保留其内置定义。
  const overrideById = new Map(safeOverride.map(v => [v.id, v]))
  const merged = builtin.map(v => overrideById.get(v.id) ?? v)
  const builtinIds = new Set(builtin.map(v => v.id))
  const added = safeOverride.filter(v => !builtinIds.has(v.id))
  return [...merged, ...added]
}

/** 从 dataDir/vendor.yaml 加载 override；缺失/空/坏 → null。 */
export async function loadVendorOverride(dataDir: string): Promise<VendorOverride | null> {
  const file = path.join(dataDir, 'vendor.yaml')
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return null // 文件不存在 = 正常（user mode / 未配置）
  }
  if (!raw.trim()) return null
  let doc: unknown
  try {
    doc = yaml.load(raw)
  } catch (e) {
    console.warn(`[vendor-registry] vendor.yaml 解析失败，忽略：${(e as Error).message}`)
    return null
  }
  if (!doc || typeof doc !== 'object') return null
  const d = doc as Record<string, unknown>
  const mode: 'merge' | 'replace' = d.mode === 'replace' ? 'replace' : 'merge'
  const rawVendors = Array.isArray(d.vendors) ? d.vendors : []
  const vendors = rawVendors
    .map(validatePresetVendor)
    .filter((v): v is PresetVendor => {
      if (v === null) console.warn('[vendor-registry] 跳过非法 vendor 条目')
      return v !== null
    })
  return { mode, vendors }
}

// ---- 模块级缓存：admin 启动时 init 一次 ----
let resolved: PresetVendor[] = [...BUILTIN]

// system mode 探测信号与 scripts/lib/mode.mjs 的 detectMode 对齐（/etc/crabot/cluster.version）。
const SYSTEM_CLUSTER_VERSION = '/etc/crabot/cluster.version'
const SYSTEM_DEFAULTS_DIR = '/etc/crabot/defaults'

/**
 * admin 启动调用：加载 override 并解析出最终目录。
 *
 * vendor 目录完全以 root 为准、不走 sync：
 *  - system mode（存在 /etc/crabot/cluster.version）→ 直读 root 下发的 /etc/crabot/defaults/vendor.yaml；
 *  - user mode → 读本地 <DATA_DIR>/admin/vendor.yaml（crabot vendor add 直接写这里）。
 * root 改动在该员工 admin 下次启动时生效（不做热重载）。
 */
export async function initVendorRegistry(dataDir: string): Promise<void> {
  const sourceDir = existsSync(SYSTEM_CLUSTER_VERSION) ? SYSTEM_DEFAULTS_DIR : dataDir
  const override = await loadVendorOverride(sourceDir)
  resolved = resolvePresetVendors(BUILTIN, override)
  if (override) {
    console.log(`[vendor-registry] 已加载 vendor.yaml（来源=${sourceDir}，mode=${override.mode}，${override.vendors.length} 条），最终 ${resolved.length} 个供应商`)
  }
}

/** 当前生效的供应商目录。 */
export function getPresetVendors(): PresetVendor[] {
  return resolved
}

/** 按 id 查供应商（基于解析后的目录）。 */
export function findPresetVendor(vendorId: string): PresetVendor | undefined {
  return resolved.find(v => v.id === vendorId)
}
