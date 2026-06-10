/**
 * 聊天类型定义
 */

/** 聊天消息 */
export interface ChatMessage {
  message_id: string
  role: 'user' | 'assistant'
  content: string
  request_id?: string
  task_id?: string
  timestamp: string
}

/** 客户端发送的聊天消息 */
export interface ChatClientMessage {
  type: 'chat_message'
  request_id: string
  content: string
}

/** 服务端发送的聊天消息 */
export type ChatServerMessage =
  | {
      type: 'chat_reply'
      request_id: string
      content: string
      task_id?: string
      reply_type: 'direct_reply' | 'task_created' | 'task_completed' | 'task_failed'
      status: 'completed' | 'failed'
    }
  | { type: 'chat_status'; request_id: string; status: 'processing' }
  | { type: 'chat_error'; request_id?: string; error: string }
  | { type: 'chat_push'; message: ChatMessage }
  | { type: 'chat_task_update'; task: ChatTaskSnapshot }

/** 任务状态快照（chat_task_update / GET /api/chat/tasks/:id） */
export interface ChatTaskSnapshot {
  task_id: string
  status: string
  title: string
  step?: { index: number; total: number; description: string }
}

/** WebSocket 连接状态 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'