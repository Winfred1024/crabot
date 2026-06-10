/**
 * Chat Manager - 管理 Master 聊天功能
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { generateId, generateTimestamp, type RpcClient } from 'crabot-shared'
import type {
  ChatMessage,
  ChatClientMessage,
  ChatServerMessage,
  ChatCallbackParams,
  ChatCallbackResult,
  ChatSendMessageParams,
  ChatSendMessageResult,
} from './types.js'

export class ChatManager {
  private messages: Map<string, ChatMessage> = new Map()
  private wsServer: WebSocketServer | null = null
  private activeClient: WebSocket | null = null
  private pendingRequests: Map<string, { timestamp: number }> = new Map()
  private readonly messagesFilePath: string

  constructor(
    private readonly dataDir: string,
    private readonly rpcClient: RpcClient,
    private readonly resolveAgentPort: () => Promise<number>,
    private readonly jwtSecret: string,
    private readonly verifyJwt: (token: string, secret: string, dataDir: string) => Promise<unknown>,
  ) {
    this.messagesFilePath = path.join(dataDir, 'chat_messages.json')
  }

  // ==========================================================================
  // 数据持久化
  // ==========================================================================

  async loadData(): Promise<void> {
    try {
      const data = await fs.readFile(this.messagesFilePath, 'utf-8')
      const parsed = JSON.parse(data) as ChatMessage[]
      this.messages = new Map(parsed.map((m) => [m.message_id, m]))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[ChatManager] Failed to load messages:', error)
      }
    }
  }

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  async saveData(): Promise<void> {
    try {
      const data = Array.from(this.messages.values())
      await this.atomicWriteFile(this.messagesFilePath, JSON.stringify(data, null, 2))
    } catch (error) {
      console.error('[ChatManager] Failed to save messages:', error)
    }
  }

  // ==========================================================================
  // WebSocket 管理
  // ==========================================================================

  async handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    if (url.pathname !== '/ws/chat') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    // JWT 认证
    const token = url.searchParams.get('token')
    let tokenValid = false
    try {
      tokenValid = !!(token && (await this.verifyJwt(token, this.jwtSecret, this.dataDir)))
    } catch {
      tokenValid = false
    }
    if (!tokenValid) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // 创建 WebSocket 服务器（如果还没有）
    if (!this.wsServer) {
      this.wsServer = new WebSocketServer({ noServer: true })
    }

    // 升级连接
    this.wsServer.handleUpgrade(req, socket, head, (ws) => {
      // 关闭旧连接（单用户模式）
      if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
        this.activeClient.close(1000, 'New connection established')
      }

      this.activeClient = ws
      this.setupWebSocket(ws)
    })
  }

  private setupWebSocket(ws: WebSocket): void {
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as ChatClientMessage
        await this.onMessage(message)
      } catch (error) {
        console.error('[ChatManager] Failed to handle message:', error)
        this.pushToClient({
          type: 'chat_error',
          error: 'Invalid message format',
        })
      }
    })

    ws.on('close', () => {
      if (this.activeClient === ws) {
        this.activeClient = null
      }
    })

    ws.on('error', (error) => {
      console.error('[ChatManager] WebSocket error:', error)
    })
  }

  private async onMessage(data: ChatClientMessage): Promise<void> {
    if (data.type !== 'chat_message') {
      this.pushToClient({
        type: 'chat_error',
        request_id: data.request_id,
        error: 'Unknown message type',
      })
      return
    }

    // 存储用户消息
    const userMessage: ChatMessage = {
      message_id: generateId(),
      role: 'user',
      content: data.content,
      request_id: data.request_id,
      timestamp: generateTimestamp(),
    }
    this.messages.set(userMessage.message_id, userMessage)
    await this.saveData()

    // 记录 pending request
    this.pendingRequests.set(data.request_id, { timestamp: Date.now() })

    // 推送处理中状态
    this.pushToClient({
      type: 'chat_status',
      request_id: data.request_id,
      status: 'processing',
    })

    // 调用 Agent process_message
    try {
      const agentPort = await this.resolveAgentPort()
      if (!agentPort) {
        throw new Error('Agent module not available')
      }

      await this.rpcClient.call(
        agentPort,
        'process_message',
        {
          message: {
            platform_message_id: userMessage.message_id,
            session: {
              session_id: 'admin-chat',
              channel_id: 'admin-web',
              type: 'private',
            },
            sender: {
              friend_id: 'master',
              platform_user_id: 'master',
              platform_display_name: 'Master',
            },
            content: {
              type: 'text',
              text: data.content,
            },
            features: {
              is_mention_crab: false,
            },
            platform_timestamp: userMessage.timestamp,
          },
          source_type: 'admin_chat',
          callback_info: {
            source_module_id: 'admin-web',
            request_id: data.request_id,
          },
        },
        'admin-web'
      )
    } catch (error) {
      console.error('[ChatManager] Failed to call Agent:', error)
      this.pushToClient({
        type: 'chat_error',
        request_id: data.request_id,
        error: '系统暂时不可用，请稍后重试',
      })
      this.pendingRequests.delete(data.request_id)
    }
  }

  private pushToClient(message: ChatServerMessage): void {
    if (this.activeClient && this.activeClient.readyState === WebSocket.OPEN) {
      this.activeClient.send(JSON.stringify(message))
    }
  }

  // ==========================================================================
  // RPC 回调
  // ==========================================================================

  async handleChatCallback(params: ChatCallbackParams): Promise<ChatCallbackResult> {
    // 存储 assistant 消息
    const assistantMessage: ChatMessage = {
      message_id: generateId(),
      role: 'assistant',
      content: params.content,
      request_id: params.request_id,
      task_id: params.task_id,
      timestamp: generateTimestamp(),
    }
    this.messages.set(assistantMessage.message_id, assistantMessage)
    await this.saveData()

    // 推送给客户端
    this.pushToClient({
      type: 'chat_reply',
      request_id: params.request_id,
      content: params.content,
      task_id: params.task_id,
      reply_type: params.reply_type,
      status: params.reply_type === 'task_failed' ? 'failed' : 'completed',
    })

    // 清理 pending request
    this.pendingRequests.delete(params.request_id)

    return { received: true }
  }

  // ==========================================================================
  // send_message（admin-web 伪 channel 入口，spec 2026-06-10-master-chat-redesign §4）
  // ==========================================================================

  /** MessageContent → 文本。Phase 1 仅消费 text，媒体降级为占位文本（Phase 2 接入显示） */
  private contentToText(content: ChatSendMessageParams['content']): string {
    if (content.type === 'text') return content.text ?? ''
    const label = content.type === 'image' ? '图片' : '文件'
    const name = content.filename ?? content.media_url ?? content.file_path ?? ''
    const caption = content.text ? `\n${content.text}` : ''
    return `[${label}] ${name}（媒体显示将在后续版本支持）${caption}`
  }

  async handleSendMessage(params: ChatSendMessageParams): Promise<ChatSendMessageResult> {
    if (params.session_id !== 'admin-chat') {
      throw new Error(`Unknown chat session: ${params.session_id}`)
    }
    const text = this.contentToText(params.content)
    if (!text.trim()) {
      throw new Error('Empty message content')
    }
    const message: ChatMessage = {
      message_id: generateId(),
      role: 'assistant',
      content: text,
      timestamp: generateTimestamp(),
    }
    this.messages.set(message.message_id, message)
    await this.saveData()
    this.pushToClient({ type: 'chat_push', message })
    return { platform_message_id: message.message_id, sent_at: message.timestamp }
  }

  // ==========================================================================
  // 消息查询
  // ==========================================================================

  getMessages(limit: number, before?: string): ChatMessage[] {
    let messages = Array.from(this.messages.values())

    // 按时间倒序排序
    messages.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    // 过滤 before
    if (before) {
      messages = messages.filter((m) => m.timestamp < before)
    }

    // 限制数量
    return messages.slice(0, limit)
  }

  async clearMessages(): Promise<void> {
    this.messages.clear()
    await this.saveData()
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  close(): void {
    if (this.activeClient) {
      this.activeClient.close(1000, 'Server shutting down')
      this.activeClient = null
    }
    if (this.wsServer) {
      this.wsServer.close()
      this.wsServer = null
    }
  }
}
