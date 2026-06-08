import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 解析 DATA_DIR。优先级：
 *  1. env.DATA_DIR（显式指定，最高）
 *  2. legacy source install 兼容：repoRoot && offset=0 && $REPO/data/admin 存在 → 用它
 *  3. 默认：offset=0 → ~/.crabot/data；offset>0 → ~/.crabot/data-<OFF>
 *
 * 第 2 项的存在原因：
 *   system mode 多用户部署 merge（~/.crabot/data 成为默认）之前，install-from-source
 *   用户的 crabot start 用 $REPO/data。merge 后默认改了 → 老用户升级一启动就发现
 *   channel/agent/skills 全"消失"。检测 $REPO/data/admin 存在就用它，保持向后兼容。
 *   用户想真切到 ~/.crabot/data 时显式设 DATA_DIR=~/.crabot/data 覆盖即可。
 *
 * dev.sh 在 bash 里有独立的 DATA_DIR 计算（写死 $SCRIPT_DIR/data），不走此函数。
 */
export function resolveDataDir({ envValue, offset = 0, repoRoot } = {}) {
  if (envValue) return envValue
  if (repoRoot && offset === 0) {
    const repoData = resolve(repoRoot, 'data')
    if (existsSync(join(repoData, 'admin'))) {
      return repoData
    }
  }
  const sub = offset > 0 ? `data-${offset}` : 'data'
  return resolve(homedir(), '.crabot', sub)
}
