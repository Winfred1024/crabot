/**
 * Crab-Messaging MCP Server — Agent 统一通讯能力
 *
 * 提供 8 个工具：lookup_friend, list_contacts, list_groups, list_sessions, send_private_message, send_message, get_history, get_message
 * 对齐 protocol-crab-messaging.md
 *
 * @see crabot-docs/protocols/protocol-crab-messaging.md
 */

import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import { SYSTEM_CHANNEL_ID, SYSTEM_SESSION_ID, type RpcClient } from 'crabot-shared'
import type { Friend } from '../types.js'
import * as path from 'path'
import { annotatePagination } from './pagination-annotator.js'
import { translateChannelError } from './error-translator.js'
// ============================================================================
// 依赖注入接口
// ============================================================================

export interface CrabMessagingDeps {
  rpcClient: RpcClient
  moduleId: string
  getAdminPort: () => Promise<number>
  resolveChannelPort: (channelId: string) => Promise<number>
  /**
   * 可选：返回当前调用 mcp 工具的 task 上下文。
   * Worker 调用路径返回非空（含 taskId + humanQueue 引用），用于 send_message(intent='ask_human')。
   * Front 调用路径返回 null（front 不能调 ask_human，工具内会拒绝）。
   */
  getTaskContext?: () => TaskContext | null
  /** 是否啟用飛書文檔讀取工具（有飛書 channel 時才注入） */
  enableFeishuDocTool?: boolean
}

export interface TaskContext {
  taskId: string
  humanQueue: import('../engine/human-message-queue.js').HumanMessageQueue
  /** 任务来源类型——schedule 触发的任务禁止调用 send_message(intent='ask_human')。
   *  与 Task.source.trigger_type 同名同枚举。 */
  triggerType: 'message' | 'scheduled'
  /** 任务子分类（来自 Schedule.task_template.type 或人类指派）。
   *  现仅 'daily_reflection' 用于 messaging 工具白名单过滤——反思任务工具集合卡死到
   *  send_master_private + 只读工具，避免反思内容被发到任意群/私聊。
   *  其他 scheduled 任务（用户自建的推送 / 巡检 / 数据采集）不受白名单影响。 */
  taskType?: string
  /** 当前 task 是否挂了 goal；agent-handler 在装 deps 时由 admin task 查询结果维护 cache，
   *  此处用 getter 形式以便 worker 中途 set_task_goal 后下一次工具调用立即生效。
   *  spec: 2026-05-23-goal-mode-design.md §4.2 */
  hasGoal: () => boolean
}

// ============================================================================
// 路径映射（Worker 执行时动态设置）
// ============================================================================

export interface PathMapping {
  sandbox_path: string
  host_path: string
  read_only: boolean
}

// ============================================================================
// 路径转换
// ============================================================================

/**
 * 安全的沙盒路径→主机路径转换
 * 对齐 protocol-crab-messaging.md：normalize 防止路径穿越，替换后二次验证
 */
function mapSandboxPathToHost(sandboxPath: string, mappings: PathMapping[]): string {
  const normalizedPath = path.normalize(sandboxPath)

  for (const mapping of mappings) {
    const normalizedSandbox = path.normalize(mapping.sandbox_path)
    if (normalizedPath.startsWith(normalizedSandbox)) {
      const relativePart = normalizedPath.slice(normalizedSandbox.length)
      const hostPath = path.join(mapping.host_path, relativePart)
      const normalizedHost = path.normalize(hostPath)
      // 二次验证：确保结果路径仍在映射的 host_path 目录内
      if (!normalizedHost.startsWith(path.normalize(mapping.host_path))) {
        throw new Error('Resolved path escapes allowed directory')
      }
      return normalizedHost
    }
  }

  throw new Error(`Path ${sandboxPath} is not accessible from sandbox`)
}

// ============================================================================
// 重试逻辑
// ============================================================================

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delays = [1000, 2000, 4000],
): Promise<T> {
  let lastError: Error | undefined
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const isRetryable = lastError.message.includes('ECONNREFUSED')
        || lastError.message.includes('ETIMEDOUT')
        || lastError.message.includes('ECONNRESET')
        || lastError.message.includes('socket hang up')
      if (!isRetryable || i === maxRetries - 1) throw lastError
      await new Promise(resolve => setTimeout(resolve, delays[i] ?? 4000))
    }
  }
  throw lastError
}

// ============================================================================
// ask_human 相关常量
// ============================================================================

/**
 * ask_human 的 pending_question 字段截断长度。
 * admin 端 Task.pending_question 没有强制 schema 上限，这里截 2000 保 prompt 注入精简 + 防止过长污染 active_tasks 段。
 */
const ASK_HUMAN_PENDING_QUESTION_MAX_LEN = 2000

/**
 * ask_human 设置 barrier 的超时。
 * 必须 >= admin WAITING_HUMAN_TIMEOUT_MS（24h），否则 barrier 先 timeout 但 admin 还没切 failed，worker 假醒空跑。
 * 注：admin 端常量在 crabot-admin/src/index.ts AdminModule.WAITING_HUMAN_TIMEOUT_MS。
 */
const ASK_HUMAN_BARRIER_TIMEOUT_MS = 24 * 60 * 60 * 1000

// ============================================================================
// 工具类型定义
// ============================================================================

export interface MessagingTool {
  name: string
  description: string
  schema: Record<string, z.ZodTypeAny>
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
  }>
}

// ============================================================================
// 内部 helper
// ============================================================================

function wrapText(payload: unknown, opts?: { isError?: boolean }) {
  const base = { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
  return opts?.isError ? { ...base, isError: true } : base
}

function clampPageSize(n: number, max = 100): number {
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(Math.floor(n), max)
}

// ============================================================================
// buildMessagingTools — 可单测的纯函数，返回 8 个工具数组
// ============================================================================

/**
 * daily-reflection 任务允许的 messaging 工具白名单。
 *
 * 背景：反思任务没有 task_origin（无对话方），prompt 不会给 channel/session 锚点；产出的报告
 * 又是 crabot 内部产物（trace 数据 / Evolution Mode / case→rule 等黑话）。若不限制工具，
 * agent 可能 lookup_friend / list_sessions 自行挑一个 session 把内部产物发出去
 * （已发生：2026-05-30 daily-reflection 把反思报告发到群"全栈工程师哈哈 & Mr.Wu"）。
 *
 * 仅对 task_type='daily_reflection' 生效：
 *   - 对外唯一通道：send_master_private（admin 按 permission='master' 定位，封死目标）
 *   - 只读分析工具：get_history / get_message / read_feishu_document（用 trace 里拿到的 channel/session 查历史）
 *   - 其他工具不暴露：lookup_friend、list_contacts、list_groups、list_sessions、send_message、send_private_message
 *
 * 其他 scheduled 任务（如用户自建的 GitHub 新闻推送 / 群通报巡检）**不受此白名单影响**，
 * 走完整 messaging 工具集——它们本来就是要往群里发的合理用途。
 */
const DAILY_REFLECTION_ALLOWED_TOOLS = new Set([
  'send_master_private',
  'get_history',
  'get_message',
  'read_feishu_document',
])

export function buildMessagingTools(
  deps: CrabMessagingDeps,
  sandboxPathMappingsRef?: { current: PathMapping[] },
): MessagingTool[] {
  const { rpcClient, moduleId, getAdminPort, resolveChannelPort } = deps
  const isDailyReflection = deps.getTaskContext?.()?.taskType === 'daily_reflection'

  const allTools: MessagingTool[] = [
    // ================================================================
    // 1. lookup_friend — 查找熟人
    // ================================================================
    {
      name: 'lookup_friend',
      description: '搜索熟人信息，包括该熟人在哪些 Channel 上有身份。可按名称模糊搜索或按 friend_id 精确查找。',
      schema: {
        name: z.string().optional().describe('按名称模糊搜索'),
        friend_id: z.string().optional().describe('按 friend_id 精确查找'),
      },
      handler: async (args) => {
        const friendId = args.friend_id as string | undefined
        const searchName = args.name as string | undefined

        if (!searchName && !friendId) {
          return wrapText({ error: '必须提供 name 或 friend_id 至少一个查询条件' })
        }

        const adminPort = await getAdminPort()

        if (friendId) {
          try {
            const result = await rpcClient.call<
              { friend_id: string },
              { friend: Friend }
            >(adminPort, 'get_friend', { friend_id: friendId }, moduleId)

            const friend = result.friend
            return wrapText({
              friends: [{
                friend_id: friend.id,
                display_name: friend.display_name,
                permission: friend.permission,
                channels: friend.channel_identities.map(ci => ({
                  channel_id: ci.channel_id,
                  platform_user_id: ci.platform_user_id,
                  platform_display_name: ci.platform_display_name ?? ci.platform_user_id,
                })),
              }],
            })
          } catch {
            return wrapText({ error: `Friend not found: ${friendId}` })
          }
        }

        // 按名称搜索
        const result = await rpcClient.call<
          { search?: string; pagination?: { page: number; page_size: number } },
          { items: Friend[]; pagination: { total_items: number } }
        >(adminPort, 'list_friends', { search: searchName, pagination: { page: 1, page_size: 20 } }, moduleId)

        const friends = result.items.map(f => ({
          friend_id: f.id,
          display_name: f.display_name,
          permission: f.permission,
          channels: f.channel_identities.map(ci => ({
            channel_id: ci.channel_id,
            platform_user_id: ci.platform_user_id,
            platform_display_name: ci.platform_display_name ?? ci.platform_user_id,
          })),
        }))

        return wrapText({ friends })
      },
    },

    // ================================================================
    // 2. list_contacts — 列出渠道的联系人列表（包含非熟人）
    // ================================================================
    {
      name: 'list_contacts',
      description: '列出渠道平台上的联系人（包括非熟人）。返回是分页结果——pagination.has_more=true 时只是部分；要拿全集请按 next_page 继续调用。不要把单页结果当作全集做断言。',
      schema: {
        channel_id: z.string().describe('渠道 ID'),
        search: z.string().optional().describe('联系人名称搜索关键词'),
        page: z.number().optional().describe('页码，从 1 开始'),
        page_size: z.number().optional().describe('每页数量，默认 50，最大 100'),
      },
      handler: async (args) => {
        const channel_id = args.channel_id as string
        let channelPort: number
        try {
          channelPort = await resolveChannelPort(channel_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用: ${msg}` })
        }
        if (!channelPort) {
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用` })
        }
        const page = (args.page as number | undefined) ?? 1
        const userSpecifiedPageSize = args.page_size != null
        const page_size = clampPageSize((args.page_size as number | undefined) ?? 50)
        try {
          const result = await rpcClient.call<
            { search?: string; pagination: { page: number; page_size: number } },
            { items: unknown[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }
          >(
            channelPort, 'list_contacts',
            { search: args.search as string | undefined, pagination: { page, page_size } },
            moduleId,
          )
          return wrapText(annotatePagination(result, { requestedPage: page, requestedPageSize: page_size, userSpecifiedPageSize }))
        } catch (err) {
          return wrapText(translateChannelError(err))
        }
      },
    },

    // ================================================================
    // 2b. list_groups — 列出渠道的群聊列表
    // ================================================================
    {
      name: 'list_groups',
      description: '列出渠道平台上的群（包括从未交互过的）。返回是分页结果——pagination.has_more=true 时只是部分；要拿全集请按 next_page 继续调用。不要把单页结果当作全集做断言。',
      schema: {
        channel_id: z.string().describe('渠道 ID'),
        search: z.string().optional().describe('群名搜索关键词'),
        page: z.number().optional().describe('页码，从 1 开始'),
        page_size: z.number().optional().describe('每页数量，默认 50，最大 100'),
      },
      handler: async (args) => {
        const channel_id = args.channel_id as string
        let channelPort: number
        try {
          channelPort = await resolveChannelPort(channel_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用: ${msg}` })
        }
        if (!channelPort) {
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用` })
        }
        const page = (args.page as number | undefined) ?? 1
        const userSpecifiedPageSize = args.page_size != null
        const page_size = clampPageSize((args.page_size as number | undefined) ?? 50)
        try {
          const result = await rpcClient.call<
            { search?: string; pagination: { page: number; page_size: number } },
            { items: unknown[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }
          >(
            channelPort, 'list_groups',
            { search: args.search as string | undefined, pagination: { page, page_size } },
            moduleId,
          )
          return wrapText(annotatePagination(result, { requestedPage: page, requestedPageSize: page_size, userSpecifiedPageSize }))
        } catch (err) {
          return wrapText(translateChannelError(err))
        }
      },
    },

    // ================================================================
    // 3. list_sessions — 查看会话列表（加分页元信息）
    // ================================================================
    {
      name: 'list_sessions',
      description: '查看指定 Channel 上当前已感知的会话列表。返回是分页结果——pagination.has_more=true 时只是部分；要拿全集请按 next_page 继续调用。',
      schema: {
        channel_id: z.string().describe('Channel 模块实例 ID'),
        type: z.enum(['private', 'group']).optional().describe('按类型过滤'),
        page: z.number().optional().describe('页码，从 1 开始'),
        page_size: z.number().optional().describe('每页数量，默认 20，最大 100'),
      },
      handler: async (args) => {
        const channel_id = args.channel_id as string
        let channelPort: number
        try {
          channelPort = await resolveChannelPort(channel_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用: ${msg}` })
        }
        if (!channelPort) {
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `Channel ${channel_id} 不可用` })
        }
        const page = (args.page as number | undefined) ?? 1
        const userSpecifiedPageSize = args.page_size != null
        const page_size = clampPageSize((args.page_size as number | undefined) ?? 20)
        try {
          const result = await rpcClient.call<
            { type?: string; pagination: { page: number; page_size: number } },
            { items: unknown[]; pagination: { page: number; page_size: number; total_items: number; total_pages: number } }
          >(
            channelPort, 'get_sessions',
            { type: args.type as string | undefined, pagination: { page, page_size } },
            moduleId,
          )
          return wrapText(annotatePagination(result, { requestedPage: page, requestedPageSize: page_size, userSpecifiedPageSize }))
        } catch (err) {
          return wrapText(translateChannelError(err))
        }
      },
    },

    // ================================================================
    // 4. send_private_message — 给熟人发私聊消息
    // ================================================================
    {
      name: 'send_private_message',
      description: '给熟人发私聊消息。当你不关心使用哪个 Channel 或不知道该用哪个 Channel 时使用此工具。系统自动查找可用 Channel 并创建/复用私聊 Session。如果你已知 channel_id 和 session_id，请直接使用 send_message。',
      schema: {
        friend_id: z.string().describe('目标熟人 ID'),
        content: z.string().describe('消息内容（文本）'),
      },
      handler: async (args) => {
        const friend_id = args.friend_id as string
        const content = args.content as string
        try {
          // 1. 查询 friend 信息
          const adminPort = await getAdminPort()
          const friendResult = await rpcClient.call<
            { friend_id: string },
            { friend: Friend }
          >(adminPort, 'get_friend', { friend_id: friend_id }, moduleId)

          const identities = friendResult.friend.channel_identities
          if (identities.length === 0) {
            return wrapText({ error: `熟人 ${friendResult.friend.display_name} 没有关联任何 Channel` })
          }

          // 2. 逐个尝试 channel，找到第一个可用的
          let lastError = ''
          for (const identity of identities) {
            let channelPort: number
            try {
              channelPort = await resolveChannelPort(identity.channel_id)
            } catch {
              lastError = `Channel ${identity.channel_id} 不可用`
              continue
            }
            if (!channelPort) {
              lastError = `Channel ${identity.channel_id} 不可用`
              continue
            }

            try {
              // 3. 查找或创建私聊 session
              const sessionResult = await rpcClient.call<
                { platform_user_id: string },
                { session: { id: string }; created: boolean }
              >(channelPort, 'find_or_create_private_session', {
                platform_user_id: identity.platform_user_id,
              }, moduleId)

              const sessionId = sessionResult?.session?.id
              if (!sessionId) {
                lastError = `Channel ${identity.channel_id} 返回的 session 缺少 id`
                continue
              }

              // 4. 发送消息
              const sendResult = await withRetry(async () => {
                return rpcClient.call<
                  { session_id: string; content: { type: string; text: string } },
                  { platform_message_id: string; sent_at: string }
                >(channelPort, 'send_message', {
                  session_id: sessionId,
                  content: { type: 'text', text: content },
                }, moduleId)
              })

              return wrapText({
                ...sendResult,
                channel_id: identity.channel_id,
                session_id: sessionId,
              })
            } catch (err) {
              lastError = err instanceof Error ? err.message : String(err)
              continue
            }
          }

          return wrapText({ error: `所有 Channel 均不可用: ${lastError}` })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `发送失败: ${msg}` })
        }
      },
    },

    // ================================================================
    // 4b. send_master_private — 给 master 发私聊（按 permission='master' 自动定位）
    // ================================================================
    {
      name: 'send_master_private',
      description: `给 master 发私聊消息。

唯一入口：scheduled 任务（每日反思 / 记忆整理等）需要对外通知 master 时必须用此工具。
内部行为：admin 按 permission='master' 定位 master friend → 在指定 channel 上 find_or_create 私聊 session → 发出。
找不到 master 时**直接返回 error，不退化、不外发任何 channel**。

注意：发出的内容会被人类看到——禁止塞 trace 数据 / Evolution Mode / case→rule / Audit 等内部黑话，必须翻译成一行人话（"今日整理 X 条经验，无重大发现"这种），多行长报告请走 task outcome 不要外发。`,
      schema: {
        content: z.string().describe('给 master 看的一句人话（已翻译，无内部黑话）'),
        channel_id: z.string().optional().describe('指定走哪个 channel。不传则按 master.channel_identities 顺序尝试第一个可用的'),
      },
      handler: async (args) => {
        const content = args.content as string
        const preferredChannelId = args.channel_id as string | undefined

        const adminPort = await getAdminPort()
        const masterResult = await rpcClient.call<
          Record<string, never>,
          { friend: Friend | null }
        >(adminPort, 'find_master_friend', {}, moduleId)

        const master = masterResult.friend
        if (!master) {
          return wrapText({ error: 'No master friend configured; cannot send_master_private' })
        }

        const identities = master.channel_identities
        if (!identities || identities.length === 0) {
          return wrapText({ error: `Master friend ${master.display_name} has no channel identities` })
        }

        // preferredChannelId 指定时只尝试该 channel，不可用直接报错
        const candidates = preferredChannelId
          ? identities.filter(ci => ci.channel_id === preferredChannelId)
          : identities

        if (preferredChannelId && candidates.length === 0) {
          return wrapText({
            error: `Master has no identity on channel ${preferredChannelId}`,
            available_channels: identities.map(ci => ci.channel_id),
          })
        }

        let lastError = ''
        for (const identity of candidates) {
          let channelPort: number
          try {
            channelPort = await resolveChannelPort(identity.channel_id)
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err)
            continue
          }
          if (!channelPort) {
            lastError = `Channel ${identity.channel_id} 不可用`
            continue
          }

          try {
            const sessionResult = await rpcClient.call<
              { platform_user_id: string },
              { session: { id: string }; created: boolean }
            >(channelPort, 'find_or_create_private_session', {
              platform_user_id: identity.platform_user_id,
            }, moduleId)

            const sessionId = sessionResult?.session?.id
            if (!sessionId) {
              lastError = `Channel ${identity.channel_id} 返回的 session 缺少 id`
              continue
            }

            const sendResult = await withRetry(async () => {
              return rpcClient.call<
                { session_id: string; content: { type: string; text: string } },
                { platform_message_id: string; sent_at: string }
              >(channelPort, 'send_message', {
                session_id: sessionId,
                content: { type: 'text', text: content },
              }, moduleId)
            })

            return wrapText({
              ...sendResult,
              channel_id: identity.channel_id,
              session_id: sessionId,
              friend_id: master.id,
            })
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err)
            continue
          }
        }

        return wrapText({
          error: preferredChannelId
            ? `Channel ${preferredChannelId} 发送失败: ${lastError}`
            : `All master channels failed: ${lastError}`,
        })
      },
    },

    // ================================================================
    // 5. send_message — 发送消息
    // ================================================================
    {
      name: 'send_message',
      description: `在指定 Channel 的指定 Session 中发送消息。支持文本、媒体 URL、本地文件路径。

## 铁则：这是**唯一**让人类看到内容的工具

crabot 系统给你的所有信号——system prompt、supplement 注入、tool result、audit 报告、\`/清除目标\` 的响应、engine 拦截、forced summary 提醒——**人类完全看不见**，只有你看得见。它们是你的"内部思维空间"。

调用 send_message 前先问自己：**人类必须知道这件事吗？** 如果只是 crabot 系统在跟你对账（"audit 卡了 / 系统让我重写 / engine 不让我 end_turn"）——闭嘴，自己消化，换策略或开始干活。**不要把内部黑话（audit / criterion / 审计员 / \`/清除目标\` / blocked / acceptance_criteria / forced_summary）直接搬给人类看**，要翻译成自然语言（"我搞不定 X" / "需要您 Y"）。

## 两个合法场景（intent 参数）

唯一对外通道分两档，全部 audience 都是人类：

- **"info"（默认）**：进度告知 / ack / 中间结果 / 最终交付。人类会看到、不期待回复。**不用于**"我做不到 / 卡住了 / 想换方向"——这种话发出去人类也只是看到，loop 不会停，下一轮你还得面对同样状态。
- **"ask_human"**：阻塞等人类同步回复（task 切 waiting_human）。**任何想让 master 同步回复才能继续的场景**都用它，不限问句形态——决策分叉 / 求助 / 关键澄清都算。Self-check：你期不期待回复内容会改变下一轮动作？期待→ask_human，不期待→info。滥用会让任务停摆，能自己决策的不要 ask。`,
      schema: {
        channel_id: z.string().describe('Channel 模块实例 ID'),
        session_id: z.string().describe('目标 Session ID'),
        content: z.string().describe('消息内容（给人类看的自然语言；禁止塞 audit/criterion/`/清除目标` 等内部黑话）'),
        intent: z.enum(['info', 'ask_human']).optional().describe('意图：info=进度告知 / 最终交付（默认，单向，不等回复）；ask_human=阻塞等人类同步回复'),
        content_type: z.enum(['text', 'image', 'file']).optional().describe('消息类型，默认 text'),
        media_url: z.string().optional().describe('媒体 URL（网络地址，与 file_path 二选一）'),
        file_path: z.string().optional().describe('沙盒内本地文件路径（自动转换为主机路径）'),
        filename: z.string().optional().describe('文件名（可选）'),
        mentions: z.array(z.object({
          friend_id: z.string().optional().describe('熟人 ID（与 platform_user_id 二选一）'),
          platform_user_id: z.string().optional().describe('平台用户 ID（如飞书 open_id，从 list_contacts 获取）。有此字段时跳过熟人查找，可直接 @ 非熟人群成员'),
          at_name: z.string().optional().describe('你在 content 正文里写的 @标记文本（如 "@徐倩"）。提供后系统在正文里做内联高亮替换；不提供则在消息末尾追加 @ 通知'),
        })).optional().describe('@提及列表。每项提供 friend_id（熟人 ID）或 platform_user_id（平台 ID，从 list_contacts 获取）之一，加可选的 at_name'),
        quote_message_id: z.string().optional().describe('引用回复的平台消息 ID'),
      },
      handler: async (args) => {
        const channel_id = args.channel_id as string
        const session_id = args.session_id as string
        const content = args.content as string
        const intent = args.intent as 'info' | 'ask_human' | undefined
        const content_type = args.content_type as 'text' | 'image' | 'file' | undefined
        const media_url = args.media_url as string | undefined
        const file_path = args.file_path as string | undefined
        const filename = args.filename as string | undefined
        const mentions = args.mentions as Array<{ friend_id?: string; platform_user_id?: string; at_name?: string }> | undefined
        const quote_message_id = args.quote_message_id as string | undefined

        // === SYSTEM_SESSION 哨兵拒收：schedule 无 target_session 时 ScheduledTaskRunner
        // 注入的占位 session 不可作为真实发送目标。worker 应按 trigger_message 的
        // system_event 文本指引调 send_master_private 或其他工具汇报。 ===
        if (channel_id === SYSTEM_CHANNEL_ID || session_id === SYSTEM_SESSION_ID) {
          return wrapText({
            error: '此 session 是系统占位符（schedule 无 target_session 场景），不可直接发送。请按 trigger_message 的文本指引调 send_master_private 或选定真实 channel/session 后再发。',
          })
        }

        // === ask_human：先验证 task context 存在，再继续（不提前切状态） ===
        if (intent === 'ask_human') {
          const taskCtx = deps.getTaskContext?.()
          if (!taskCtx) {
            // 消息尚未发出，直接拒绝。ask_human 不该被 front 调用，这是 safeguard。
            return wrapText({ error: 'ask_human 仅可在 worker 任务上下文内调用' })
          }
          if (taskCtx.triggerType === 'scheduled') {
            return wrapText({
              error: 'ask_human is not allowed in scheduled tasks. Scheduled tasks have no synchronous '
                + "human responder. If you are blocked or have failed, send_message with intent='info' "
                + 'to report status, then end_turn.',
            })
          }
        }

        // === Step 1: 先 send（高失败率操作先做；失败 → state 完全不变）===
        let sendResult: { platform_message_id: string; sent_at: string }
        try {
          const channelPort = await resolveChannelPort(channel_id)
          if (!channelPort) {
            return wrapText({ error: `Channel ${channel_id} 不可用` })
          }

          // 按优先级构造 MessageContent
          type MessageContent = {
            type: string
            text?: string
            media_url?: string
            file_path?: string
            filename?: string
          }
          let messageContent: MessageContent

          if (media_url) {
            messageContent = {
              type: content_type ?? 'image',
              media_url: media_url,
              filename: filename,
            }
          } else if (file_path) {
            const mappings = sandboxPathMappingsRef?.current ?? []
            let hostPath: string

            if (mappings.length > 0) {
              // 有路径映射（远程 Worker）：沙盒路径 → 主机路径
              try {
                hostPath = mapSandboxPathToHost(file_path, mappings)
              } catch (pathErr) {
                return wrapText({ error: pathErr instanceof Error ? pathErr.message : String(pathErr) })
              }
            } else if (path.isAbsolute(file_path)) {
              // 无路径映射（本地 unified agent）：绝对路径直接使用
              hostPath = file_path
            } else {
              return wrapText({ error: '相对路径需要路径映射配置，请使用绝对路径' })
            }

            messageContent = {
              type: content_type ?? 'file',
              file_path: hostPath,
              filename: filename ?? path.basename(file_path),
            }
          } else {
            messageContent = {
              type: 'text',
              text: content,
            }
          }

          // 转换 mentions → { platform_user_id, at_name }[]
          // 两种路径：直传 platform_user_id（非熟人群成员）或通过 friend_id 查找
          type PlatformMention = { platform_user_id: string; at_name?: string }
          let platformMentions: PlatformMention[] | undefined
          if (mentions && mentions.length > 0) {
            const adminPort = await getAdminPort()
            const resolved = await Promise.all(
              mentions.map(async ({ friend_id, platform_user_id, at_name }) => {
                if (platform_user_id) {
                  return { platform_user_id, at_name }
                }
                if (!friend_id) return null
                const fid: string = friend_id
                try {
                  const fResult = await rpcClient.call<
                    { friend_id: string },
                    { friend: Friend }
                  >(adminPort, 'get_friend', { friend_id: fid }, moduleId)
                  const identity = fResult.friend.channel_identities.find(
                    ci => ci.channel_id === channel_id,
                  )
                  if (!identity) return null
                  return { platform_user_id: identity.platform_user_id, at_name }
                } catch {
                  return null
                }
              }),
            )
            platformMentions = resolved.filter((m): m is NonNullable<typeof m> => m !== null)
          }

          // 带重试发送消息
          sendResult = await withRetry(async () => {
            return rpcClient.call<
              {
                session_id: string
                content: MessageContent
                features?: {
                  mentions?: PlatformMention[]
                  quote_message_id?: string
                }
              },
              { platform_message_id: string; sent_at: string }
            >(channelPort, 'send_message', {
              session_id: session_id,
              content: messageContent,
              ...(platformMentions || quote_message_id ? {
                features: {
                  ...(platformMentions ? { mentions: platformMentions } : {}),
                  ...(quote_message_id ? { quote_message_id: quote_message_id } : {}),
                },
              } : {}),
            }, moduleId)
          })
        } catch (err) {
          // send 失败 → state 完全不变（task 仍 executing，无 barrier）
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `发送失败: ${msg}` })
        }

        // === Step 2 & 3: send 成功后处理 ask_human 后置逻辑 ===
        if (intent === 'ask_human') {
          // getTaskContext 在入口已校验过非 null，此处直接取
          const taskCtx = deps.getTaskContext!()!
          const adminPort = await getAdminPort()
          const pendingQuestion = content.slice(0, ASK_HUMAN_PENDING_QUESTION_MAX_LEN)

          const transitionToWaitingHuman = async () => {
            await rpcClient.call<
              { task_id: string; status: string; pending_question: string },
              { task: unknown }
            >(adminPort, 'update_task_status', {
              task_id: taskCtx.taskId,
              status: 'waiting_human',
              pending_question: pendingQuestion,
            }, moduleId)
          }

          // Step 2: update_task_status（admin 同进程 RPC，几乎不会失败；
          // 即使失败，消息已发，worker 看到 error 字段会自行处理，不会卡 barrier）
          let stateError: string | undefined
          try {
            await transitionToWaitingHuman()
          } catch (rpcErr) {
            const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr)
            // 区分两类失败：
            //  - persistent（状态机非法 transition，常因 trigger 路径未把 task 推到 executing）→ 尝试补齐状态机后重试
            //  - transient（admin 不健康 / 网络）→ 按 spec §5.3 直接兜底，不暂停 worker
            if (msg.includes('INVALID_STATUS_TRANSITION')) {
              // 无脑 try planning → executing；当前 status 若已在某档位，相应的 transition 会被 admin 拒，
              // 这里 catch 吞掉继续——目标是把 task 推到 executing 作为 waiting_human 的合法前继。
              for (const status of ['planning', 'executing'] as const) {
                try {
                  await rpcClient.call<
                    { task_id: string; status: string },
                    { task: unknown }
                  >(adminPort, 'update_task_status', {
                    task_id: taskCtx.taskId,
                    status,
                  }, moduleId)
                } catch { /* 状态机已在更高档位时同 status 转换会被拒，吞掉继续 */ }
              }
              try {
                await transitionToWaitingHuman()
              } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
                stateError = `update_task_status 重试仍失败：${retryMsg}`
              }
            } else {
              stateError = `update_task_status 失败：${msg}`
            }
          }

          if (stateError !== undefined) {
            // 补齐失败 / transient admin 故障：消息已发但状态没切。
            // 返回含 ask_human_state_error 的结果，worker 看到 error 字段会自己处理，不设 barrier 防止卡死。
            return wrapText({
              ...sendResult,
              ask_human_state_error: stateError,
            })
          }

          // Step 3: setBarrier（本地内存操作，从不失败）
          taskCtx.humanQueue.setBarrier(ASK_HUMAN_BARRIER_TIMEOUT_MS)
        }

        return wrapText({
          ...sendResult,
        })
      },
    },

    // ================================================================
    // 6. get_history — 查看聊天记录
    // ================================================================
    {
      name: 'get_history',
      description: '查看指定 Channel 上某个 Session 的历史消息。',
      schema: {
        channel_id: z.string().describe('Channel 模块实例 ID'),
        session_id: z.string().describe('Session ID'),
        keyword: z.string().optional().describe('关键词过滤'),
        limit: z.number().optional().describe('返回条数上限，默认 20'),
        before: z.string().optional().describe('查询此时间之前的消息（ISO 8601）'),
        after: z.string().optional().describe('查询此时间之后的消息（ISO 8601）'),
      },
      handler: async (args) => {
        const channel_id = args.channel_id as string
        const session_id = args.session_id as string
        const keyword = args.keyword as string | undefined
        const limit = args.limit as number | undefined
        const before = args.before as string | undefined
        const after = args.after as string | undefined

        try {
          const channelPort = await resolveChannelPort(channel_id)
          if (!channelPort) {
            return wrapText({ error: `Channel ${channel_id} 不可用` })
          }

          const timeRange = (before || after)
            ? { before: before, after: after }
            : undefined

          const result = await rpcClient.call<
            {
              session_id: string
              time_range?: { before?: string; after?: string }
              keyword?: string
              limit?: number
            },
            {
              // Channel 协议返回 PaginatedResult<HistoryMessage>，字段名是 items
              items: Array<{
                platform_message_id: string
                sender_name: string
                sender_platform_user_id?: string
                content: string
                content_type: string
                timestamp: string
              }>
            }
          >(channelPort, 'get_history', {
            session_id: session_id,
            ...(timeRange ? { time_range: timeRange } : {}),
            ...(keyword ? { keyword: keyword } : {}),
            limit: limit ?? 20,
          }, moduleId)

          const messages = result.items ?? []

          // 将 platform_user_id 映射为 friend_id（去重后批量查询）
          const adminPort = await getAdminPort()
          const uniqueUserIds = [...new Set(
            messages
              .map(m => m.sender_platform_user_id)
              .filter((id): id is string => !!id),
          )]
          const friendMap = new Map<string, string | undefined>()
          await Promise.all(uniqueUserIds.map(async (puid) => {
            try {
              const resolveResult = await rpcClient.call<
                { channel_id: string; platform_user_id: string },
                { friend: Friend | null }
              >(adminPort, 'resolve_friend', {
                channel_id: channel_id,
                platform_user_id: puid,
              }, moduleId)
              friendMap.set(puid, resolveResult.friend?.id)
            } catch {
              // ignore mapping failures
            }
          }))

          const enrichedMessages = messages.map(msg => ({
            platform_message_id: msg.platform_message_id,
            sender_name: msg.sender_name,
            sender_friend_id: msg.sender_platform_user_id
              ? friendMap.get(msg.sender_platform_user_id)
              : undefined,
            content: msg.content,
            content_type: msg.content_type,
            timestamp: msg.timestamp,
          }))

          return wrapText({ messages: enrichedMessages })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `查询历史失败: ${msg}` })
        }
      },
    },

    // ================================================================
    // 7. get_message — 按 ID 查询单条消息
    // ================================================================
    {
      name: 'get_message',
      description: '按消息 ID 查询单条消息详情。当消息内容不完整时可用此工具查看完整内容。',
      schema: {
        channel_id: z.string().describe('Channel 模块实例 ID'),
        session_id: z.string().describe('Session ID'),
        platform_message_id: z.string().describe('要查询的消息 ID'),
      },
      handler: async (args) => {
        const channel_id = args.channel_id as string
        const session_id = args.session_id as string
        const platform_message_id = args.platform_message_id as string

        try {
          const channelPort = await resolveChannelPort(channel_id)
          if (!channelPort) {
            return wrapText({ error: `Channel ${channel_id} 不可用` })
          }

          const result = await rpcClient.call<
            { session_id: string; platform_message_id: string },
            {
              platform_message_id: string
              sender: { platform_user_id: string; platform_display_name: string }
              content: { type: string; text?: string; media_url?: string }
              features: Record<string, unknown>
              platform_timestamp: string
            }
          >(channelPort, 'get_message', {
            session_id: session_id,
            platform_message_id: platform_message_id,
          }, moduleId)

          // friend-id enrichment（与 get_history 保持一致）
          let senderFriendId: string | undefined
          const puid = result.sender?.platform_user_id
          if (puid) {
            try {
              const adminPort = await getAdminPort()
              const resolveResult = await rpcClient.call<
                { channel_id: string; platform_user_id: string },
                { friend: Friend | null }
              >(adminPort, 'resolve_friend', {
                channel_id: channel_id,
                platform_user_id: puid,
              }, moduleId)
              senderFriendId = resolveResult.friend?.id
            } catch {
              // ignore mapping failure
            }
          }

          return wrapText({
            platform_message_id: result.platform_message_id,
            sender_name: result.sender?.platform_display_name,
            sender_friend_id: senderFriendId,
            content: result.content?.text ?? '',
            content_type: result.content?.type ?? 'text',
            timestamp: result.platform_timestamp,
            quote_message_id: result.features?.quote_message_id,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `查询消息失败: ${msg}` })
        }
      },
    },
    // ================================================================
    // 8. read_feishu_document — 讀取飛書雲文檔正文（有飛書 channel 時才注入）
    // ================================================================
    ...(deps.enableFeishuDocTool ? [{
      name: 'read_feishu_document',
      description: '讀取飛書雲文檔正文（支持 docx / wiki / sheets）。傳入飛書文檔 URL，返回標題和純文本正文。遇到權限不足時返回授權指引。注意：讀取 wiki/docx 需要把本應用（或應用所在群）加為文檔/文件夾/知識空間的協作者。',
      schema: {
        url: z.string().describe('飛書雲文檔 URL，例如 https://xxx.feishu.cn/docx/TOKEN 或 /wiki/TOKEN 或 /sheets/TOKEN'),
        channel_id: z.string().optional().describe('飛書 channel 實例 ID（有多個飛書 channel 時必須指定）'),
        max_chars: z.number().optional().describe('正文最大字符數（默認 50000）'),
      },
      handler: async (args: Record<string, unknown>) => {
        const url = args.url as string
        const maxChars = typeof args.max_chars === 'number' ? args.max_chars : undefined

        // 解析目標 channel
        let targetChannelId = args.channel_id as string | undefined
        if (!targetChannelId) {
          const adminPort = await getAdminPort()
          let feishuChannels: Array<{ id: string }> = []
          try {
            const result = await rpcClient.call<
              { pagination: { page: number; page_size: number } },
              { items: Array<{ id: string; implementation_id: string }> }
            >(adminPort, 'list_channel_instances', { pagination: { page: 1, page_size: 50 } }, moduleId)
            feishuChannels = result.items.filter(c => c.implementation_id === 'channel-feishu')
          } catch {
            return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: '無法獲取飛書 channel 列表' })
          }
          if (feishuChannels.length === 0) {
            return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: '沒有找到飛書 channel，無法讀取飛書文檔' })
          }
          if (feishuChannels.length > 1) {
            return wrapText({
              error_code: 'AMBIGUOUS',
              error: '有多個飛書 channel，請通過 channel_id 參數指定',
              available_channels: feishuChannels.map(c => c.id),
            })
          }
          targetChannelId = feishuChannels[0].id
        }

        let channelPort: number
        try {
          channelPort = await resolveChannelPort(targetChannelId)
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error_code: 'CHANNEL_UNAVAILABLE', error: `飛書 Channel ${targetChannelId} 不可用: ${msg}` })
        }

        try {
          const result = await rpcClient.call<
            { url: string; max_chars?: number },
            { type: string; title: string; text: string; truncated: boolean; url: string }
          >(channelPort, 'read_document', { url, ...(maxChars !== undefined ? { max_chars: maxChars } : {}) }, moduleId)
          return wrapText(result)
        } catch (err: unknown) {
          return wrapText(translateChannelError(err))
        }
      },
    } as MessagingTool] : []),
  ]

  return isDailyReflection
    ? allTools.filter(t => DAILY_REFLECTION_ALLOWED_TOOLS.has(t.name))
    : allTools
}

// ============================================================================
// MCP Server 创建
// ============================================================================

export function createCrabMessagingServer(
  deps: CrabMessagingDeps,
  sandboxPathMappingsRef?: { current: PathMapping[] },
): McpServer {
  const server = createMcpServer({ name: 'crab-messaging', version: '1.0.0' })

  const tools = buildMessagingTools(deps, sandboxPathMappingsRef)
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, t.handler as never)
  }

  return server
}
