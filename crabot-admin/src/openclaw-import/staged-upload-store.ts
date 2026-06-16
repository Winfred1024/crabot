/**
 * OpenClaw 导入的暂存上传存储。
 *
 * 两步流程（parse → execute）需要把上传的备份（可能 GB 级）暂存在两次请求之间，
 * 但清理不能依赖客户端。三层兜底（行业标准做法，参考 S3 multipart lifecycle abort）：
 *   1. 终态 discard：execute 成功/失败都在 finally 里 discard（兜底执行失败）
 *   2. TTL 后台清扫 sweepExpired：定时器驱动，回收取消/放弃的暂存（不依赖前端发 cancel）
 *   3. init 启动清扫：进程重启后内存记录已失，磁盘残留必是孤儿，整目录清掉
 *
 * 暂存放在 data_dir 下专属目录（自己拥有，清扫可靠），对齐 media-store.ts 范式。
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TTL_MS = 30 * 60 * 1000 // 30 分钟

type StagedEntry = { path: string; createdAtMs: number }

export class StagedUploadStore {
  private readonly entries = new Map<string, StagedEntry>()
  private readonly storeDir: string
  private readonly ttlMs: number

  constructor(baseDir: string, opts: { ttlMs?: number } = {}) {
    this.storeDir = path.join(baseDir, 'openclaw-import-staging')
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
  }

  /** mkdir + 清扫上次进程残留的孤儿（重启后内存记录已失）。 */
  async init(): Promise<void> {
    await fs.rm(this.storeDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.mkdir(this.storeDir, { recursive: true })
  }

  /** 申请一个暂存槽：返回 token + 落盘路径，并记录创建时间。 */
  stage(nowMs: number = Date.now()): { token: string; path: string } {
    const token = crypto.randomUUID()
    const filePath = path.join(this.storeDir, `${token}.tar.gz`)
    this.entries.set(token, { path: filePath, createdAtMs: nowMs })
    return { token, path: filePath }
  }

  resolve(token: string): string | undefined {
    return this.entries.get(token)?.path
  }

  /** 丢弃一个槽：删文件 + 删记录。不存在则安静返回。 */
  async discard(token: string): Promise<void> {
    const entry = this.entries.get(token)
    if (!entry) return
    this.entries.delete(token)
    await fs.rm(entry.path, { force: true }).catch(() => undefined)
  }

  /** 清扫创建至今超过 TTL 的暂存，返回清掉的数量。 */
  async sweepExpired(nowMs: number = Date.now()): Promise<number> {
    let swept = 0
    for (const [token, entry] of this.entries) {
      if (nowMs - entry.createdAtMs >= this.ttlMs) {
        this.entries.delete(token)
        await fs.rm(entry.path, { force: true }).catch(() => undefined)
        swept += 1
      }
    }
    return swept
  }
}
