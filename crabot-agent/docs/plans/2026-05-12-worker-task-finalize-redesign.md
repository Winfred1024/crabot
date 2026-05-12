# Worker Task Finalize Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"task 收尾汇报"的逻辑从 worker prompt 末尾 fence 块（fragile soft-constraint）拆成 engine 控制的"反思补轮"，工具层让 worker 主动调 send_message 发回复，砍掉 ask_human 工具，彻底解决 2026-05-12 b05db23a 类型的"用户面 0 chars 静默失败"事故。

**Architecture:**
- **工具层**：`send_message` 加 `intent: 'normal' | 'ask_human'` 参数；删除独立的 `ask_human` built-in 工具。worker 自己负责发用户面回复，engine 不再代劳。
- **Engine 层**：主 loop 自然 end_turn 后，engine 进入 finalize 阶段：先把 admin task 标 completed（任务对用户立即结束）、dispose humanMessageQueue（关闭 supplement 通道），然后用同 adapter 跑"反思补轮"——注入固定 user message 要求 LLM 输出 `{outcome_brief, process_highlights}` 的 JSON，engine 校验 + retry，结果通过 `update_task_outcome` 回填到 task.result。补轮失败 fallback 到 finalText.slice(0,200)。
- **Dispatcher 层**：删除 `sendReplyToUser`（worker 已自己发）+ `task-outcome-parser.ts`（不再剥契约块）+ `final_reply.text` 同源 alias。`finalizeTaskMemory` 改为从 admin task.result 拉结构化字段。

**Tech Stack:** TypeScript, vitest, zod, Anthropic SDK adapter, OpenAI SDK adapter, RPC over HTTP

---

## File Structure

### 新建文件
- `crabot-agent/src/orchestration/structured-outcome-reflector.ts` — 反思补轮独立模块：注入 prompt、调 adapter、校验 JSON、retry、fallback
- `crabot-agent/tests/orchestration/structured-outcome-reflector.test.ts`
- `crabot-admin/tests/update-task-outcome.test.ts`

### 修改文件
- `crabot-admin/src/types.ts:608-617` — `TaskResult` 加 `outcome_brief?` + `process_highlights?` 字段
- `crabot-admin/src/index.ts:411` — 注册 `update_task_outcome` RPC，写新 handler
- `crabot-agent/src/mcp/crab-messaging.ts:407` — `send_message` schema 加 `intent` 字段
- `crabot-agent/src/engine/progress-digest.ts:96-100` — 立即刷新条件从 "tool=ask_human" 改为 "tool=send_message && intent=ask_human"
- `crabot-agent/src/engine/query-loop.ts:168-216` — end_turn 收口前再 check humanMessageQueue（防最后一刻 supplement 漏掉）
- `crabot-agent/src/agent/worker-handler.ts:491-519` — 删 ask_human built-in tool；executeTask 末尾加 finalize 编排（update_task_status → dispose queue → reflector → update_task_outcome）
- `crabot-agent/src/prompt-manager.ts:469-509` — 删 "末尾必填 JSON fence" 整段；改 ask_human 描述；删 "已发送的即时回复" 一行
- `crabot-agent/src/orchestration/decision-dispatcher.ts:404-457, 540-582, 683-718` — 删 `sendReplyToUser`、删用 stripped_summary 发用户面、删 `extractTaskOutcome` 调用；`finalizeTaskMemory` 入参改为从 admin task.result 拉
- `crabot-agent/src/types.ts:664-672` — `ExecuteTaskResult` 删 `summary` + `final_reply`，只剩 `outcome` 和可选 `error`

### 删除文件
- `crabot-agent/src/orchestration/task-outcome-parser.ts`（整个文件，第 1 步落地的空兜底也随之删除）
- `crabot-agent/tests/orchestration/task-outcome-parser.test.ts`

---

## Task 依赖关系

```
T1 (Admin types) ─┐
T2 (Admin RPC) ───┴→ T6 (worker finalize 编排)
T3 (reflector 模块) ──┘
T4 (send_message intent) ──→ T8 (prompt 改写) ──→ T9 (删 ask_human) ──→ T10 (dispatcher 清理)
T5 (progress-digest) ─────────────────────────────┘
T7 (end_turn supplement 兜底) — 独立
```

按编号顺序执行最安全。每个 task 独立可发版（含 commit），失败可单独回滚。

---

## Task 1: Admin TaskResult 加结构化字段

**Files:**
- Modify: `crabot-admin/src/types.ts:607-617`

- [ ] **Step 1: 添加字段**

```typescript
// crabot-admin/src/types.ts
/** 任务结果（Worker 完成/失败时写入） */
export interface TaskResult {
  /** 任务结局 */
  outcome: 'completed' | 'failed'
  /** 结果摘要（自然语言）—— @deprecated 由 outcome_brief 替代，仅为向后兼容保留 */
  summary?: string
  /** 最终回复内容 —— @deprecated worker 现已主动 send_message，本字段不再写入 */
  final_reply?: { text: string }
  /** 完成/失败时间 */
  finished_at: string
  /** 结构化反思：本次任务做了什么、是否顺利（≤200 字） */
  outcome_brief?: string
  /** 结构化反思：过程中的异常 / 兜底切换 / 关键决策（最多 3 条，每条 ≤80 字） */
  process_highlights?: string[]
}
```

- [ ] **Step 2: 验证类型编译通过**

Run: `cd crabot-admin && npx tsc --noEmit`
Expected: PASS（无 type error）

- [ ] **Step 3: Commit**

```bash
git add crabot-admin/src/types.ts
git commit -m "feat(admin): TaskResult 加 outcome_brief / process_highlights 字段，summary/final_reply 标记 deprecated"
```

---

## Task 2: Admin update_task_outcome RPC

**Files:**
- Modify: `crabot-admin/src/index.ts:411` (注册) + handleUpdateTaskStatus 附近 (实现)
- Create: `crabot-admin/tests/update-task-outcome.test.ts`

- [ ] **Step 1: 先写失败测试**

```typescript
// crabot-admin/tests/update-task-outcome.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import AdminModule from '../src/index.js'
import { generateId } from '../src/utils.js'

describe('update_task_outcome RPC', () => {
  let admin: any
  let taskId: string

  beforeEach(async () => {
    admin = new AdminModule(
      { moduleId: 'admin-web', moduleType: 'admin', version: '0.1.0', protocolVersion: '0.1.0', port: 0, subscriptions: [] },
      { web_port: 0, data_dir: '/tmp/test-admin-' + generateId() }
    )
    await admin.start()
    // 创建一个 completed task
    const result = await admin['rpcHandlers'].get('create_task')!({
      title: 'Test',
      description: 'Test desc',
      source: { origin: 'human', source_module_id: 'telegram-001', trigger_type: 'manual', channel_id: 'telegram-001', session_id: 's1', friend_id: 'f1' },
    })
    taskId = result.task.id
    await admin['rpcHandlers'].get('update_task_status')!({ task_id: taskId, status: 'planning' })
    await admin['rpcHandlers'].get('update_task_status')!({ task_id: taskId, status: 'executing' })
    await admin['rpcHandlers'].get('update_task_status')!({
      task_id: taskId, status: 'completed',
      result: { outcome: 'completed', summary: 'done', finished_at: '2026-05-12T00:00:00Z' },
    })
  })

  it('patch outcome_brief / process_highlights 到已 completed 的 task.result', async () => {
    const r = await admin['rpcHandlers'].get('update_task_outcome')!({
      task_id: taskId,
      outcome_brief: '完成任务 X',
      process_highlights: ['亮点 1', '亮点 2'],
    })
    expect(r.task.result.outcome_brief).toBe('完成任务 X')
    expect(r.task.result.process_highlights).toEqual(['亮点 1', '亮点 2'])
    // 不动 status
    expect(r.task.status).toBe('completed')
    // 不动 summary / finished_at
    expect(r.task.result.summary).toBe('done')
    expect(r.task.result.finished_at).toBe('2026-05-12T00:00:00Z')
  })

  it('对不存在的 task 抛 TASK_NOT_FOUND', async () => {
    await expect(
      admin['rpcHandlers'].get('update_task_outcome')!({ task_id: 'nope', outcome_brief: 'x' })
    ).rejects.toThrow(/TASK_NOT_FOUND/)
  })

  it('outcome_brief 缺失也允许 patch（只更新 highlights）', async () => {
    const r = await admin['rpcHandlers'].get('update_task_outcome')!({
      task_id: taskId,
      process_highlights: ['only highlights'],
    })
    expect(r.task.result.process_highlights).toEqual(['only highlights'])
    expect(r.task.result.outcome_brief).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd crabot-admin && npx vitest run tests/update-task-outcome.test.ts`
Expected: FAIL，提示 `Method "update_task_outcome" not found` 或类似

- [ ] **Step 3: 实现 handleUpdateTaskOutcome**

在 `crabot-admin/src/index.ts` 中 `handleUpdateTaskStatus` 之后（约 line 3720）加：

```typescript
private async handleUpdateTaskOutcome(params: {
  task_id: TaskId
  outcome_brief?: string
  process_highlights?: string[]
}): Promise<{ task: Task }> {
  const task = this.tasks.get(params.task_id)
  if (!task) {
    throw new Error(AdminErrorCode.TASK_NOT_FOUND)
  }
  if (!task.result) {
    // task.result 应在 update_task_status('completed') 时已写入；防御性兜底
    task.result = { outcome: 'completed', finished_at: generateTimestamp() }
  }
  task.result = {
    ...task.result,
    ...(params.outcome_brief !== undefined ? { outcome_brief: params.outcome_brief } : {}),
    ...(params.process_highlights !== undefined ? { process_highlights: params.process_highlights } : {}),
  }
  task.updated_at = generateTimestamp()
  this.tasks.set(task.id, task)
  await this.saveData()
  return { task }
}
```

注册（line 411 附近）：

```typescript
this.registerMethod('update_task_outcome', this.handleUpdateTaskOutcome.bind(this))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd crabot-admin && npx vitest run tests/update-task-outcome.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add crabot-admin/src/index.ts crabot-admin/tests/update-task-outcome.test.ts
git commit -m "feat(admin): 加 update_task_outcome RPC，patch task.result.outcome_brief/process_highlights 不动 status"
```

---

## Task 3: Structured Outcome Reflector 模块

**Files:**
- Create: `crabot-agent/src/orchestration/structured-outcome-reflector.ts`
- Create: `crabot-agent/tests/orchestration/structured-outcome-reflector.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// crabot-agent/tests/orchestration/structured-outcome-reflector.test.ts
import { describe, it, expect } from 'vitest'
import { reflectStructuredOutcome } from '../../src/orchestration/structured-outcome-reflector.js'
import type { EngineMessage } from '../../src/engine/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'

function makeAdapter(responses: string[]): LLMAdapter {
  let i = 0
  return {
    complete: async () => ({
      content: [{ type: 'text', text: responses[i++] ?? '' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  } as unknown as LLMAdapter
}

const FALLBACK_TEXT = '执行完毕，结果已发给用户。'

describe('reflectStructuredOutcome', () => {
  it('正常路径：LLM 一次性输出合法 JSON', async () => {
    const adapter = makeAdapter([
      '```json\n{"outcome_brief":"完成任务 X","process_highlights":["亮点 1"]}\n```',
    ])
    const r = await reflectStructuredOutcome({
      messages: [{ role: 'user', content: 'test' }] as EngineMessage[],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
    })
    expect(r.outcome_brief).toBe('完成任务 X')
    expect(r.process_highlights).toEqual(['亮点 1'])
    expect(r.retries).toBe(0)
  })

  it('JSON 错时 retry，第二次成功', async () => {
    const adapter = makeAdapter([
      '我不打算输出 JSON',
      '```json\n{"outcome_brief":"修正后","process_highlights":[]}\n```',
    ])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
    })
    expect(r.outcome_brief).toBe('修正后')
    expect(r.retries).toBe(1)
  })

  it('JSON 错 + 重试上限耗尽后 fallback 到 lastAssistantText.slice(0,200)', async () => {
    const adapter = makeAdapter(['bad', 'still bad', 'still bad again'])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
      maxRetries: 2,
    })
    expect(r.outcome_brief).toBe(FALLBACK_TEXT)
    expect(r.process_highlights).toEqual([])
    expect(r.fellBackToLastText).toBe(true)
  })

  it('字段类型错（highlights 不是数组）→ 走 fallback', async () => {
    const adapter = makeAdapter([
      '```json\n{"outcome_brief":"x","process_highlights":"not an array"}\n```',
      '```json\n{"outcome_brief":"x","process_highlights":"still not array"}\n```',
    ])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
      maxRetries: 1,
    })
    expect(r.fellBackToLastText).toBe(true)
  })

  it('outcome_brief 超 200 字自动截断', async () => {
    const long = '甲'.repeat(500)
    const adapter = makeAdapter([
      `\`\`\`json\n{"outcome_brief":"${long}","process_highlights":[]}\n\`\`\``,
    ])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
    })
    expect(r.outcome_brief).toHaveLength(200)
  })

  it('highlights 超 3 条 / 单条超 80 字 自动截断', async () => {
    const longH = '亮'.repeat(120)
    const adapter = makeAdapter([
      `\`\`\`json\n{"outcome_brief":"x","process_highlights":["${longH}","a","b","c","d"]}\n\`\`\``,
    ])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: FALLBACK_TEXT,
    })
    expect(r.process_highlights).toHaveLength(3)
    expect(r.process_highlights[0]).toHaveLength(80)
  })

  it('lastAssistantText 也截断到 200 字以内（fallback 时）', async () => {
    const adapter = makeAdapter(['bad', 'bad'])
    const r = await reflectStructuredOutcome({
      messages: [],
      adapter,
      model: 'test-model',
      lastAssistantText: '长'.repeat(500),
      maxRetries: 1,
    })
    expect(r.outcome_brief).toHaveLength(200)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd crabot-agent && npx vitest run tests/orchestration/structured-outcome-reflector.test.ts`
Expected: FAIL，提示模块不存在

- [ ] **Step 3: 实现 reflector**

```typescript
// crabot-agent/src/orchestration/structured-outcome-reflector.ts
import type { EngineMessage } from '../engine/types.js'
import type { LLMAdapter } from '../engine/llm-adapter.js'
import { callNonStreaming } from '../engine/llm-adapter.js'
import { createUserMessage, createAssistantMessage } from '../engine/message-builder.js'

const MAX_BRIEF_LEN = 200
const MAX_HIGHLIGHTS = 3
const MAX_HIGHLIGHT_LEN = 80
const DEFAULT_MAX_RETRIES = 2

const REFLECT_PROMPT =
  '任务已完成。请用 JSON 格式输出本次任务的反思总结：\n\n' +
  '```json\n' +
  '{\n' +
  '  "outcome_brief": "≤200 字。简述本任务做了什么、是否顺利。",\n' +
  '  "process_highlights": ["≤80 字 / 条，最多 3 条。仅写过程中的【异常 / 兜底切换 / 关键决策】。无亮点传 []。"]\n' +
  '}\n' +
  '```\n\n' +
  '这份总结会进入跨 session 长期记忆，未来你或其他 worker 复盘时会查到。' +
  '只输出 JSON 块，不要其他文字。'

const FIX_PROMPT_HEADER = '上次 JSON 输出有问题：'

const FENCE_RE = /```json\s*\n([\s\S]*?)\n```/

interface ReflectorParams {
  readonly messages: readonly EngineMessage[]
  readonly adapter: LLMAdapter
  readonly model: string
  readonly lastAssistantText: string
  readonly maxRetries?: number
}

export interface ReflectResult {
  readonly outcome_brief: string
  readonly process_highlights: readonly string[]
  readonly retries: number
  readonly fellBackToLastText: boolean
}

interface ParseAttempt {
  readonly ok: boolean
  readonly value?: { outcome_brief: string; process_highlights: string[] }
  readonly error?: string
}

function parseAndValidate(text: string): ParseAttempt {
  const match = text.match(FENCE_RE)
  const raw = match ? match[1] : text.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: `JSON 语法错误：${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'JSON 顶层必须是 object' }
  }
  const obj = parsed as Record<string, unknown>
  const brief = obj.outcome_brief
  const highlights = obj.process_highlights
  if (typeof brief !== 'string') {
    return { ok: false, error: 'outcome_brief 必须是 string' }
  }
  if (!Array.isArray(highlights)) {
    return { ok: false, error: 'process_highlights 必须是 array' }
  }
  if (!highlights.every(h => typeof h === 'string')) {
    return { ok: false, error: 'process_highlights 每一项必须是 string' }
  }
  return {
    ok: true,
    value: {
      outcome_brief: brief.slice(0, MAX_BRIEF_LEN),
      process_highlights: (highlights as string[])
        .slice(0, MAX_HIGHLIGHTS)
        .map(h => h.slice(0, MAX_HIGHLIGHT_LEN)),
    },
  }
}

export async function reflectStructuredOutcome(params: ReflectorParams): Promise<ReflectResult> {
  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES
  const workingMessages: EngineMessage[] = [...params.messages, createUserMessage(REFLECT_PROMPT)]
  let lastError = ''

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await callNonStreaming(params.adapter, {
      messages: workingMessages,
      tools: [],
      model: params.model,
    })
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('')

    const parsed = parseAndValidate(text)
    if (parsed.ok && parsed.value) {
      return {
        outcome_brief: parsed.value.outcome_brief,
        process_highlights: parsed.value.process_highlights,
        retries: attempt,
        fellBackToLastText: false,
      }
    }

    lastError = parsed.error ?? 'unknown'
    if (attempt < maxRetries) {
      workingMessages.push(createAssistantMessage([{ type: 'text', text }], 'end_turn'))
      workingMessages.push(createUserMessage(
        `${FIX_PROMPT_HEADER}${lastError}\n请重新按 schema 输出 JSON。`
      ))
    }
  }

  return {
    outcome_brief: params.lastAssistantText.slice(0, MAX_BRIEF_LEN),
    process_highlights: [],
    retries: maxRetries,
    fellBackToLastText: true,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/orchestration/structured-outcome-reflector.test.ts`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/orchestration/structured-outcome-reflector.ts crabot-agent/tests/orchestration/structured-outcome-reflector.test.ts
git commit -m "feat(agent): 加 structured-outcome-reflector 模块，end_turn 后跑反思补轮抽结构化摘要"
```

---

## Task 4: send_message tool 加 intent 字段

**Files:**
- Modify: `crabot-agent/src/mcp/crab-messaging.ts:407-535`
- Test: 在该文件下游消费者（worker-handler）的集成测试里覆盖

- [ ] **Step 1: 改 schema 加 intent 字段**

```typescript
// crabot-agent/src/mcp/crab-messaging.ts:407
{
  name: 'send_message',
  description: '在指定 Channel 的指定 Session 中发送消息。支持文本、媒体 URL、本地文件路径。\n\n' +
    'intent 参数说明：\n' +
    '- "normal"（默认）：发完继续后续操作，不等回应。\n' +
    '- "ask_human"：发出后阻塞等待人类回应，适合"你想要 A 还是 B"这类必须等回答才能继续的问题。' +
    '滥用会让任务停摆，能自己决策的不要 ask。',
  schema: {
    channel_id: z.string().describe('Channel 模块实例 ID'),
    session_id: z.string().describe('目标 Session ID'),
    content: z.string().describe('消息内容（文本或描述）'),
    intent: z.enum(['normal', 'ask_human']).optional().describe('意图：normal=单纯发消息（默认）；ask_human=发后阻塞等回应'),
    content_type: z.enum(['text', 'image', 'file']).optional().describe('消息类型，默认 text'),
    media_url: z.string().optional().describe('媒体 URL（网络地址，与 file_path 二选一）'),
    file_path: z.string().optional().describe('沙盒内本地文件路径（自动转换为主机路径）'),
    filename: z.string().optional().describe('文件名（可选）'),
    mentions: z.array(z.string()).optional().describe('@提及的熟人 ID 列表'),
    quote_message_id: z.string().optional().describe('引用回复的平台消息 ID'),
  },
  handler: async (args) => {
    // ... 原 handler 不变，intent 只是给 progress-digest / barrier 层判断用，
    // send_message handler 本身行为不变（不需要等回应——等回应靠 engine 端的
    // humanMessageQueue.waitBarrier，通过 unified-agent.setBarrierForTask 触发）
    // intent 通过 tool_call 的 input 字段透出，下游消费者从 input.intent 读
    // ...
  },
},
```

- [ ] **Step 2: 加一个 intent 字段透传的简单单元测试**

新建 `crabot-agent/tests/mcp/crab-messaging-send-message-intent.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { createCrabMessagingServer } from '../../src/mcp/crab-messaging.js'

describe('send_message tool: intent 字段', () => {
  it('schema 包含 intent 枚举，accept 合法值', () => {
    const server = createCrabMessagingServer({
      rpcClient: { call: vi.fn().mockResolvedValue({ platform_message_id: 'm1', sent_at: '2026-05-12T00:00:00Z' }) } as any,
      moduleId: 'test',
      getAdminPort: () => 19001,
      resolveChannelPort: async () => 19010,
    })
    const tools = (server as any).getTools?.() ?? (server as any).tools ?? []
    const sendMessage = tools.find((t: any) => t.name === 'send_message')
    expect(sendMessage).toBeDefined()
    // intent 是 optional 的 z.enum
    expect(sendMessage.schema.intent).toBeDefined()
    // 可以自适配 server 的实际 API
  })
})
```

如该测试因 server export 方式不便而难以写，可改在 worker-handler 集成测试里覆盖（Task 6）。**优先确保 schema 改动本身通过 typecheck。**

- [ ] **Step 3: 跑 typecheck + 测试**

Run: `cd crabot-agent && npx tsc --noEmit && npx vitest run tests/mcp/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add crabot-agent/src/mcp/crab-messaging.ts crabot-agent/tests/mcp/crab-messaging-send-message-intent.test.ts
git commit -m "feat(agent/mcp): send_message 加 intent 字段（normal/ask_human），为统一发消息通道铺路"
```

---

## Task 5: progress-digest 识别 intent=ask_human

**Files:**
- Modify: `crabot-agent/src/engine/progress-digest.ts:94-105`
- Test: 在该文件已有测试里加 case

- [ ] **Step 1: 先看现有测试，定位写新 case 的位置**

Run: `grep -l "ask_human" crabot-agent/tests/`
找到 progress-digest 相关测试文件（若无，跳过单测、靠后续集成测试覆盖）。

- [ ] **Step 2: 改实现**

```typescript
// crabot-agent/src/engine/progress-digest.ts:94-105 附近
// 原来：
// if (event.toolCalls.some(tc => tc.name === 'mcp__crabot-worker__ask_human')) {
// 改为：
const isAskHuman = (tc: { name: string; input?: unknown }): boolean => {
  if (tc.name === 'mcp__crabot-worker__ask_human') return true  // 旧 ask_human 工具仍支持（Task 9 删）
  if (tc.name === 'mcp__crab-messaging__send_message' || tc.name === 'send_message') {
    const input = tc.input as { intent?: string } | undefined
    return input?.intent === 'ask_human'
  }
  return false
}
if (event.toolCalls.some(isAskHuman)) {
  // Immediate flush only on ask_human (interactive — user must see the question now).
  // ...
}
```

- [ ] **Step 3: 加单测**

新建 `crabot-agent/tests/engine/progress-digest-ask-human-intent.test.ts`：

```typescript
import { describe, it, expect, vi } from 'vitest'
import { ProgressDigest } from '../../src/engine/progress-digest.js'

describe('progress-digest: ask_human intent 触发立即 flush', () => {
  it('send_message + intent=ask_human 触发立即 flush', async () => {
    const flushSpy = vi.fn()
    const digest = new ProgressDigest({ adapter: {} as any, model: 'm', onFlush: flushSpy })
    digest.observe({
      turnNumber: 1,
      assistantText: '',
      toolCalls: [{
        id: 't1', name: 'mcp__crab-messaging__send_message',
        input: { content: '需要 A 还是 B？', intent: 'ask_human' },
        output: '', isError: false,
      }],
      stopReason: 'tool_use',
      llmCallMs: 100,
    })
    // 假设 immediate-flush 是同步的；如是异步，await 一下
    await new Promise(r => setTimeout(r, 10))
    expect(flushSpy).toHaveBeenCalled()
  })

  it('send_message + intent=normal 不触发立即 flush', () => {
    const flushSpy = vi.fn()
    const digest = new ProgressDigest({ adapter: {} as any, model: 'm', onFlush: flushSpy })
    digest.observe({
      turnNumber: 1,
      assistantText: '',
      toolCalls: [{
        id: 't1', name: 'mcp__crab-messaging__send_message',
        input: { content: 'ack', intent: 'normal' },
        output: '', isError: false,
      }],
      stopReason: 'tool_use',
      llmCallMs: 100,
    })
    expect(flushSpy).not.toHaveBeenCalled()
  })
})
```

> 如 ProgressDigest 构造函数不接受 `onFlush`，先 grep 它的实际 API 再调整测试。**核心约束：测试必须覆盖"intent=ask_human 触发即时 flush，intent=normal 不触发"。**

- [ ] **Step 4: 跑测试**

Run: `cd crabot-agent && npx vitest run tests/engine/progress-digest-ask-human-intent.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/engine/progress-digest.ts crabot-agent/tests/engine/progress-digest-ask-human-intent.test.ts
git commit -m "feat(agent/engine): progress-digest 识别 send_message intent=ask_human 触发即时 flush"
```

---

## Task 6: Worker handler finalize 编排

**Files:**
- Modify: `crabot-agent/src/agent/worker-handler.ts:990-1066`（executeTask 出口 + mapEngineResult）
- Modify: `crabot-agent/src/agent/worker-handler.ts:439-1027`（注入 admin RPC + reflector 依赖）
- Test: `crabot-agent/tests/agent/worker-handler-finalize.test.ts`

这是改动最大的 task。**核心流程：engine 主 loop 跑完 → 调 admin update_task_status('completed', { result: {outcome, finished_at} }) → dispose humanMessageQueue → 跑 reflector → 调 admin update_task_outcome 回填**。

- [ ] **Step 1: 加测试**

```typescript
// crabot-agent/tests/agent/worker-handler-finalize.test.ts
import { describe, it, expect, vi } from 'vitest'
import { WorkerHandler } from '../../src/agent/worker-handler.js'

// 该测试通过 mock RPC client + mock engine runner 验证 finalize 链路调用顺序

describe('Worker finalize 编排', () => {
  it('engine 主 loop end_turn 后：先 update_task_status(completed) → dispose queue → 跑 reflector → update_task_outcome', async () => {
    const calls: string[] = []
    const rpcClient = {
      call: vi.fn(async (port: number, method: string, params: any) => {
        calls.push(`${method}:${JSON.stringify(params).slice(0, 80)}`)
        if (method === 'update_task_status') return { task: { id: params.task_id, status: params.status } }
        if (method === 'update_task_outcome') return { task: { id: params.task_id, result: params } }
        return {}
      }),
    } as any

    const reflectMock = vi.fn().mockResolvedValue({
      outcome_brief: '完成 X',
      process_highlights: ['亮点 1'],
      retries: 0,
      fellBackToLastText: false,
    })

    // 创建 worker handler，注入 mock engine 跑完直接 end_turn + 提供 lastAssistantText
    // 具体 hook 方式：在 Task 6 实现时 export 一个 finalizeTask 内部函数让单测可调
    // （或用 dependency injection）
    // ...

    // 验证 calls 顺序
    expect(calls.findIndex(c => c.startsWith('update_task_status:'))).toBeLessThan(
      calls.findIndex(c => c.startsWith('update_task_outcome:'))
    )
    expect(reflectMock).toHaveBeenCalled()
    // dispose 通过 spy worker handler 内部 humanQueues map 验证
  })

  it('reflector 失败 fallback：仍然调 update_task_outcome 写 fallback 内容', async () => {
    // ...
  })

  it('群聊任务跳过 forced reply 兜底（但仍跑 reflector）', async () => {
    // ...
  })
})
```

> 测试细节：worker-handler 内部 finalize 编排实现时把"调 admin / 调 reflector"的接缝暴露成可注入的依赖（reflectFn?: typeof reflectStructuredOutcome），方便测试。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/agent/worker-handler-finalize.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 finalize 编排**

在 `crabot-agent/src/agent/worker-handler.ts` 加一个私有方法：

```typescript
// 加在 mapEngineResult 之前
/**
 * Engine 主 loop 结束后的收尾。对用户面"任务结束"瞬间 = update_task_status('completed')
 * 落盘那一刻。补轮反思跑在 task 已 completed 之后，对 Front/supplement 通道关闭。
 *
 * 失败容忍：reflector 任一步抛错都不回滚 task 状态——用户视角下任务已完成，
 * lesson 质量降级是可接受的二阶损失。
 */
private async finalizeTask(
  task: TaskParams,
  context: WorkerAgentContext,
  engineResult: EngineResult,
  messages: readonly EngineMessage[],
): Promise<void> {
  const adminPort = await this.deps.getAdminPort()
  const finalStatus = engineResult.outcome === 'failed' ? 'failed' : 'completed'
  const finishedAt = new Date().toISOString()

  // 1. 立即标 task 完成，关闭 supplement 通道
  try {
    await this.deps.rpcClient.call(
      adminPort, 'update_task_status',
      {
        task_id: task.task_id,
        status: finalStatus,
        result: { outcome: finalStatus, finished_at: finishedAt },
      },
      this.deps.moduleId,
    )
  } catch (err) {
    log(`finalize: update_task_status failed (continuing): ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. dispose humanMessageQueue（finalize 阶段不再接受 supplement）
  const humanQueue = this.humanQueues.get(task.task_id)
  if (humanQueue) {
    humanQueue.drainPending()  // 清掉残留
    humanQueue.clearBarrier()
    // dispose 本身——队列对象的引用在 finally 块的 humanQueues.delete 中释放
  }

  // 3. 跑反思补轮
  try {
    const reflectFn = this.deps.reflectFn ?? reflectStructuredOutcome
    const reflection = await reflectFn({
      messages,
      adapter: adapterFromSdkEnv(this.sdkEnv),
      model: this.sdkEnv.modelId,
      lastAssistantText: engineResult.finalText,
    })

    // 4. 回填 outcome_brief / process_highlights
    await this.deps.rpcClient.call(
      adminPort, 'update_task_outcome',
      {
        task_id: task.task_id,
        outcome_brief: reflection.outcome_brief,
        process_highlights: reflection.process_highlights,
      },
      this.deps.moduleId,
    )
    log(`finalize: reflection written (retries=${reflection.retries}, fallback=${reflection.fellBackToLastText})`)
  } catch (err) {
    log(`finalize: reflection failed (continuing without outcome_brief): ${err instanceof Error ? err.message : String(err)}`)
  }
}
```

executeTask 出口改造：原本在 `mapEngineResult` 之前已经走完 engine，把 `await this.finalizeTask(...)` 加在 mapEngineResult 之前调用。**注意：messages 数组需要从 engine 内部暴露出来（修改 EngineResult 或 onTurn 累积）。**

最简单的暴露方式：让 `runEngine` 返回 `finalMessages: readonly EngineMessage[]` 字段，跟 `finalText` 平级。改 `crabot-agent/src/engine/types.ts:255` 的 `EngineResult` 加该字段，改 `query-loop.ts:402-417` 的 `buildResult` 接受并透出。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/agent/worker-handler-finalize.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/agent/worker-handler.ts crabot-agent/src/engine/query-loop.ts crabot-agent/src/engine/types.ts crabot-agent/tests/agent/worker-handler-finalize.test.ts
git commit -m "feat(agent/worker): end_turn 后立即 update_task_status(completed) + 跑 reflector 补轮 + update_task_outcome 回填"
```

---

## Task 7: end_turn 收口前再检查 humanMessageQueue

**Files:**
- Modify: `crabot-agent/src/engine/query-loop.ts:168-216`
- Test: `crabot-agent/tests/engine/query-loop-end-turn-supplement.test.ts`

防止用户在 LLM 输出最后一轮和 finalize 落盘之间的微秒级窗口内发的 supplement 被吞掉。

- [ ] **Step 1: 写失败测试**

```typescript
// crabot-agent/tests/engine/query-loop-end-turn-supplement.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runEngine } from '../../src/engine/query-loop.js'
import { HumanMessageQueue } from '../../src/engine/human-message-queue.js'

describe('query-loop: end_turn 收口前再 check humanMessageQueue', () => {
  it('end_turn 前 humanMessageQueue 有 pending → 不结束，注入为 user message 续 loop', async () => {
    const queue = new HumanMessageQueue()
    queue.push('用户突然纠偏：先做 X')
    const adapter = {
      complete: vi.fn()
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: '我准备结束了' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: '收到，改做 X' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    } as any

    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: {
        humanMessageQueue: queue,
        tools: [],
        systemPrompt: '',
        model: 'test',
      },
    })

    // 两次 LLM 调用：第一次 end_turn 但被 supplement 截胡，第二次才真正结束
    expect(adapter.complete).toHaveBeenCalledTimes(2)
    expect(result.outcome).toBe('completed')
    expect(result.finalText).toBe('收到，改做 X')
    expect(queue.hasPending).toBe(false)
  })

  it('end_turn 时 humanMessageQueue 无 pending → 正常结束', async () => {
    const queue = new HumanMessageQueue()
    const adapter = {
      complete: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '结束' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    } as any
    const result = await runEngine({
      prompt: 'test',
      adapter,
      options: { humanMessageQueue: queue, tools: [], systemPrompt: '', model: 'test' },
    })
    expect(adapter.complete).toHaveBeenCalledTimes(1)
    expect(result.finalText).toBe('结束')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/engine/query-loop-end-turn-supplement.test.ts`
Expected: FAIL（第一个 case fail）

- [ ] **Step 3: 改实现**

在 `crabot-agent/src/engine/query-loop.ts:168` 附近，stop_reason !== 'tool_use' 分支的早期插入 supplement check：

```typescript
if (stopReason !== 'tool_use') {
  // end_turn 收口前最后一次 supplement check：防止 LLM end_turn 与 finalize 落盘之间
  // 的微秒级窗口窃听不到 supplement。
  if (options.humanMessageQueue?.hasPending) {
    const supplements = options.humanMessageQueue.drainPending()
    for (const content of supplements) {
      messages.push(createUserMessage(content))
    }
    // 不要 fire onTurn——本轮 LLM 输出已 push 进 messages，下次循环会重新让 LLM 看
    continue
  }

  // --- Stop hook ---
  // ... 原代码
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/engine/query-loop-end-turn-supplement.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/engine/query-loop.ts crabot-agent/tests/engine/query-loop-end-turn-supplement.test.ts
git commit -m "fix(agent/engine): end_turn 收口前再 check humanMessageQueue 避免最后一刻 supplement 漏掉"
```

---

## Task 8: Worker prompt 改写

**Files:**
- Modify: `crabot-agent/src/prompt-manager.ts:257-509` 的相关段落
- Test: 在 `crabot-agent/tests/` 加 prompt 结构断言

- [ ] **Step 1: 写测试断言旧契约块段已删、新说明已加**

```typescript
// crabot-agent/tests/prompt-manager-worker-rules.test.ts
import { describe, it, expect } from 'vitest'
import { WORKER_RULES } from '../src/prompt-manager.js'  // 或对应 export 路径

describe('Worker prompt 改造（finalize redesign）', () => {
  it('不再包含 "末尾必填 JSON 块" 契约段', () => {
    expect(WORKER_RULES).not.toMatch(/最终回复的【最后一段】，必须是一个 fenced JSON 块/)
    expect(WORKER_RULES).not.toMatch(/process_highlights 是干什么的/)
  })

  it('删除"完成任务后直接输出最终结果；结果会自动回复给用户"段落', () => {
    expect(WORKER_RULES).not.toMatch(/结果会自动回复给用户.*不需要额外调用 send_message/)
  })

  it('删除"已发送的即时回复"提示行', () => {
    expect(WORKER_RULES).not.toMatch(/已发送的即时回复/)
  })

  it('包含新的"自己 send_message 给用户"说明', () => {
    expect(WORKER_RULES).toMatch(/send_message/)
    expect(WORKER_RULES).toMatch(/intent=ask_human|intent="ask_human"|intent: 'ask_human'/)
  })

  it('包含"任务结束后会要求反思总结"说明', () => {
    expect(WORKER_RULES).toMatch(/反思|总结|结束后/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd crabot-agent && npx vitest run tests/prompt-manager-worker-rules.test.ts`
Expected: FAIL（部分断言失败）

- [ ] **Step 3: 改 prompt**

`crabot-agent/src/prompt-manager.ts`：

- 删除 `:472` "完成任务后直接输出最终结果；结果会自动回复给用户" 整行
- 删除 `:473` "如果上方标注了'已发送的即时回复'，说明你已经向用户确认过了，不要再说类似的话，直接开始工作" 整行
- 删除 `:477-509` "任务结束的结构化输出（必填）" 整段（含 JSON 示例和硬约束）
- 在 `:469-475` 报告输出规范中加入新段落：

```
### 给用户发回复的方式

完成任务（或需要中间汇报）时调 `send_message` 工具：
- `intent="normal"`（默认）：发完继续后续工具调用 / 收尾，不等回应
- `intent="ask_human"`：发后阻塞等待人类回答。**只有真的需要等回答才能继续**才用，
  能自己决策的不要 ask。

最终交付报告也走 send_message，发完后正常 end_turn 即可。系统会在你 end_turn 后再
要求你做一次结构化反思（输出 outcome_brief + process_highlights），这份反思进入跨
session 长期记忆 —— 那时再总结，不要提前在最终回复里塞 JSON。
```

- 改 ask_human 工具引用的描述（`:257, :271, :290, :357`）：把 "`ask_human`" 改为 "`send_message(intent='ask_human')`"

- [ ] **Step 4: 跑测试确认通过**

Run: `cd crabot-agent && npx vitest run tests/prompt-manager-worker-rules.test.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/prompt-manager.ts crabot-agent/tests/prompt-manager-worker-rules.test.ts
git commit -m "refactor(agent/prompt): 删 worker 末尾 JSON 契约块；改 send_message 主动调用；ask_human → send_message(intent=ask_human)"
```

---

## Task 9: 删除 ask_human built-in tool

**Files:**
- Modify: `crabot-agent/src/agent/worker-handler.ts:491-519`（删除 tool 定义）
- Modify: `crabot-agent/src/engine/progress-digest.ts:94-105`（删除旧 ask_human 工具名匹配，只剩 intent=ask_human）

- [ ] **Step 1: 检查所有 ask_human 引用**

Run: `cd crabot-agent && grep -rn "ask_human\|mcp__crabot-worker__ask_human" src/ tests/ | grep -v "prompt-manager"`

记下还有引用的位置（应该只剩 worker-handler.ts 和 progress-digest.ts）。

- [ ] **Step 2: 删 worker-handler.ts:491-519 的 ask_human tool 定义**

直接删除 `tools.push(defineTool({ name: 'mcp__crabot-worker__ask_human', ... }))` 整段。

- [ ] **Step 3: 改 progress-digest.ts，去掉旧工具名匹配**

```typescript
// crabot-agent/src/engine/progress-digest.ts
const isAskHuman = (tc: { name: string; input?: unknown }): boolean => {
  if (tc.name === 'mcp__crab-messaging__send_message' || tc.name === 'send_message') {
    const input = tc.input as { intent?: string } | undefined
    return input?.intent === 'ask_human'
  }
  return false
}
```

- [ ] **Step 4: 跑全套 worker tests，确认无遗漏引用**

Run: `cd crabot-agent && npx vitest run tests/agent/ tests/engine/`
Expected: 全部 pass

- [ ] **Step 5: Commit**

```bash
git add crabot-agent/src/agent/worker-handler.ts crabot-agent/src/engine/progress-digest.ts
git commit -m "refactor(agent): 删除 ask_human built-in 工具，行为统一到 send_message(intent=ask_human)"
```

---

## Task 10: Dispatcher 清理 + 删除 task-outcome-parser

**Files:**
- Modify: `crabot-agent/src/orchestration/decision-dispatcher.ts:404-457, 540-582, 683-718`
- Delete: `crabot-agent/src/orchestration/task-outcome-parser.ts`
- Delete: `crabot-agent/tests/orchestration/task-outcome-parser.test.ts`
- Modify: `crabot-agent/src/types.ts:664-672`（ExecuteTaskResult 删 summary + final_reply）

- [ ] **Step 1: 改 ExecuteTaskResult 类型**

```typescript
// crabot-agent/src/types.ts:664
export interface ExecuteTaskResult {
  task_id: TaskId
  outcome: 'completed' | 'failed'
  /** 失败时填，描述错误。 worker 完成的具体内容已通过 send_message 发出 +
   *  通过 update_task_outcome 写入 admin task.result，dispatcher 不再消费 summary/final_reply。 */
  error?: string
}
```

- [ ] **Step 2: 改 worker-handler mapEngineResult**

```typescript
// crabot-agent/src/agent/worker-handler.ts:1049-1066
private mapEngineResult(taskId: TaskId, result: EngineResult): ExecuteTaskResult {
  if (result.outcome === 'aborted') {
    return { task_id: taskId, outcome: 'failed', error: '任务被取消' }
  }
  if (result.outcome === 'failed') {
    return { task_id: taskId, outcome: 'failed', error: result.error ?? 'unknown' }
  }
  return { task_id: taskId, outcome: 'completed' }
}
```

- [ ] **Step 3: 改 decision-dispatcher.ts**

删除以下代码块：

- `:404` 的 `const outcome = extractTaskOutcome(result.summary, 200)`
- `:421-425` 的 `if (result.final_reply?.text) { await this.sendReplyToUser(...) }`
- `:683-718` 的 `sendReplyToUser` 整个方法
- 删除 `import { extractTaskOutcome } from './task-outcome-parser.js'`

`finalizeTaskMemory` 改为接受 outcome_brief / process_highlights 直接传入（不再 extractTaskOutcome）：

```typescript
// finalizeTaskMemory 调用点：从 admin 拉 task.result 后传入
const task = await this.rpcClient.call<{task_id: string}, {task: AdminTask}>(
  adminPort, 'get_task', { task_id: task.id }, this.moduleId,
)
this.finalizeTaskMemory({
  taskId: task.task.id,
  taskTitle: task.task.title,
  outcome: task.task.result?.outcome ?? 'failed',
  outcomeBrief: task.task.result?.outcome_brief ?? '',
  processHighlights: task.task.result?.process_highlights ?? [],
  detailContent: task.task.result?.outcome_brief ?? '',  // long-term lesson content
  // ...
})
```

由于 update_task_outcome 是 worker handler 在 finalize 中调的，dispatcher 调 get_task 时应该已经有数据。但**有竞争**：dispatcher 的 finalizeTaskMemory 调用时机若早于 worker handler 的 update_task_outcome 落盘，会拿空字段。

**解决**：把 finalizeTaskMemory 整段从 dispatcher 移到 worker handler 的 finalizeTask 里，紧跟在 update_task_outcome 之后调用。dispatcher 只负责派任务，不再管完成后的 memory write。

- [ ] **Step 4: 删除 task-outcome-parser 文件 + 测试**

```bash
rm crabot-agent/src/orchestration/task-outcome-parser.ts
rm crabot-agent/tests/orchestration/task-outcome-parser.test.ts
```

- [ ] **Step 5: 跑全套 agent 测试**

Run: `cd crabot-agent && npx vitest run`
Expected: all pass（去掉的 parser 测试是预期消失，其他全过）

- [ ] **Step 6: 跑 typecheck**

Run: `cd crabot-agent && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(agent/orchestration): 删 sendReplyToUser + task-outcome-parser，finalizeTaskMemory 移入 worker handler"
```

---

## Task 11: 端到端手动验证

不能光靠单元测试，必须实际跑一次 task 看完整链路。

- [ ] **Step 1: 重启开发环境**

Run: `cd /Users/fufu/codes/playground/crabot && ./dev.sh stop && ./dev.sh`

等待 `Admin module started successfully` + `Agent module ready` 在 logs 里出现。

- [ ] **Step 2: 在 Telegram 发一个简单任务**

发送：「写一段代码计算 1+1，告诉我结果」

- [ ] **Step 3: 验证用户收到的内容**

Telegram 应该收到：
- Front 的 ack（"收到，去做" 类似）
- Worker 自己 send_message 发的最终结果（"1+1=2" 类似）

不应该看到：
- 任何 ```json {...}``` 契约块
- 空消息（"..."）

- [ ] **Step 4: 验证 admin task.result 字段**

Run:
```bash
TOKEN=$(cat data/admin/internal-token)
curl -s -X POST http://127.0.0.1:19001/list_tasks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"q","params":{"filter":{"status":"completed"},"limit":1}}' | python3 -m json.tool
```

确认最新任务的 `result.outcome_brief` 和 `result.process_highlights` 字段都有值。

- [ ] **Step 5: 验证 trace 里的 send_message 调用**

Run: `node scripts/debug-agent.mjs trace`

确认最新 trace 里有 worker 主动调 `mcp__crab-messaging__send_message` 的 span。

- [ ] **Step 6: 验证短期记忆**

Front 处理下一条 message 时，context 里应该出现 "任务 XXX（标题）完成：<outcome_brief>"。

- [ ] **Step 7: 如果上述全部通过 → 写本次改动的 PROGRESS.md 更新条目**

```bash
git add PROGRESS.md
git commit -m "docs: 记录 worker task finalize redesign 已上线"
```

---

## Self-Review

**1. Spec coverage**
- 用户面 0 chars 事故的根因 → Task 10 删除（task-outcome-parser 整个被废）✓
- send_message 加 intent 替代 ask_human → Task 4 + Task 9 ✓
- engine 控制的反思补轮 → Task 3 + Task 6 ✓
- task=completed 时刻明确为 LLM end_turn → Task 6 ✓
- supplement 通道在 finalize 阶段关闭 → Task 6 (dispose queue) ✓
- end_turn 微秒级 supplement 兜底 → Task 7 ✓
- 群聊 / 巡检任务的特殊处理 → Task 6 测试 case 覆盖；prompt 不改硬约束（巡检任务允许不发 final reply）✓
- 第 1 步已落地的 task-outcome-parser 空兜底 → Task 10 整个文件删除（不影响因为 parser 已废）✓
- 自我进化 / 长期记忆 lesson 质量 → Task 3 (reflector 输出) + Task 6 (memory_writer.quickCapture 入参从 outcome_brief 拿) ✓

**2. Placeholder scan**
- 无 "TBD" / "implement later" / "similar to Task N" 残留 ✓
- 每个 Step 都给出代码或确切命令 ✓
- Task 6 step 1 的测试有些 placeholder（`// ...`），但已说明"具体 hook 方式在实现时确定"——这是因为 worker-handler 是大文件，实现时需要根据现有结构注入 mock。**建议执行者把"3 个 it 写完整 case"作为 Task 6 完成标志，而不是只通过 1 个**。

**3. Type 一致性**
- TaskResult.outcome_brief（T1）与 reflector ReflectResult.outcome_brief（T3）与 update_task_outcome params（T2）字段名 all 对齐 ✓
- ExecuteTaskResult.error（T10）替代旧 summary/final_reply，dispatcher 不再消费 ✓
- send_message intent 在 schema（T4）、progress-digest（T5）、prompt（T8）、worker-handler 删 tool（T9）一致使用字符串 `'ask_human'` ✓

---

## Execution Handoff

**Plan complete and saved to `crabot-agent/docs/plans/2026-05-12-worker-task-finalize-redesign.md`.** 两种执行模式：

1. **Subagent-Driven (recommended)**：每个 task 派一个独立 subagent 实现，中间做 review。改动跨多模块（admin + agent + crab-messaging），subagent 隔离防止 context 串扰，且能并行做无依赖 task（如 T4 + T5 + T7 可并行）。

2. **Inline Execution**：在本 session 顺序跑 batch，每 2-3 个 task 一个 checkpoint。改动量较大（10 个 task），inline 会让 context 涨得很快。

**推荐 Subagent-Driven。哪个？**
