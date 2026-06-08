import type { PermissionTemplateManager } from './permission-template-manager.js'
import type { SessionPermissionConfig } from './types.js'

/**
 * 把单个 sessionConfig 升级成快照式（cli_access 必填）。
 * 已是全字段 → 原样返回（幂等）。
 *
 * 设计意图：与 resolvePermissions 快照式语义对齐，移除 cli_access 字段缺失时的模板兜底。
 */
export function snapshotSessionConfig(
  config: SessionPermissionConfig,
  mgr: PermissionTemplateManager,
): SessionPermissionConfig {
  if (config.cli_access) return config

  const templateId = config.template_id ?? 'group_default'
  const tpl = mgr.get(templateId) ?? mgr.get('group_default')
  if (!tpl) return config  // 不可达：group_default 系统模板始终存在

  return {
    ...config,
    cli_access: { ...tpl.cli_access },
  }
}
