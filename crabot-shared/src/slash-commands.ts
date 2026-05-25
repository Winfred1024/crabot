/**
 * 系统 slash 指令常量 + 谓词。
 *
 * - admin 的 handleChannelMessage 在拦截这些 slash 后完全 engine 路径处理
 *   （不放行到 agent），admin 主动发出的系统话术统一加 [系统响应 <slash>] 前缀
 * - inbound slash 字面原文透传给 worker（靠 prompt 教化不模仿）
 * - outbound 老版裸 hint（无前缀）由 context-assembler 读时兜底加前缀
 *
 * Spec: 2026-05-25-goal-slash-commands-design.md §6
 */

// === 认主类 slash（全部中文，英文 /pair /apply 已废） ===
export const CLAIM_PAIR_COMMANDS: ReadonlySet<string> = new Set(['/认主'])
export const CLAIM_COMMANDS: ReadonlySet<string> = new Set(['/认主', '/加好友'])

// === Goal slash 三条（独立 prefix / 整词，无子命令） ===
export const GOAL_SHOW_PREFIX = '/目标 ' as const
export const GOAL_CLEAR_PREFIX = '/清除目标 ' as const
export const GOAL_LIST_EXACT = '/目标列表' as const
// 漏 id 的兜底字面（用户只发 /目标 或 /清除目标 时进入引导话术）
export const GOAL_SHOW_BARE = '/目标' as const
export const GOAL_CLEAR_BARE = '/清除目标' as const

// === 系统响应前缀（admin 主动发出 outbound 话术统一前缀） ===
const SYSTEM_RESPONSE_PREFIX = '[系统响应 '

export function isSlashSystemResponse(text: string | undefined | null): boolean {
  if (typeof text !== 'string') return false
  return text.trimStart().startsWith(SYSTEM_RESPONSE_PREFIX)
}

// === 老版裸 hint 字面（用于 context-assembler 老消息兜底） ===
export const LEGACY_UNCLAIMED_HINT_TEXT =
  '渠道未认主，请输入"/认主"，然后到 crabot 后台 对话对象->申请队列 中进行审批创建 Master 后方可正常对话。'

export const LEGACY_ALREADY_CLAIMED_HINT_TEXT =
  '当前渠道已认主，无需重复发送 /认主、/pair、/apply。'

export function isLegacyUnclaimedHint(text: string | undefined | null): boolean {
  if (typeof text !== 'string') return false
  return text === LEGACY_UNCLAIMED_HINT_TEXT
}

export function isLegacyAlreadyClaimedHint(text: string | undefined | null): boolean {
  if (typeof text !== 'string') return false
  return text === LEGACY_ALREADY_CLAIMED_HINT_TEXT
}

// === 新版 hint 文本（带 [系统响应 /认主] 前缀） ===
export const UNCLAIMED_HINT_TEXT =
  `[系统响应 /认主]\n渠道未认主，请输入"/认主"，然后到 crabot 后台 对话对象->申请队列 中进行审批创建 Master 后方可正常对话。`

export const ALREADY_CLAIMED_HINT_TEXT =
  `[系统响应 /认主]\n当前渠道已认主，无需重复发送 /认主、/加好友。`

// === 老式谓词，保留旧名转调（避免现有 import 大改） ===
export function isClaimCommand(text: string | undefined | null): boolean {
  if (typeof text !== 'string') return false
  return CLAIM_COMMANDS.has(text.trim())
}

const SYSTEM_HINT_TEXTS: ReadonlySet<string> = new Set([
  UNCLAIMED_HINT_TEXT,
  ALREADY_CLAIMED_HINT_TEXT,
  LEGACY_UNCLAIMED_HINT_TEXT,
  LEGACY_ALREADY_CLAIMED_HINT_TEXT,
])

export function isClaimSystemHint(text: string | undefined | null): boolean {
  if (typeof text !== 'string') return false
  return SYSTEM_HINT_TEXTS.has(text)
}
