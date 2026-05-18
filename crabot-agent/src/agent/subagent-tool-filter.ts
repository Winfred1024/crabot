/**
 * SubAgent 工具过滤器
 *
 * 把父 worker 全工具集按 BuiltinCapabilities + MCP/Skill 白名单
 * 过滤为 subagent 实际可见的工具子集。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-17-subagent-customization-and-admin-ui-design.md §3.2
 */

import type { ToolDefinition } from '../engine/types.js'
import type { BuiltinCapabilities } from '../types.js'

export type ToolGroup =
  | 'file_system'
  | 'shell'
  | 'task_intel'
  | 'crab_memory'
  | 'crab_messaging'
  | 'skill_loading'
  | 'mcp_user'
  | 'delegate_task'
  | 'unknown'

const FILE_SYSTEM_NAMES: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep'])
const SHELL_NAMES: ReadonlySet<string> = new Set(['Bash', 'Output', 'Kill', 'ListEntities'])
const TASK_INTEL_NAMES: ReadonlySet<string> = new Set(['search_traces', 'get_task_details', 'search_short_term'])

const MCP_PREFIX = 'mcp__'

/**
 * 把工具名分类到能力组。
 * - 内置工具按 name 匹配
 * - MCP 工具按 prefix 'mcp__<server>__' 提取 server 后映射
 *   - crab-memory / crab-messaging 是 agent 内置 MCP，单独分类
 *   - 其他 server 归 mcp_user
 * - Skill / delegate_task 单独分类
 * - 未知工具归 'unknown'，filter 时一律剔除
 */
export function classifyTool(name: string): ToolGroup {
  if (name === 'Skill') return 'skill_loading'
  if (name === 'delegate_task') return 'delegate_task'
  if (FILE_SYSTEM_NAMES.has(name)) return 'file_system'
  if (SHELL_NAMES.has(name)) return 'shell'
  if (TASK_INTEL_NAMES.has(name)) return 'task_intel'

  if (name.startsWith(MCP_PREFIX)) {
    const serverId = extractMcpServerId(name)
    if (serverId === 'crab-memory') return 'crab_memory'
    if (serverId === 'crab-messaging') return 'crab_messaging'
    return 'mcp_user'
  }
  return 'unknown'
}

/** 从 'mcp__<server>__<tool>' 提取 server 名 */
export function extractMcpServerId(toolName: string): string {
  if (!toolName.startsWith(MCP_PREFIX)) return ''
  const rest = toolName.slice(MCP_PREFIX.length)
  const sepIdx = rest.indexOf('__')
  return sepIdx === -1 ? rest : rest.slice(0, sepIdx)
}

/**
 * 过滤父工具集为 subagent 可见的子集。
 *
 * - 内置能力组：按 BuiltinCapabilities flag 开关
 * - 用户 MCP：按 allowedMcpServerIds 白名单过滤（空 = 全禁）
 * - Skill 加载：与 allowedSkillIds 联动（空 = Skill 工具不注入）
 * - delegate_task：永远剔除（subagent 不能再委派下一层）
 * - unknown：永远剔除
 */
export function filterToolsForSubAgent(
  parentTools: ReadonlyArray<ToolDefinition>,
  capabilities: BuiltinCapabilities,
  allowedMcpServerIds: string[],
  allowedSkillIds: string[],
): ToolDefinition[] {
  return parentTools.filter((tool) => {
    const group = classifyTool(tool.name)
    switch (group) {
      case 'file_system': return capabilities.file_system
      case 'shell': return capabilities.shell
      case 'task_intel': return capabilities.task_intel
      case 'crab_memory': return capabilities.crab_memory
      case 'crab_messaging': return capabilities.crab_messaging
      case 'skill_loading': return allowedSkillIds.length > 0
      case 'mcp_user': return allowedMcpServerIds.includes(extractMcpServerId(tool.name))
      case 'delegate_task': return false
      case 'unknown': return false
    }
  })
}
