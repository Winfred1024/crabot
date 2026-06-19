/**
 * 判定导入的 schedule 是否应置 disabled：仅「过期的 once」需要（避免误发历史一次性提醒）。
 * cron/interval 正常 arm。Schedule.trigger 是嵌套判别联合（type: cron|interval|once）。
 * 设计依据：2026-06-19-crabot-backup-import-design.md §2.6
 */

export type ScheduleShape = {
  trigger?: { type?: string; execute_at?: string }
}

export function shouldDisableOnImport(schedule: ScheduleShape, nowMs: number): boolean {
  const trigger = schedule.trigger
  if (!trigger || trigger.type !== 'once') return false
  if (typeof trigger.execute_at !== 'string') return false
  const at = Date.parse(trigger.execute_at)
  return Number.isFinite(at) && at < nowMs
}
