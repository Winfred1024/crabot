import type { ContentBlock } from './types'

export type QueueContent = string | ContentBlock[]
export type QueueTransform = (content: QueueContent) => QueueContent

export class HumanMessageQueue {
  private pending: QueueContent[] = []
  private waitResolve: ((value: QueueContent) => void) | null = null
  private children: Set<{ queue: HumanMessageQueue; transform?: QueueTransform }> = new Set()
  private barrierResolve: (() => void) | null = null
  private barrierTimer: ReturnType<typeof setTimeout> | null = null
  private pushCallbacks: Set<() => void> = new Set()

  push(content: QueueContent): void {
    if (this.waitResolve) {
      const resolve = this.waitResolve
      this.waitResolve = null
      resolve(content)
    } else {
      this.pending = [...this.pending, content]
    }
    for (const child of this.children) {
      const transformed = child.transform ? child.transform(content) : content
      child.queue.push(transformed)
    }
    this.clearBarrier()
    for (const cb of this.pushCallbacks) {
      cb()
    }
  }

  /** 非消费性等待：只要有新内容 push 进来就 resolve，不取出内容。支持 AbortSignal。 */
  waitForPush(signal?: AbortSignal): Promise<void> {
    // 如果 pending 已有内容（push 先于 waitForPush 到达），立即 resolve，避免永久挂起
    if (this.pending.length > 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const pushCb = (): void => {
        this.pushCallbacks.delete(pushCb)
        if (signal) signal.removeEventListener('abort', abortCb)
        finish()
      }
      const abortCb = (): void => {
        this.pushCallbacks.delete(pushCb)
        finish()
      }
      this.pushCallbacks.add(pushCb)
      if (signal) {
        signal.addEventListener('abort', abortCb, { once: true })
      }
    })
  }

  async dequeue(): Promise<QueueContent> {
    if (this.pending.length > 0) {
      const [first, ...rest] = this.pending
      this.pending = rest
      return first
    }
    return new Promise<QueueContent>((resolve) => {
      this.waitResolve = resolve
    })
  }

  drainPending(): QueueContent[] {
    const drained = this.pending
    this.pending = []
    return drained
  }

  get hasPending(): boolean {
    return this.pending.length > 0
  }

  createChild(transform?: QueueTransform): HumanMessageQueue {
    const child = new HumanMessageQueue()
    const entry = { queue: child, transform }
    this.children = new Set([...this.children, entry])
    return child
  }

  removeChild(child: HumanMessageQueue): void {
    const next = new Set<{ queue: HumanMessageQueue; transform?: QueueTransform }>()
    for (const entry of this.children) {
      if (entry.queue !== child) {
        next.add(entry)
      }
    }
    this.children = next
  }

  /**
   * @param onTimeout 超时（而非 push/clearBarrier）触发时回调。
   *   典型用法：push 一条 [wait_timeout] 标记消息，让 worker 醒来知道是计时器到了。
   *   push 或 clearBarrier 提前唤醒时不会调用。
   */
  setBarrier(timeoutMs: number, onTimeout?: () => void): void {
    this.clearBarrier()
    this.barrierTimer = setTimeout(() => {
      this.barrierTimer = null
      onTimeout?.()
      this.clearBarrier()
    }, timeoutMs)
  }

  clearBarrier(): void {
    if (this.barrierTimer !== null) {
      clearTimeout(this.barrierTimer)
      this.barrierTimer = null
    }
    if (this.barrierResolve !== null) {
      const resolve = this.barrierResolve
      this.barrierResolve = null
      resolve()
    }
  }

  get hasBarrier(): boolean {
    return this.barrierTimer !== null || this.barrierResolve !== null
  }

  async waitBarrier(signal?: AbortSignal): Promise<void> {
    if (!this.hasBarrier) {
      return
    }
    if (this.barrierResolve !== null) {
      return
    }
    return new Promise<void>((resolve) => {
      if (signal) {
        const onAbort = (): void => {
          this.clearBarrier()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        this.barrierResolve = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
      } else {
        this.barrierResolve = resolve
      }
    })
  }
}
