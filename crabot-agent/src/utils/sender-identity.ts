import type { ChannelMessage, Friend } from '../types.js'

export type SenderIdentity = 'master' | 'friend' | 'stranger' | 'assistant'

export function resolveSenderIdentity(args: {
  msg?: ChannelMessage
  senderFriend?: Friend
  from_crab?: boolean
}): SenderIdentity {
  if (args.from_crab) return 'assistant'
  const friendId = args.msg?.sender.friend_id
  if (!friendId) return 'stranger'
  if (args.senderFriend && args.senderFriend.id === friendId && args.senderFriend.permission === 'master') {
    return 'master'
  }
  return 'friend'
}
