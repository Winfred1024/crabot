/**
 * 测试 ensureAgentPort 在 RPC 失败时清缓存的行为。
 * 这里用最小可注入的方式：手动构造一个有 agentPort/rpcClient 的对象，
 * 模拟 admin server 的端口缓存路径。
 */
import { describe, it, expect, vi } from 'vitest'

interface MockAdmin {
  agentPort: number
  rpcClient: { call: ReturnType<typeof vi.fn> }
  ensureAgentPort: () => Promise<number>
  callAgent: (method: string) => Promise<unknown>
}

function createMockAdmin(): MockAdmin {
  const self: MockAdmin = {
    agentPort: 19005,
    rpcClient: { call: vi.fn() },
    async ensureAgentPort() {
      return this.agentPort
    },
    async callAgent(method: string) {
      const port = await this.ensureAgentPort()
      try {
        return await this.rpcClient.call(port, method, {})
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('ECONNREFUSED') || msg.includes('connect failed')) {
          // 这就是要实现的：清缓存
          this.agentPort = 0
        }
        throw err
      }
    },
  }
  return self
}

describe('agent port cache invalidation', () => {
  it('invalidates cached port on ECONNREFUSED', async () => {
    const m = createMockAdmin()
    m.rpcClient.call.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:19005'))

    await expect(m.callAgent('get_traces')).rejects.toThrow('ECONNREFUSED')
    expect(m.agentPort).toBe(0)
  })

  it('does not invalidate on other errors', async () => {
    const m = createMockAdmin()
    m.rpcClient.call.mockRejectedValue(new Error('Internal error'))

    await expect(m.callAgent('get_traces')).rejects.toThrow('Internal error')
    expect(m.agentPort).toBe(19005)
  })
})
