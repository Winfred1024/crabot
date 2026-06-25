export type UpgradeCapability = 'release' | 'source' | 'system'

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
  source_blockers?: string[]
  last_checked: string | null
  checking: boolean
  error?: string | null
  last_upgrade?: UpgradeStatus | null
}
