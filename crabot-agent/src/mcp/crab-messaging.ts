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
import type { RpcClient } from 'crabot-shared'
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
// 工具类型定义
// ============================================================================

export interface MessagingTool {
  name: string
  description: string
  schema: Record<string, z.ZodTypeAny>
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
}

// ============================================================================
// 内部 helper
// ============================================================================

function wrapText(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function clampPageSize(n: number, max = 100): number {
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(Math.floor(n), max)
}

// ============================================================================
// buildMessagingTools — 可单测的纯函数，返回 8 个工具数组
// ============================================================================

export function buildMessagingTools(
  deps: CrabMessagingDeps,
  sandboxPathMappingsRef?: { current: PathMapping[] },
): MessagingTool[] {
  const { rpcClient, moduleId, getAdminPort, resolveChannelPort } = deps

  return [
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
                { session_id: string; created: boolean }
              >(channelPort, 'find_or_create_private_session', {
                platform_user_id: identity.platform_user_id,
              }, moduleId)

              // 4. 发送消息
              const sendResult = await withRetry(async () => {
                return rpcClient.call<
                  { session_id: string; content: { type: string; text: string } },
                  { platform_message_id: string; sent_at: string }
                >(channelPort, 'send_message', {
                  session_id: sessionResult.session_id,
                  content: { type: 'text', text: content },
                }, moduleId)
              })

              return wrapText({
                ...sendResult,
                channel_id: identity.channel_id,
                session_id: sessionResult.session_id,
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
    // 5. send_message — 发送消息
    // ================================================================
    {
      name: 'send_message',
      description: '在指定 Channel 的指定 Session 中发送消息。支持文本、媒体 URL、本地文件路径。\n\nintent 参数说明：\n- "normal"（默认）：发完继续后续操作，不等回应。\n- "ask_human"：发出后阻塞等待人类回应，适合"你想要 A 还是 B"这类必须等回答才能继续的问题。滥用会让任务停摆，能自己决策的不要 ask。',
      schema: {
        channel_id: z.string().describe('Channel 模块实例 ID'),
        session_id: z.string().describe('目标 Session ID'),
        content: z.string().describe('消息内容（文本或描述）'),
        intent: z.enum(['normal', 'ask_human']).optional().describe('意图：normal=单纯发消息（默认）；ask_human=发后阻塞等回应。能自己决策的不要 ask，会让任务停摆'),
        content_type: z.enum(['text', 'image', 'file']).optional().describe('消息类型，默认 text'),
        media_url: z.string().optional().describe('媒体 URL（网络地址，与 file_path 二选一）'),
        file_path: z.string().optional().describe('沙盒内本地文件路径（自动转换为主机路径）'),
        filename: z.string().optional().describe('文件名（可选）'),
        mentions: z.array(z.string()).optional().describe('@提及的熟人 ID 列表'),
        quote_message_id: z.string().optional().describe('引用回复的平台消息 ID'),
      },
      handler: async (args) => {
        const channel_id = args.channel_id as string
        const session_id = args.session_id as string
        const content = args.content as string
        const content_type = args.content_type as 'text' | 'image' | 'file' | undefined
        const media_url = args.media_url as string | undefined
        const file_path = args.file_path as string | undefined
        const filename = args.filename as string | undefined
        const mentions = args.mentions as string[] | undefined
        const quote_message_id = args.quote_message_id as string | undefined

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

          // 转换 mentions：friend_id → platform_user_id（并行解析）
          let platformMentions: Array<{ platform_user_id: string }> | undefined
          if (mentions && mentions.length > 0) {
            const adminPort = await getAdminPort()
            const resolved = await Promise.all(
              mentions.map(async (friendId) => {
                try {
                  const fResult = await rpcClient.call<
                    { friend_id: string },
                    { friend: Friend }
                  >(adminPort, 'get_friend', { friend_id: friendId }, moduleId)
                  const identity = fResult.friend.channel_identities.find(
                    ci => ci.channel_id === channel_id,
                  )
                  return identity ? { platform_user_id: identity.platform_user_id } : null
                } catch {
                  return null
                }
              }),
            )
            platformMentions = resolved.filter((m): m is NonNullable<typeof m> => m !== null)
          }

          // 带重试发送消息
          const result = await withRetry(async () => {
            return rpcClient.call<
              {
                session_id: string
                content: MessageContent
                features?: {
                  mentions?: Array<{ platform_user_id: string }>
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

          return wrapText(result)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return wrapText({ error: `发送失败: ${msg}` })
        }
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
  ]
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
