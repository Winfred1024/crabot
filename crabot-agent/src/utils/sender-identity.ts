import type { ChannelMessage, Friend } from '../types.js'

export type SenderIdentity = 'master' | 'friend' | 'stranger' | 'assistant'

/**
 * 解析单条消息的 sender 身份。
 *
 * 优先级：
 *  1. `from_crab` 显式标记 / `crabDisplayName` 匹配 → assistant
 *  2. `platform_user_id` 是 'self' / 'assistant' 这类 channel-outbound 兜底标识 → assistant
 *     （channel message-store 落 outbound 时通常硬编码 'self'，
 *      dispatcher 预回复注入的合成 ChannelMessage 也用 'self'；
 *      admin-web get_chat_history 拉 assistant 消息用 'assistant'）
 *  3. msg.sender 与 senderFriend 匹配（friend_id 命中 或 channel_identities 命中）
 *     → senderFriend.permission === 'master' 时为 master，否则 friend
 *  4. 私聊场景下未匹配上 senderFriend → assistant（私聊只有两方，非 senderFriend 必是 crab）
 *  5. 其余：stranger
 *
 * 历史消息从 message-store 读出来通常**没有 friend_id**（store 只持久化
 * platform_user_id）。靠 channel_identities 反查识别 senderFriend；
 * 私聊场景下非 senderFriend 即 crab —— 这是私聊"两方对话"前提下的安全推理，
 * 比依赖可能漂移的 crabDisplayName 更稳。
 */
export function resolveSenderIdentity(args: {
  msg?: ChannelMessage
  senderFriend?: Friend
  crabDisplayName?: string
  /** 显式覆盖；否则从 msg.session.type 推断 */
  isGroup?: boolean
  /** backward-compat 显式标记 */
  from_crab?: boolean
}): SenderIdentity {
  if (args.from_crab) return 'assistant'
  if (!args.msg) return 'stranger'

  const { msg, senderFriend, crabDisplayName } = args
  const isGroup = args.isGroup ?? (msg.session.type === 'group')

  // channel-outbound 兜底标识：telegram message-store outbound 用 'self'，
  // admin-web get_chat_history assistant 消息用 'assistant'，
  // dispatcher 预回复注入的 ChannelMessage 也用 'self'。
  // Spec: 2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md §6
  if (msg.sender.platform_user_id === 'self' || msg.sender.platform_user_id === 'assistant') {
    return 'assistant'
  }

  if (crabDisplayName && msg.sender.platform_display_name === crabDisplayName) {
    return 'assistant'
  }

  if (senderFriend) {
    const friendIdMatch = msg.sender.friend_id === senderFriend.id
    const channelIdentityMatch = senderFriend.channel_identities.some(
      (c) =>
        c.channel_id === msg.session.channel_id &&
        c.platform_user_id === msg.sender.platform_user_id,
    )
    if (friendIdMatch || channelIdentityMatch) {
      return senderFriend.permission === 'master' ? 'master' : 'friend'
    }
    // 私聊场景下只有 senderFriend 和 crab 两个角色；非 senderFriend 必是 crab
    if (!isGroup) return 'assistant'
  }

  return 'stranger'
}
