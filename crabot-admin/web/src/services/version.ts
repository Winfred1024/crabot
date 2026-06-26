import { api } from './api'

export type UpgradeCapability = 'release' | 'source' | 'system'
export type DeployMode = 'user' | 'system'
export type InstallKind = 'source' | 'release'

export interface UpgradeStatus {
  phase: 'upgrading' | 'restarting' | 'done' | 'failed'
  started_at: string
  finished_at?: string
  from_version?: string
  to_version?: string
  error?: string
}

export interface VersionState {
  current_version: string | null
  latest_version: string | null
  upgrade_available: boolean
  upgrade_capability: UpgradeCapability
  deploy_mode: DeployMode
  install_kind: InstallKind
  source_blockers?: string[]
  last_checked: string | null
  checking: boolean
  error?: string | null
  last_upgrade?: UpgradeStatus | null
}

export const versionService = {
  get(): Promise<VersionState> {
    return api.get<VersionState>('/system/version')
  },
  check(): Promise<VersionState> {
    return api.post<VersionState>('/system/version/check', {})
  },
  startUpgrade(): Promise<{ status: 'started' }> {
    return api.post<{ status: 'started' }>('/system/upgrade', {})
  },
}
