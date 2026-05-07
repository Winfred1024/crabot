/**
 * 磁盘水位线检查
 *
 * 周期检查 dataDir 所在挂载点的剩余空间，跌破阈值时返回 is_low=true，
 * 调用方据此决定是否广播 system.disk_low 事件（去抖在调用方，不在此处）。
 *
 * @see crabot-docs/protocols/protocol-module-manager.md "system.disk_low"
 */

import { statfs as statfsCb } from 'node:fs'
import { promisify } from 'node:util'
import type { SystemDiskLowPayload } from './types.js'

const statfsAsync = promisify(statfsCb)

export interface StatfsResult {
  bavail: bigint
  blocks: bigint
  bsize: number
}

export type StatfsFn = (path: string) => Promise<StatfsResult>

export interface DiskCheckResult {
  is_low: boolean
  available_bytes: number
  total_bytes: number
  /** 仅当 is_low === true 时填充，可直接作为事件 payload */
  payload?: SystemDiskLowPayload
  /** statfs 失败时填错误信息；is_low=false 不发事件 */
  error?: string
}

/**
 * 检查路径所在挂载点剩余空间。
 *
 * @param path 检查的路径（通常是 DATA_DIR）
 * @param thresholdBytes 触发低水位的可用字节阈值
 * @param statfsFn 注入点：默认用 node:fs.statfs，单测时换 mock
 */
export async function checkDiskLow(
  path: string,
  thresholdBytes: number,
  statfsFn: StatfsFn = (p) => statfsAsync(p) as unknown as Promise<StatfsResult>
): Promise<DiskCheckResult> {
  let stat: StatfsResult
  try {
    stat = await statfsFn(path)
  } catch (err) {
    return {
      is_low: false,
      available_bytes: 0,
      total_bytes: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const available = Number(stat.bavail) * stat.bsize
  const total = Number(stat.blocks) * stat.bsize
  const isLow = available < thresholdBytes
  const percent = total > 0 ? (available / total) * 100 : 0

  return {
    is_low: isLow,
    available_bytes: available,
    total_bytes: total,
    ...(isLow
      ? {
          payload: {
            path,
            available_bytes: available,
            total_bytes: total,
            threshold_bytes: thresholdBytes,
            available_percent: percent,
          } satisfies SystemDiskLowPayload,
        }
      : {}),
  }
}
