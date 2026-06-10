import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * 复现并验证 saveTasks race condition 修复。
 *
 * 这条 race 是 schedule task 卡 pending 永不跑的真凶：并发 saveTasks → atomicWriteFile 在
 * rename(tmp→tasks.json) 阶段冲突 → ENOENT → handleCreateTask 抛 → agent
 * handleCreateTaskFromSchedule 抛 → ScheduledTaskRunner 不触发。
 *
 * 测试策略：模拟 atomicWriteFile 的 write+rename 两步操作，先在没锁的情况下并发 N 次确认能复现
 * ENOENT，再用本仓库 index.ts 同款的 while(lock) await lock + lock=promise 模式串行化，证明并发
 * N 次全部成功。
 */

class SaveTasksRunner {
  private lock: Promise<void> | null = null
  constructor(private readonly file: string, private readonly serialized: boolean) {}

  async save(content: string): Promise<void> {
    if (!this.serialized) {
      return this.atomicWrite(content)
    }
    while (this.lock) {
      await this.lock
    }
    const p = this.atomicWrite(content)
    this.lock = p
    try {
      await p
    } finally {
      if (this.lock === p) this.lock = null
    }
  }

  private async atomicWrite(content: string): Promise<void> {
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, content, 'utf-8')
    await fs.rename(tmp, this.file)
  }
}

describe('saveTasks race fix', () => {
  it('未串行化时 N 个并发 saveTasks 至少触发一次 ENOENT', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-tasks-race-'))
    const file = path.join(dir, 'tasks.json')
    const runner = new SaveTasksRunner(file, false)
    const N = 50

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => runner.save(`payload-${i}`)),
    )
    const errors = results.filter(r => r.status === 'rejected')
    // 至少 1 个 ENOENT 即证明 race 真实存在（不强制 N-1，写盘速度受 IO 影响有波动）
    const enoentCount = errors.filter(
      r => r.status === 'rejected' && String((r as PromiseRejectedResult).reason?.code ?? '').includes('ENOENT'),
    ).length
    expect(enoentCount).toBeGreaterThan(0)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('串行化后 N 个并发 saveTasks 全部成功', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-tasks-race-'))
    const file = path.join(dir, 'tasks.json')
    const runner = new SaveTasksRunner(file, true)
    const N = 50

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => runner.save(`payload-${i}`)),
    )
    const errors = results.filter(r => r.status === 'rejected')
    expect(errors).toHaveLength(0)

    // 最终文件存在且可读
    const final = await fs.readFile(file, 'utf-8')
    expect(final).toMatch(/^payload-\d+$/)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
