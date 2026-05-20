import type { GlobalModelConfig } from './types.js'

/**
 * 解析 /api/agent/traces/old 的 query 参数，返回解析结果或错误对象。
 * 纯函数，方便单测。
 */
export function parseCleanupParams(url: URL): { days: number; dryRun: boolean } | { error: string } {
  const days = Number(url.searchParams.get('days') ?? '0')
  const dryRun = url.searchParams.get('dry_run') !== 'false' // 默认 dry_run=true 安全
  if (!Number.isFinite(days) || days < 1) {
    return { error: 'days must be >= 1' }
  }
  return { days, dryRun }
}

export interface TraceCleanupCronDeps {
  getGlobalConfig: () => GlobalModelConfig
  callCleanup: (days: number) => Promise<{ affected_count: number; affected_bytes: number }>
  /** 测试用：立刻触发一次 */
  runImmediately?: boolean
  /** 测试用：注入定时器 */
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
  /** 默认 86_400_000 ms（1 天） */
  intervalMs?: number
}

const DEFAULT_INTERVAL_MS = 86_400_000

export function startTraceCleanupCron(deps: TraceCleanupCronDeps): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const setIntervalFn = deps.setIntervalFn ?? setInterval
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval

  const tick = async (): Promise<void> => {
    try {
      const cfg = deps.getGlobalConfig()
      const retention = cfg.trace_retention_days
      if (retention == null || retention <= 0) return
      const result = await deps.callCleanup(retention)
      console.log(`[admin] trace cleanup: removed ${result.affected_count} traces (${result.affected_bytes} bytes)`)
    } catch (err) {
      console.error('[admin] trace cleanup failed:', err instanceof Error ? err.message : err)
    }
  }

  if (deps.runImmediately) void tick()
  const timer = setIntervalFn(() => void tick(), intervalMs)
  return () => clearIntervalFn(timer)
}
