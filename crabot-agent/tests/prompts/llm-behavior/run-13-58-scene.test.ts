/**
 * LLM 行为测试：13:58 现场再现。
 *
 * 不依赖 crabot 运行实例，作为 vitest test 跑、纯 dump、无断言。流程：
 *   1. 读 admin/model_providers.json + global_model_config.json 拿默认 provider
 *   2. 用真实的 assembleAgentPrompt 拼 system prompt
 *   3. 用真实的 renderActiveTasksSection 拼活跃任务段（含 SELF marker + 历史提示）
 *   4. 手工拼一份完整 user prompt 复现 13:58 现场（recent_messages + quoted message）
 *   5. 列出 LLM 可调的关键工具（search_memory / search_traces / send_message / set_task_goal）
 *   6. 调一次 LLM，dump 所有 tool_calls + assistant text
 *
 * 跑法（在 crabot-agent 目录）：
 *   pnpm exec vitest run tests/prompts/llm-behavior/run-13-58-scene.ts --reporter=verbose
 *
 * 默认非 CI：测试套件每次跑全量时不会自动触发（vitest 默认会跑——但这测试要消耗
 * API token，且依赖 crabot data dir 配置存在；不在 fast-CI 里可以靠 testPathIgnorePatterns
 * 排除。本仓库目前没设排除，跑全套时会被一起拉起来——可考虑加 .skip 或 env gate）。
 */

import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import OpenAI from 'openai'
import { assembleAgentPrompt } from '../../../src/prompts/assemble-agent'
import { renderActiveTasksSection } from '../../../src/agent/active-tasks-section'
import type { TaskSummary, TaskId } from '../../../src/types'

// ---------------------------------------------------------------------------
// 1. 读 provider 配置
// ---------------------------------------------------------------------------

const CRABOT_ROOT = process.env.CRABOT_ROOT
  || resolve(__dirname, '../../../..')
const PROVIDERS_PATH = join(CRABOT_ROOT, 'data/admin/model_providers.json')
const GLOBAL_CFG_PATH = join(CRABOT_ROOT, 'data/admin/global_model_config.json')

interface Provider {
  id: string
  name: string
  format: string
  endpoint: string
  api_key: string
}

function loadLLMConfig(): { provider: Provider; model: string } {
  const providersRaw = JSON.parse(readFileSync(PROVIDERS_PATH, 'utf-8'))
  const providers: Provider[] = Array.isArray(providersRaw) ? providersRaw : providersRaw.providers
  const globalCfg = JSON.parse(readFileSync(GLOBAL_CFG_PATH, 'utf-8'))
  const providerId = globalCfg.default_llm_provider_id
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) throw new Error(`默认 provider ${providerId} 在 model_providers.json 里找不到`)
  return { provider, model: globalCfg.default_llm_model_id }
}

// ---------------------------------------------------------------------------
// 2. 构造 13:58 现场 fixture
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-02T05:58:00.000Z')  // UTC == 13:58 +08:00

const FIXTURE_ACTIVE_TASKS: TaskSummary[] = [
  // worker 自己正在跑的（13:57 用户引用消息后系统建出来的影子 task）
  {
    task_id: 'trigger-dc19' as TaskId,
    title: '继续推进 quant-signal 项目，从 L3的数据，到 L2 的优化，最后是 L1的策略...',
    status: 'executing',
    priority: 'normal',
    source_channel_id: 'telegram-001',
    source_session_id: 'session-A',
  },
]

const CURRENT_TASK_ID = 'trigger-dc19' as TaskId

const ACTIVE_TASKS_SECTION_LINES = renderActiveTasksSection({
  activeTasks: FIXTURE_ACTIVE_TASKS,
  currentTaskId: CURRENT_TASK_ID,
  currentChannel: 'telegram-001',
  currentSession: 'session-A',
  isMaster: true,
  timezone: 'Asia/Shanghai',
  now: NOW,
})

const USER_PROMPT = [
  '当前时间: 2026-06-02 周二 13:58:00 +08:00 (Asia/Shanghai)',
  '',
  '## 对话场景',
  '- 类型: 私聊',
  '- 对话对象: FuFu',
  '- 对话对象 ID: friend:e55b0cdc-d2d8-48c2-9df6-89886771f17e',
  '- 对话对象身份: master',
  '',
  '## IM 渠道',
  '- channel: telegram-001',
  '- session: session-A',
  '- 你在该渠道的昵称: Crabot',
  ...ACTIVE_TASKS_SECTION_LINES,
  '',
  '## 聊天历史（当前 session，最近 12 小时，4 条）',
  '06:33 FuFu: 继续推进 quant-signal 项目，从 L3的数据，到 L2 的优化，最后是 L1的策略，通通全过一遍，找出目前所有不合理/有 bug/不可用的点，并逐个解决。最终目标达到 L1的回测结果在所有标的上都达到70%以上',
  '06:34 Crabot: 我刚把 quant-signal 全栈排查任务明确成 L3 数据、L2 优化/信号、L1 策略与回测三条验收线，并要求产出可复查报告和实际验证结果。现在准备进入代码仓库做现状审计，下一步会先从数据链路和已有回测入口摸清当前失败点。',
  '13:56 FuFu: 你目前进度如何了？',
  '13:56 Crabot: 目前我这边没有正在执行中的任务。我刚检查了：1. 运行中的子任务：0 个 2. 后台进程：0 个 3. 今日仍在 running 的任务：0 个。今日已完成的主要自动任务：Serenity 媒体动态跟踪，已在 12:34 左右完成。',
  '',
  '## 当前消息',
  '13:58 FuFu: <quoted_message ts="06:33">继续推进 quant-signal 项目，从 L3的数据...</quoted_message> 这个呢',
  '',
  '## 行动提醒',
  '- 当前消息含 quoted_message。这通常意味着用户在指认 quoted 消息背后的某件事，要求你接着那件事继续。',
].join('\n')

// ---------------------------------------------------------------------------
// 3. 工具定义（精简版：列出关键工具的 description + schema）
// ---------------------------------------------------------------------------

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_memory',
      description: '搜索记忆。short_term=跨 session 事件流水账（每条自带 channel/session/task/trace 锚点）；long_term=认知知识库（事实/经验/概念）。【short_term 用途】未知 task_id/trace_id 时回溯历史事件的入口——任何需要回答"哪一次任务/事件 / 上一次怎么处理 / 之前为什么变成这样"的问题，先调本工具（level=short_term）拿锚点，再用 search_traces / get_task_details 取详情。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'FTS5 全文检索查询' },
          level: { type: 'string', enum: ['short_term', 'long_term'], description: 'short_term=事件流水账，long_term=知识库' },
          limit: { type: 'number' },
        },
        required: ['query', 'level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_traces',
      description: '已知 task_id 或 trace_id 时取过程详情：span 树、tool_call 序列、错误堆栈、执行流水。不要用 keyword 字段当作"找历史 task 用什么 ID"的关键词探路——召回率低。该场景应先调 search_memory(level=short_term) 拿锚点，再用本工具取详情。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          keyword: { type: 'string' },
          time_range: {
            type: 'object',
            properties: {
              start: { type: 'string' },
              end: { type: 'string' },
            },
          },
          status: { type: 'string', enum: ['running', 'completed', 'failed'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_details',
      description: '根据 task_id 拉任务详情：admin 端 status / messages / goal + 本地 trace 树。先决条件：已知 task_id（从 active_tasks 上下文段挑，或先 search_memory / search_traces 锚定）。',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: '给用户发消息。intent: ask=问问题，info=汇报/告知。仅在你确实有内容要给用户传达时调用。',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string' },
          session_id: { type: 'string' },
          content: { type: 'string' },
          intent: { type: 'string', enum: ['ask', 'info'] },
        },
        required: ['channel_id', 'session_id', 'content', 'intent'],
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 4. 拼 system prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = assembleAgentPrompt({
  isGroup: false,
  goalModeEnabled: true,
  adminPersonality: undefined,
})

// ---------------------------------------------------------------------------
// 5. 调 LLM
// ---------------------------------------------------------------------------

// 真 LLM 行为测试：默认 skip 避免污染 CI / 烧 token。
// 手动跑：CRABOT_LLM_BEHAVIOR_TEST=1 pnpm exec vitest run tests/prompts/llm-behavior/
const SHOULD_RUN = process.env.CRABOT_LLM_BEHAVIOR_TEST === '1'

describe.skipIf(!SHOULD_RUN)('LLM behavior: 13:58 quoted-message scene', () => {
  // 强 timeout：调真 LLM 可能慢
  it('agent 在新 prompt 下第一步该调 search_memory / search_traces 而不是凭印象答', { timeout: 120_000 }, async () => {
  const { provider, model } = loadLLMConfig()

  console.log('=== Provider ===')
  console.log(`name:     ${provider.name}`)
  console.log(`endpoint: ${provider.endpoint}`)
  console.log(`format:   ${provider.format}`)
  console.log(`model:    ${model}`)
  console.log()

  console.log('=== System Prompt (前 600 字符) ===')
  console.log(SYSTEM_PROMPT.slice(0, 600))
  console.log(`... [总长 ${SYSTEM_PROMPT.length} 字符]`)
  console.log()

  console.log('=== User Prompt ===')
  console.log(USER_PROMPT)
  console.log()

  if (provider.format !== 'openai' && provider.format !== 'gemini') {
    console.error(`本 harness 当前只支持 openai-compatible provider，当前 format=${provider.format}`)
    console.error('如要测 anthropic-format 请扩展 harness 用 @anthropic-ai/sdk')
    process.exit(1)
  }

  const client = new OpenAI({
    apiKey: provider.api_key,
    baseURL: provider.endpoint,
  })

  console.log('=== 调 LLM 中 ===')
  const startedAt = Date.now()
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ],
    tools: TOOLS,
    tool_choice: 'auto',
  })
  const elapsed = Date.now() - startedAt
  console.log(`耗时: ${elapsed}ms\n`)

  const msg = response.choices[0].message

  console.log('=== Tool Calls (按调用顺序) ===')
  const toolCalls = msg.tool_calls ?? []
  if (toolCalls.length === 0) {
    console.log('(无 tool_call —— LLM 直接给文本回答了)')
  } else {
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      if (tc.type !== 'function') continue
      console.log(`[${i + 1}] ${tc.function.name}`)
      try {
        const args = JSON.parse(tc.function.arguments)
        console.log(`    args: ${JSON.stringify(args, null, 2).split('\n').map((l, idx) => idx === 0 ? l : '    ' + l).join('\n')}`)
      } catch {
        console.log(`    args: ${tc.function.arguments}`)
      }
    }
  }
  console.log()

  console.log('=== Assistant Text ===')
  console.log(msg.content ?? '(空)')
  console.log()

  console.log('=== Verdict (人工判读用) ===')
  const calledSearch = toolCalls.some((t) =>
    t.type === 'function' && (t.function.name === 'search_memory' || t.function.name === 'search_traces')
  )
  const calledSendDirectly = toolCalls.some(
    (t) => t.type === 'function' && t.function.name === 'send_message'
  ) && !calledSearch
  console.log(`✔ 调了 search_memory / search_traces 吗？  ${calledSearch ? 'YES ✅' : 'NO ❌'}`)
  console.log(`✘ 没查就 send_message 凭印象回答了吗？      ${calledSendDirectly ? 'YES ❌' : 'NO ✅'}`)
  console.log()

  console.log('=== Usage ===')
  if (response.usage) {
    console.log(`prompt:     ${response.usage.prompt_tokens}`)
    console.log(`completion: ${response.usage.completion_tokens}`)
    console.log(`total:      ${response.usage.total_tokens}`)
  }
  })
})
