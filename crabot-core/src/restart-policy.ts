/**
 * 模块重启策略：指数退避 + 窗口限流
 *
 * 纯函数：输入历史 + 当前时间，返回是否重启 / 延迟 / 新历史。
 * 不持有 timer，不副作用，便于单测。
 *
 * @see crabot-docs/protocols/protocol-module-manager.md "auto_restart"
 */

const WINDOW_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 10000

export interface RestartHistory {
  /** 重启尝试时间戳（ms epoch），按时间升序 */
  readonly attempts: ReadonlyArray<number>
}

export interface RestartDecision {
  should_restart: boolean
  /** 距离立刻执行的延迟毫秒数（仅 should_restart=true 时有效；limit 时为 0） */
  delay_ms: number
  /** 不重启时的原因 */
  reason?: string
  /** 应替换原历史的新对象 */
  next_history: RestartHistory
}

/**
 * 指数退避：attempt 0 → 1s, 1 → 2s, 2 → 4s, 3 → 8s, 4+ → 10s 上限
 *
 * 单独导出以便单测验证退避序列，不被 MAX_ATTEMPTS 限制干扰。
 */
export function computeBackoff(attemptIdx: number): number {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attemptIdx), MAX_DELAY_MS)
}

/**
 * 决定下一次重启行为。
 *
 * @param history 之前的重启尝试记录（不会被修改）
 * @param now 当前 ms epoch
 */
export function scheduleRestart(
  history: RestartHistory,
  now: number
): RestartDecision {
  // 1. 移除窗口外的旧记录（filter 返回新数组，不修改原数组）
  const inWindow = history.attempts.filter((t) => now - t < WINDOW_MS)

  // 2. 检查限额：超限不重启，history 不增长（调用方应停止再调）
  if (inWindow.length >= MAX_ATTEMPTS) {
    return {
      should_restart: false,
      delay_ms: 0,
      reason: `restart limit reached (${MAX_ATTEMPTS} attempts within ${WINDOW_MS / 1000}s window)`,
      next_history: { attempts: inWindow },
    }
  }

  // 3. 允许重启：算 delay，把当前时间戳加进新历史
  return {
    should_restart: true,
    delay_ms: computeBackoff(inWindow.length),
    next_history: { attempts: [...inWindow, now] },
  }
}
