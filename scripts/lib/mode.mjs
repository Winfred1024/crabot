import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_ETC = '/etc/crabot'

/**
 * 探测当前是 user 还是 system mode。
 * 探测点：/etc/crabot/cluster.version 是否存在。
 * 入参允许覆盖（仅供测试）。
 */
export function detectMode(etcDir = DEFAULT_ETC) {
  return existsSync(join(etcDir, 'cluster.version')) ? 'system' : 'user'
}
