import path from 'node:path'

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
  // fallback：agent DATA_DIR 是 {root}/data/agent，上两级得到 workspace 根目录
  return path.dirname(path.dirname(path.resolve(process.env.DATA_DIR ?? './data')))
}
