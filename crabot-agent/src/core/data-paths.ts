import path from 'node:path'
import { homedir } from 'node:os'

export function getAgentDataDir(): string {
  return path.resolve(process.env.DATA_DIR ?? './data')
}

export function getAgentTraceDir(): string {
  return path.join(getAgentDataDir(), 'traces')
}

export function getAdminDataDir(): string {
  return path.resolve(getAgentDataDir(), '..', 'admin')
}

export function getAdminInternalTokenPath(): string {
  return path.join(getAdminDataDir(), 'internal-token')
}

export function getInstanceSkillsDir(): string {
  return path.join(getAgentDataDir(), 'instance', 'skills')
}

export function getBgEntitiesDir(): string {
  return path.join(getAgentDataDir(), 'bg-entities')
}

export function getBgEntitiesLogsDir(): string {
  return path.join(getBgEntitiesDir(), 'logs')
}

export function getBgEntitiesRegistryPath(): string {
  return path.join(getBgEntitiesDir(), 'registry.json')
}

export function getWorkspaceDir(): string {
  if (process.env.WORKSPACE_DIR) {
    return path.resolve(process.env.WORKSPACE_DIR)
  }
  // fallback：MM 启动时已设 WORKSPACE_DIR；走到这里说明独立跑 agent / 测试，
  // 默认 homedir() 与 MM 默认一致（agent 看到用户真实文件，不是 Crabot 内脏）
  return homedir()
}
