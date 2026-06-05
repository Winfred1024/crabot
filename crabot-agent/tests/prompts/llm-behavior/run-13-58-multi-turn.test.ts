/**
 * Multi-turn LLM 行为测试：13:58 现场完整后续追踪。
 *
 * 跟单轮版（run-13-58-scene.test.ts）的区别：本 case 跑完整 turn loop，工具调用
 * 用 fixture 回灌真实结果，看 agent 拿到搜索结果后会不会：
 *  - 正确定位到 trigger-66f2 (failed)
 *  - 继续调 get_task_details / search_traces 追细节
 *  - 最终如实告诉用户"那条任务 OOM 死了"而不是凭印象编
 *
 * 默认 skip（CRABOT_LLM_BEHAVIOR_TEST=1 才跑），消耗 API token + 依赖 admin config。
 */

import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import OpenAI from 'openai'
import { assembleAgentPrompt } from '../../../src/prompts/assemble-agent'
import { renderActiveTasksSection } from '../../../src/agent/active-tasks-section'
import type { TaskSummary, TaskId } from '../../../src/types'
import { runMultiTurn, formatRunResult, type ToolHandler } from './multi-turn-runner'

const SHOULD_RUN = process.env.CRABOT_LLM_BEHAVIOR_TEST === '1'

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

const CRABOT_ROOT = process.env.CRABOT_ROOT || resolve(__dirname, '../../../../..')
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
  if (!provider) throw new Error(`默认 provider ${providerId} 不存在`)
  return { provider, model: globalCfg.default_llm_model_id }
}

// ---------------------------------------------------------------------------
// 13:58 现场 fixture
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-02T05:58:00.000Z')

const FIXTURE_ACTIVE_TASKS: TaskSummary[] = [
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
// Tool schemas (跟 search_memory / search_traces / get_task_details 实际工具 description 对齐)
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
          query: { type: 'string' },
          level: { type: 'string', enum: ['short_term', 'long_term'] },
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
          time_range: { type: 'object', properties: { start: { type: 'string' }, end: { type: 'string' } } },
          status: { type: 'string', enum: ['running', 'completed', 'failed'] },
          include_spans: { type: 'boolean' },
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
  {
    type: 'function',
    function: {
      name: 'set_task_goal',
      description: '写下当前任务的完成承诺。复杂任务（≥2 步独立动作 / 跨多 turn）必须先调本工具。',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string' },
          acceptance_criteria: { type: 'array', items: { type: 'object' } },
          token_budget: { type: 'number' },
        },
        required: ['objective', 'acceptance_criteria'],
      },
    },
  },
]

// ---------------------------------------------------------------------------
// Tool handlers (fixture 回灌)
//
// 关键：search_memory 必须返回**含 trigger-66f2 锚点的记忆条目**，否则 agent
// 拿不到 task_id 没法继续追。这就是当时 OOM 后 agent 应该看到的真实事实。
// ---------------------------------------------------------------------------

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  search_memory: async (args) => {
    const level = args.level
    if (level !== 'short_term') {
      return {
        result: JSON.stringify({ results: [] }),
        isError: false,
      }
    }
    // 返回包含 trigger-66f2 锚点的短期记忆条目（模拟真 short_term 里有过的反思 / 状态条目）
    return {
      result: JSON.stringify({
        results: [
          {
            id: 'mem-s-9a3f',
            content:
              '2026-06-01 22:35Z agent 因 V8 堆 OOM 重启；重启前 in-flight 的 trigger-66f20e3d-00d6-4eb6-a99e-7f0a427c5d7b 任务（继续推进 quant-signal 全栈排查）被标 failed，error=agent_restarted_during_execution。worker trace 61f4bddf 落 [interrupted: agent restarted]。',
            event_time: '2026-06-01T22:35:05.218Z',
            source: { type: 'system', task_id: 'trigger-66f20e3d-00d6-4eb6-a99e-7f0a427c5d7b' },
            topic: 'agent restart / interrupted task',
          },
          {
            id: 'mem-s-9a40',
            content:
              '06:34 我在 trigger-66f20e3d 任务里把 quant-signal 全栈排查任务的完成承诺写下：三条 acceptance_criteria（L3 数据 / L2 优化 / L1 策略与回测），token_budget=120000。',
            event_time: '2026-06-02T06:34:10.232Z',
            source: { type: 'task_reflection', task_id: 'trigger-66f20e3d-00d6-4eb6-a99e-7f0a427c5d7b' },
            topic: 'task goal set',
          },
        ],
      }),
      isError: false,
    }
  },

  search_traces: async (args) => {
    const taskId = args.task_id as string | undefined
    if (taskId && taskId.includes('66f20e3d')) {
      return {
        result: JSON.stringify({
          trace_id: '61f4bddf-3ff3-403e-8efe-e88b64bd00d1',
          related_task_id: 'trigger-66f20e3d-00d6-4eb6-a99e-7f0a427c5d7b',
          status: 'failed',
          started_at: '2026-06-01T22:33:43.965Z',
          ended_at: '2026-06-01T22:35:01.890Z',
          outcome: { summary: '[interrupted: agent restarted]' },
          summary: '7 个 iter 跑到 iter=7（两个 Output 拉 bg shell 输出），iter=8 LLM 调用中 V8 OOM 自杀',
          last_progress: '已建 task goal（c-repo-audit/c-backtest-70/c-verification 三条），iter=4 拆 todo，iter=5 send_message 收到，iter=6 起两个 bg shell（cd quant-signal && find 等），iter=7 Output 拿目录列表，准备进入实际仓库审计但 agent 进程崩了',
        }),
        isError: false,
      }
    }
    return { result: JSON.stringify({ traces: [], total: 0 }), isError: false }
  },

  get_task_details: async (args) => {
    const taskId = args.task_id as string | undefined
    if (taskId && taskId.includes('66f20e3d')) {
      return {
        result: JSON.stringify({
          task: {
            id: 'trigger-66f20e3d-00d6-4eb6-a99e-7f0a427c5d7b',
            title: '继续推进 quant-signal 项目，从 L3的数据，到 L2 的优化，最后是 L1的策略...',
            status: 'failed',
            error: 'agent_restarted_during_execution',
            created_at: '2026-06-01T22:33:43.950Z',
            updated_at: '2026-06-01T22:35:05.218Z',
            started_at: '2026-06-01T22:33:43.960Z',
            messages: [],
            goal: {
              objective: '按 L3 数据 → L2 优化/信号 → L1 策略全面排查 quant-signal 当前不合理 / bug / 不可用点，目标 L1 回测 70%+',
              acceptance_criteria: [
                { id: 'c-repo-audit', kind: 'file', spec: 'reports/research/latest_full_stack_l3_l2_l1_audit.md' },
                { id: 'c-backtest-70', kind: 'semantic', spec: '每个标的 L1 回测 ≥70%' },
                { id: 'c-verification', kind: 'semantic', spec: '修改后必须有可重放验证' },
              ],
              status: 'active',
              token_budget: 120000,
              tokens_used: 0,
            },
          },
        }),
        isError: false,
      }
    }
    return { result: JSON.stringify({ error: `task ${taskId} not found` }), isError: true }
  },

  send_message: async (args) => {
    // 只记录、不做实际发送；harness 在 send_message 后停 loop（默认行为）
    return {
      result: JSON.stringify({
        platform_message_id: 'fake-' + Math.floor(Math.random() * 100000),
        sent_at: new Date().toISOString(),
      }),
      isError: false,
    }
  },

  set_task_goal: async (_args) => {
    return {
      result: 'set_task_goal: ok。你的承诺已写入 task.goal。',
      isError: false,
    }
  },
}

const SYSTEM_PROMPT = assembleAgentPrompt({ isGroup: false, goalModeEnabled: true })

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('Multi-turn LLM behavior: 13:58 quoted-message scene', () => {
  it('agent 完整链路：查记忆 → 锚定 trigger-66f2 → 查 trace/details → 如实汇报', { timeout: 300_000 }, async () => {
    const { provider, model } = loadLLMConfig()

    console.log('=== Provider ===')
    console.log(`name=${provider.name}  endpoint=${provider.endpoint}  format=${provider.format}  model=${model}\n`)

    if (provider.format !== 'openai' && provider.format !== 'gemini') {
      console.error(`本 harness 当前只支持 openai-compatible，跳过`)
      return
    }

    const client = new OpenAI({ apiKey: provider.api_key, baseURL: provider.endpoint })

    console.log('=== System prompt 长度 ===')
    console.log(`${SYSTEM_PROMPT.length} 字符`)
    console.log()

    console.log('=== Initial User Prompt ===')
    console.log(USER_PROMPT)
    console.log()

    console.log('=== 跑 multi-turn loop（max 10 轮，遇 send_message / 无 tool_call 自然停）===\n')

    const result = await runMultiTurn({
      client,
      model,
      systemPrompt: SYSTEM_PROMPT,
      initialUserPrompt: USER_PROMPT,
      tools: TOOLS,
      toolHandlers: TOOL_HANDLERS,
      maxTurns: 10,
      stopOnSendMessage: true,
    })

    console.log(formatRunResult(result))

    // 人工判读用 verdict
    console.log('=== Verdict (人工判读) ===')
    const calledSearchMemory = result.turns.some((t) =>
      t.toolCalls.some((tc) => tc.name === 'search_memory')
    )
    const foundOldTask = result.turns.some((t) =>
      t.toolCalls.some(
        (tc) =>
          (tc.name === 'search_traces' || tc.name === 'get_task_details') &&
          JSON.stringify(tc.args).includes('66f20e3d')
      )
    )
    const sentMessage = result.turns.some((t) => t.toolCalls.some((tc) => tc.name === 'send_message'))
    const finalUserMsg = result.turns
      .flatMap((t) => t.toolCalls.filter((tc) => tc.name === 'send_message'))
      .map((tc) => String(tc.args.content ?? ''))
      .pop()
    const mentionsFailedHonestly =
      finalUserMsg !== undefined &&
      (finalUserMsg.includes('failed') ||
        finalUserMsg.includes('中断') ||
        finalUserMsg.includes('OOM') ||
        finalUserMsg.includes('崩') ||
        finalUserMsg.includes('重启') ||
        finalUserMsg.includes('agent_restarted'))

    console.log(`✔ 调过 search_memory 吗？                        ${calledSearchMemory ? 'YES ✅' : 'NO ❌'}`)
    console.log(`✔ 通过 trigger-66f2 锚点继续追查吗？             ${foundOldTask ? 'YES ✅' : 'NO ❌'}`)
    console.log(`✔ 最终给用户发消息了吗？                          ${sentMessage ? 'YES ✅' : 'NO ❌'}`)
    console.log(`✔ 发的消息如实描述了"老任务 failed"事实吗？       ${mentionsFailedHonestly ? 'YES ✅' : 'NO ❌'}`)
    console.log()
    if (sentMessage && finalUserMsg) {
      console.log('=== 最终用户面消息 ===')
      console.log(finalUserMsg)
    }

    const totalTokens = result.turns.reduce((sum, t) => sum + (t.usage?.total ?? 0), 0)
    console.log(`\n=== 总消耗 ===`)
    console.log(`turns=${result.turns.length}  tokens=${totalTokens}`)
  })
})
