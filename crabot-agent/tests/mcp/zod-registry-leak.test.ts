/**
 * zod v4 globalRegistry 泄漏回归测试（2026-06-11 OOM 事故）
 *
 * 背景：worker 每轮 LLM turn 都通过 buildToolsDynamic 重建 in-process MCP server。
 * zod v4 的 `.describe()` 会把 schema clone 写入 globalRegistry（强引用 Map，永不清除）。
 * 若工具 schema 在工厂函数内 inline 构建，每次重建都净增 registry 条目 → 整棵 schema
 * 树永久滞留 → ~13 小时后堆 2.2GB OOM。
 *
 * 约束：工具 schema 必须是模块级常量（import 时注册一次），重复调用工厂函数
 * 不得增加 globalRegistry 条目数。
 */

import { describe, test, expect, vi } from 'vitest'
import { globalRegistry } from 'zod/v4/core'
import { createCrabMemoryServer, type MemoryTaskContext } from '../../src/mcp/crab-memory.js'
import { createCrabMessagingServer } from '../../src/mcp/crab-messaging.js'

function registrySize(): number {
  return (globalRegistry as unknown as { _map: Map<unknown, unknown> })._map.size
}

const rpcStub = { call: vi.fn().mockResolvedValue({}) } as never

const memoryDeps = {
  rpcClient: rpcStub,
  moduleId: 'leak-test',
  getMemoryPort: async () => 19002,
}

// isMasterPrivate=true 让条件注册的工具组也走到，覆盖全部 schema 构建路径
const memoryCtx: MemoryTaskContext = {
  taskId: 't-leak',
  visibility: 'public',
  scopes: [],
  isMasterPrivate: true,
}

const messagingDeps = {
  rpcClient: rpcStub,
  moduleId: 'leak-test',
  getAdminPort: async () => 19001,
  resolveChannelPort: async () => 19009,
  enableFeishuDocTool: true,
}

describe('zod globalRegistry 泄漏回归', () => {
  test('重复构建 crab-memory server 不增加 globalRegistry 条目', () => {
    // 首次构建：允许模块加载/首次执行注册 schema
    createCrabMemoryServer(memoryDeps, memoryCtx)
    const before = registrySize()

    for (let i = 0; i < 3; i++) {
      createCrabMemoryServer(memoryDeps, memoryCtx)
    }

    expect(registrySize() - before).toBe(0)
  })

  test('重复构建 crab-messaging server 不增加 globalRegistry 条目', () => {
    createCrabMessagingServer(messagingDeps)
    const before = registrySize()

    for (let i = 0; i < 3; i++) {
      createCrabMessagingServer(messagingDeps)
    }

    expect(registrySize() - before).toBe(0)
  })
})
