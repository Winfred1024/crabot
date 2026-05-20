#!/usr/bin/env node
// scripts/replay-dispatcher.mjs
//
// 用系统默认 LLM 重跑历史上 supplement_fallback 的 dispatcher 场景，
// 验证三层修复（prompt 裁剪 + schema 白名单 retry + executor fallback 降级）是否生效。
//
// 用法：node scripts/replay-dispatcher.mjs [trace_prefix ...]
//        默认跑下面 SAMPLE_PREFIXES 这组。
//
// 输出每个案例：
//   - 原 trace 当时的 LLM 输出（编的 target_task_id）
//   - 现在跑的 dispatcher actions[0] 是什么 kind
//   - retry 次数（>0 表示 schema 白名单拦下了 LLM 第一轮的编造）
//   - 是否符合预期（actions[0].kind === 'new_task'）
//
// 简化假设：所有 case activeTasks=[]——这正是当时编 task_id 的核心场景。

import fs from 'node:fs'
import path from 'node:path'
import { dispatch } from '../crabot-agent/dist/dispatcher/dispatcher.js'
import { createAdapter } from '../crabot-agent/dist/engine/llm-adapter.js'

// ── 默认要 replay 的 trace 前缀（覆盖 6 种典型情形）──
const SAMPLE_PREFIXES = [
  'db206eaf',  // 用户最初报告：群聊新问题，空 activeTasks → LLM 编 trigger-75c330f8
  '9fa74908',  // 同一虚假 task_id 第二次：第二次跟进，依然编一样的
  'a726b72d',  // 短文本 "改完上线了"：被错判为 supplement，编 trigger-c8937d72
  '8f54f6fb',  // 典型新问题 "服务器安装Meilisearch够用吗" 被错判
  'e413b725',  // 群聊 PDF + @：媒体 + mention，编了不同 task_id
  'de0957af',  // "好，那我自己下载了传服务器" 看起来像 supplement 但 task 不存在
]

const argPrefixes = process.argv.slice(2)
const TRACE_PREFIXES = argPrefixes.length > 0 ? argPrefixes : SAMPLE_PREFIXES

// ── 拿默认 provider + model ──
const globalConfig = JSON.parse(
  fs.readFileSync('/Users/fufu/codes/playground/crabot/data/admin/global_model_config.json', 'utf8'),
)
const defaultProviderId = globalConfig.default_llm_provider_id
const defaultModelId = globalConfig.default_llm_model_id
if (!defaultProviderId || !defaultModelId) {
  console.error('[replay] global_model_config.json 缺 default_llm_provider_id / default_llm_model_id')
  process.exit(1)
}

const providersData = JSON.parse(
  fs.readFileSync('/Users/fufu/codes/playground/crabot/data/admin/model_providers.json', 'utf8'),
)
const providers = Array.isArray(providersData) ? providersData : Object.values(providersData)
const provider = providers.find(p => p?.id === defaultProviderId)
if (!provider) {
  console.error(`[replay] provider ${defaultProviderId} not found`)
  process.exit(1)
}
const model = provider.models?.find(m => m.model_id === defaultModelId)
if (!model) {
  console.error(`[replay] model ${defaultModelId} not in provider ${provider.name}`)
  process.exit(1)
}

console.log(`[replay] provider=${provider.name} (${provider.format}) endpoint=${provider.endpoint}`)
console.log(`[replay] model=${defaultModelId}\n`)

const adapter = createAdapter({
  format: provider.format,
  endpoint: provider.endpoint,
  apikey: provider.api_key,
})

// ── 拉 trace 数据 ──
const traceDir = '/Users/fufu/codes/playground/crabot/data/agent/traces'
const traceByPrefix = new Map()
for (const f of fs.readdirSync(traceDir).sort()) {
  if (!f.endsWith('.jsonl')) continue
  for (const line of fs.readFileSync(path.join(traceDir, f), 'utf8').split('\n').filter(Boolean)) {
    const t = JSON.parse(line)
    const tid = t.trace_id ?? ''
    const matched = TRACE_PREFIXES.find(p => tid.startsWith(p))
    if (matched && !traceByPrefix.has(matched)) traceByPrefix.set(matched, t)
  }
}

// ── replay helpers ──
function extractDispatchContextFromTrace(trace) {
  // 从 trace 抽 messages / sessionType
  const ctxSpan = trace.spans?.find(s => s.type === 'context_assembly')
  const ctx = ctxSpan?.details ?? {}
  const batch = ctx.message_batch ?? []
  const sessionType = trace.trigger?.summary?.startsWith('[group') ? 'group' : 'private'
  const channelId = ctx.channel_id ?? 'replay-channel'
  const sessionId = ctx.session_id ?? 'replay-session'

  const messages = batch.map((m, i) => ({
    platform_message_id: `replay-msg-${i}`,
    session: { session_id: sessionId, channel_id: channelId, type: sessionType },
    sender: {
      friend_id: 'replay-friend',
      platform_user_id: 'replay-user',
      platform_display_name: m.sender ?? 'someone',
    },
    content: { type: 'text', text: m.text ?? '' },
    features: { is_mention_crab: m.is_mention_crab ?? false },
    platform_timestamp: trace.started_at ?? '2026-05-20T00:00:00Z',
  }))

  return { messages, sessionType, channelId, sessionId }
}

function originalSupplementInfo(trace) {
  const action = trace.spans?.find(s => s.type === 'dispatch_action')
  const d = action?.details ?? {}
  return {
    target_task_id: d.target_task_id ?? '<unknown>',
    text_summary: d.text_summary ?? '',
    outcome: d.outcome ?? '<unknown>',
  }
}

// ── 主循环 ──
const results = []
for (const prefix of TRACE_PREFIXES) {
  const trace = traceByPrefix.get(prefix)
  if (!trace) {
    console.log(`⏭  ${prefix}: trace 未找到`)
    results.push({ prefix, status: 'NOT_FOUND' })
    continue
  }

  const { messages, sessionType, channelId, sessionId } = extractDispatchContextFromTrace(trace)
  const orig = originalSupplementInfo(trace)

  console.log(`\n${'='.repeat(80)}`)
  console.log(`▶ ${prefix} | ${sessionType} | trigger: ${trace.trigger?.summary?.slice(0, 70)}`)
  console.log(`  原 LLM 输出: supplement target=${orig.target_task_id}`)
  console.log(`            text: ${orig.text_summary.slice(0, 70)}`)
  console.log(`            outcome: ${orig.outcome}`)

  // 收集 trace span 信息——用一个简单的 trace callback 记录关键事件
  const events = []
  const traceCb = {
    startSpan: ({ type, details }) => {
      events.push({ phase: 'startSpan', type, details })
      return { span_id: `sp-${events.length}` }
    },
    endSpan: (spanId, status, details) => {
      events.push({ phase: 'endSpan', spanId, status, details })
    },
  }

  const dispatchCtx = {
    messages,
    recentMessages: [],
    activeTasks: [], // ← 核心：模拟 LLM 编 task_id 的核心情形
    sessionType,
    channelId,
    sessionId,
    senderFriend: {
      id: 'replay-friend',
      display_name: messages[0]?.sender?.platform_display_name ?? 'someone',
      permission: 'master',
      channel_identities: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    traceId: `replay-${prefix}`,
  }

  let sendErrorCalled = false
  let sendErrorText = ''
  try {
    const { actions } = await dispatch(dispatchCtx, {
      adapter,
      modelId: defaultModelId,
      sendErrorToUser: async (text) => { sendErrorCalled = true; sendErrorText = text },
      maxParseRetries: 3,
      trace: traceCb,
      laneBatchSize: messages.length,
    })

    const dispatchCall = events.find(e => e.phase === 'endSpan' && e.spanId === 'sp-1')
    const retries = dispatchCall?.details?.retries ?? '?'
    const firstKind = actions[0]?.kind ?? '<no_action>'
    const expectedKind = sessionType === 'group' ? ['new_task', 'stay_silent'] : ['new_task']
    const passed = expectedKind.includes(firstKind) && !sendErrorCalled

    console.log(`\n  现版 dispatcher 输出:`)
    console.log(`    actions: ${JSON.stringify(actions, null, 2).split('\n').join('\n      ').slice(0, 600)}`)
    console.log(`    retries: ${retries}  ${retries > 0 ? '✓ schema 白名单拦了一次以上' : ''}`)
    console.log(`    sendErrorToUser called: ${sendErrorCalled}`)
    if (sendErrorCalled) console.log(`    sendErrorText: ${sendErrorText}`)
    console.log(`    ${passed ? '✅ PASS' : '❌ FAIL'} — 预期 kind ∈ [${expectedKind.join(',')}]，实际 ${firstKind}`)

    results.push({
      prefix, sessionType, retries, sendErrorCalled,
      firstKind, passed, actionsCount: actions.length,
    })
  } catch (err) {
    console.log(`  ❌ ERROR: ${err.message}`)
    results.push({ prefix, status: 'ERROR', error: err.message })
  }
}

console.log(`\n${'='.repeat(80)}`)
console.log('## 汇总')
console.log(`${'='.repeat(80)}`)
let passed = 0, failed = 0
for (const r of results) {
  if (r.passed) passed++
  else if (r.status !== 'NOT_FOUND') failed++
  const mark = r.passed ? '✅' : (r.status === 'NOT_FOUND' ? '⏭ ' : '❌')
  console.log(`${mark} ${r.prefix} | ${r.sessionType ?? '?'} | retries=${r.retries ?? '?'} | first=${r.firstKind ?? r.status}`)
}
console.log(`\n${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped`)
process.exit(failed > 0 ? 1 : 0)
