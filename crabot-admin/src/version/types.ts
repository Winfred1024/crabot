export type UpgradeCapability = 'release' | 'source' | 'system'
/** 部署模式：个人（user）/ 团队（system，/etc/crabot/cluster.version 存在） */
export type DeployMode = 'user' | 'system'
/** 安装方式：源码（有 .git）/ release（预构建产物） */
export type InstallKind = 'source' | 'release'

export interface UpgradeStatus {
  phase: 'preparing' | 'upgrading' | 'restarting' | 'done' | 'failed'
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
