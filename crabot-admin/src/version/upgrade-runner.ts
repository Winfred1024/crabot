import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UpgradeStatus, VersionState } from './types.js'

export function readUpgradeStatus(dataDir: string): UpgradeStatus | null {
  const p = join(dataDir, 'upgrade-status.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as UpgradeStatus
  } catch {
    return null
  }
}

export function canUpgrade(state: VersionState): { ok: boolean; reason?: string } {
  if (state.upgrade_capability === 'system') {
    return { ok: false, reason: 'system mode 由管理员在终端升级' }
  }
  if (!state.upgrade_available) {
    return { ok: false, reason: '已是最新版本' }
  }
  if (state.upgrade_capability === 'source' && (state.source_blockers?.length ?? 0) > 0) {
    return { ok: false, reason: state.source_blockers!.join('；') }
  }
  return { ok: true }
}

/**
 * spawn detached 升级进程（scripts/ui-upgrade.mjs）。
 * 立即返回；进程脱离 admin 进程组，stop MM 时不被杀。
 */
export function startUpgrade(crabotHome: string): { status: 'started' } {
  const script = join(crabotHome, 'scripts', 'ui-upgrade.mjs')
  const child = spawn(process.execPath, [script], {
    cwd: crabotHome,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })
  // 必须在 unref 前挂 error 监听：spawn 失败异步 emit 'error'，
  // 任何 await 间隙都会让它漏成 uncaughtException 干掉主进程。
  child.on('error', (err) => {
    console.error('[upgrade] spawn ui-upgrade failed:', err)
  })
  child.unref()
  return { status: 'started' }
}

/** 是否有升级正在进行（用于防重） */
export function isUpgradeInProgress(dataDir: string): boolean {
  const s = readUpgradeStatus(dataDir)
  return s?.phase === 'upgrading' || s?.phase === 'restarting'
}
