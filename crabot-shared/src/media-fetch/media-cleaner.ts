/**
 * MediaCleaner — data/media 目录的 TTL 定时清扫。
 *
 * 入站图片（急切下载）+ 惰性 materialize 的文件都落在 data/media。被清掉后，
 * agent 再 fetch_media 会重新下载（handle 持久化在别处），故 GC 可激进。
 * 镜像 MessageStore.startCleanup + admin MediaStore.sweepExpired 的样板。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000 // 12h

export class MediaCleaner {
  private readonly mediaDir: string
  private readonly ttlMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(dataDir: string, ttlDays: number = 7) {
    this.mediaDir = path.join(dataDir, 'media')
    this.ttlMs = ttlDays * 86400_000
  }

  startCleanup(): void {
    void this.cleanup()
    this.cleanupTimer = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS)
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      ;(this.cleanupTimer as NodeJS.Timeout).unref()
    }
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private async cleanup(): Promise<void> {
    try {
      await this.sweepExpired()
    } catch (err) {
      console.error('[MediaCleaner] cleanup error:', err)
    }
  }

  /** 删除 mtime 超过 TTL 的文件，返回删除数。注入 nowMs 便于测试。单文件失败跳过。 */
  async sweepExpired(nowMs: number = Date.now()): Promise<number> {
    let files: string[]
    try {
      files = await fs.readdir(this.mediaDir)
    } catch {
      return 0
    }
    const cutoff = nowMs - this.ttlMs
    let deleted = 0
    for (const name of files) {
      const filePath = path.join(this.mediaDir, name)
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) continue
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath)
          deleted++
        }
      } catch {
        /* 单文件失败跳过 */
      }
    }
    return deleted
  }
}
