/**
 * Channel onboarding 完成后的自动认主辅助。
 *
 * 设计见 crabot-docs/superpowers/specs/2026-06-02-feishu-onboarding-auto-master-design.md
 *
 * 本文件暴露 master 身份合并的纯决策函数；admin index.ts 在 handler 里组装磁盘 IO
 * 和 ChannelManager RPC 推送，再调用本文件的决策函数。
 */

import type { ModuleId } from 'crabot-shared'
import type { ChannelIdentity } from './types.js'

const ONBOARDING_DEFAULT_DISPLAY_NAME = '主人'

export interface MergeMasterIdentityResult {
  /** 应替换写入 master.channel_identities 的新数组 */
  identities: ChannelIdentity[]
  /** 旧的 identity（仅当被本次操作替换时填值），用于让 caller 清掉 channelIdentityIndex 旧 key */
  removedIdentity?: ChannelIdentity
  /** 是否发生了实际变更（用于 caller 决定是否 saveData） */
  changed: boolean
}

/**
 * 把扫码 owner 合入现有 master Friend 的 channel_identities。
 *
 * 决策表（按 channel_id 维度）：
 * - 现有 identities 中没有同 channel_id 的项 → 追加
 * - 有同 channel_id 同 platform_user_id → 不变（幂等）
 * - 有同 channel_id 但 platform_user_id 不同 → 覆盖（owner 换人，返回 removedIdentity 供 caller 清索引）
 */
export function mergeMasterChannelIdentity(
  existing: ReadonlyArray<ChannelIdentity>,
  channelId: ModuleId,
  ownerOpenId: string,
): MergeMasterIdentityResult {
  const next: ChannelIdentity = {
    channel_id: channelId,
    platform_user_id: ownerOpenId,
    platform_display_name: ONBOARDING_DEFAULT_DISPLAY_NAME,
  }
  const idx = existing.findIndex((ci) => ci.channel_id === channelId)
  if (idx < 0) {
    return { identities: [...existing, next], changed: true }
  }
  const old = existing[idx]
  if (old.platform_user_id === ownerOpenId) {
    return { identities: [...existing], changed: false }
  }
  const replaced = [...existing]
  replaced[idx] = next
  return { identities: replaced, removedIdentity: old, changed: true }
}

/**
 * 新建 master Friend 时使用的初始 display_name。
 * 占位用，admin 的 resolveFriend 流程在 master 首次发消息时会刷新成真实昵称。
 */
export const ONBOARDING_MASTER_DEFAULT_DISPLAY_NAME = ONBOARDING_DEFAULT_DISPLAY_NAME

/**
 * 构造给 master 推送的 onboarding 引导文案。
 *
 * 注意：私聊只发 scope_grant_url 这一条信息。其他状态（实例已启动 / 已认主）
 * 在 Admin Web 上有视觉反馈，私聊里不重复。
 */
export function buildOnboardingPushMessage(scopeGrantUrl: string): string {
  return [
    '您是这台 Crabot 的主人 ✓',
    '',
    '扫码已完成。还差最后一步：去飞书开发者后台批准群相关权限，否则群消息接收 / 群成员查询会报错。',
    '',
    `点击批准：${scopeGrantUrl}`,
    '',
    '完成后 Crabot 在群里就能正常工作了。',
  ].join('\n')
}
