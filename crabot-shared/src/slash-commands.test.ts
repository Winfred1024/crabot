import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  CLAIM_PAIR_COMMANDS,
  CLAIM_COMMANDS,
  GOAL_SHOW_PREFIX,
  GOAL_CLEAR_PREFIX,
  GOAL_LIST_EXACT,
  GOAL_SHOW_BARE,
  GOAL_CLEAR_BARE,
  UNCLAIMED_HINT_TEXT,
  ALREADY_CLAIMED_HINT_TEXT,
  normalizeSlash,
  isClaimCommand,
  isClaimSystemHint,
  isSlashSystemResponse,
  isLegacyUnclaimedHint,
  isLegacyAlreadyClaimedHint,
  LEGACY_UNCLAIMED_HINT_TEXT,
  LEGACY_ALREADY_CLAIMED_HINT_TEXT,
} from './slash-commands.js'

describe('CLAIM 常量', () => {
  it('CLAIM_PAIR_COMMANDS 只含 /认主（英文 /pair 已废）', () => {
    assert.deepEqual([...CLAIM_PAIR_COMMANDS].sort(), ['/认主'])
  })
  it('CLAIM_COMMANDS 只含 /认主 + /加好友（英文 /pair /apply 已废）', () => {
    assert.deepEqual([...CLAIM_COMMANDS].sort(), ['/加好友', '/认主'])
  })
})

describe('GOAL 常量', () => {
  it('GOAL_SHOW_PREFIX 有尾空格', () => {
    assert.equal(GOAL_SHOW_PREFIX, '/目标 ')
  })
  it('GOAL_CLEAR_PREFIX 有尾空格', () => {
    assert.equal(GOAL_CLEAR_PREFIX, '/清除目标 ')
  })
  it('GOAL_LIST_EXACT 无尾空格（整词匹配）', () => {
    assert.equal(GOAL_LIST_EXACT, '/目标列表')
  })
  it('BARE 形态用于漏 id 兜底', () => {
    assert.equal(GOAL_SHOW_BARE, '/目标')
    assert.equal(GOAL_CLEAR_BARE, '/清除目标')
  })
})

describe('hint 文本', () => {
  it('UNCLAIMED_HINT_TEXT 带 [系统响应 /认主] 前缀', () => {
    assert.ok(UNCLAIMED_HINT_TEXT.startsWith('[系统响应 /认主]\n'))
  })
  it('UNCLAIMED_HINT_TEXT 不含废除的英文 slash', () => {
    assert.ok(!UNCLAIMED_HINT_TEXT.includes('/pair'))
    assert.ok(!UNCLAIMED_HINT_TEXT.includes('/apply'))
  })
  it('UNCLAIMED_HINT_TEXT 提到 /认主', () => {
    assert.ok(UNCLAIMED_HINT_TEXT.includes('/认主'))
  })
  it('ALREADY_CLAIMED_HINT_TEXT 带 [系统响应 /认主] 前缀', () => {
    assert.ok(ALREADY_CLAIMED_HINT_TEXT.startsWith('[系统响应 /认主]\n'))
  })
  it('ALREADY_CLAIMED_HINT_TEXT 提到 /认主 和 /加好友', () => {
    assert.ok(ALREADY_CLAIMED_HINT_TEXT.includes('/认主'))
    assert.ok(ALREADY_CLAIMED_HINT_TEXT.includes('/加好友'))
  })
})

describe('isClaimCommand（保留旧名）', () => {
  it('识别中文 slash', () => {
    assert.equal(isClaimCommand('/认主'), true)
    assert.equal(isClaimCommand('/加好友'), true)
  })
  it('不再识别废除的英文 slash', () => {
    assert.equal(isClaimCommand('/pair'), false)
    assert.equal(isClaimCommand('/apply'), false)
  })
  it('trim 后匹配', () => {
    assert.equal(isClaimCommand('  /认主  '), true)
  })
  it('尾部带零宽字符仍匹配（IM/复制粘贴常见，裸 trim 去不掉）', () => {
    assert.equal(isClaimCommand("/认主\u200B"), true)       // 尾零宽空格
    assert.equal(isClaimCommand("/认主\uFEFF"), true)       // 尾 BOM
    assert.equal(isClaimCommand("\u2060/加好友\u200D"), true) // 首尾 word joiner + ZWJ
  })
  it('非字符串安全', () => {
    assert.equal(isClaimCommand(null), false)
    assert.equal(isClaimCommand(undefined), false)
  })
})

describe('normalizeSlash', () => {
  it('去掉零宽 / 变体选择符 + trim', () => {
    assert.equal(normalizeSlash("/认主\u200B"), "/认主")
    assert.equal(normalizeSlash("\uFEFF/认主\u200D"), "/认主")
    assert.equal(normalizeSlash("  /目标 a3f8\u2060  "), "/目标 a3f8")
  })
  it('NFC 归一', () => {
    // 'é' 组合形式 (e + U+0301) → NFC 单码点
    assert.equal(normalizeSlash("e\u0301"), "\u00E9")
  })
  it('非字符串安全', () => {
    assert.equal(normalizeSlash(null), '')
    assert.equal(normalizeSlash(undefined), '')
  })
})

describe('isSlashSystemResponse', () => {
  it('识别 [系统响应 任意 slash] 开头', () => {
    assert.equal(isSlashSystemResponse('[系统响应 /认主]\n...'), true)
    assert.equal(isSlashSystemResponse('[系统响应 /清除目标 a3f8]\n已清除...'), true)
    assert.equal(isSlashSystemResponse('[系统响应 /目标列表]\n...'), true)
  })
  it('忽略前导空白', () => {
    assert.equal(isSlashSystemResponse('  [系统响应 /认主]'), true)
  })
  it('不匹配相似但不同的前缀', () => {
    assert.equal(isSlashSystemResponse('系统响应 /认主'), false)
    assert.equal(isSlashSystemResponse('[系统]'), false)
  })
})

describe('isClaimSystemHint（保留旧名，识别新前缀 + 老裸字符串）', () => {
  it('识别新版 [系统响应 /认主] 前缀的 hint', () => {
    assert.equal(isClaimSystemHint(UNCLAIMED_HINT_TEXT), true)
    assert.equal(isClaimSystemHint(ALREADY_CLAIMED_HINT_TEXT), true)
  })
  it('识别老版裸 hint 字符串', () => {
    assert.equal(isClaimSystemHint(LEGACY_UNCLAIMED_HINT_TEXT), true)
    assert.equal(isClaimSystemHint(LEGACY_ALREADY_CLAIMED_HINT_TEXT), true)
  })
  it('不匹配普通文本', () => {
    assert.equal(isClaimSystemHint('hello'), false)
  })
})

describe('isLegacyUnclaimedHint / isLegacyAlreadyClaimedHint', () => {
  it('仅识别老版裸字符串，不识别新版带前缀', () => {
    assert.equal(isLegacyUnclaimedHint(LEGACY_UNCLAIMED_HINT_TEXT), true)
    assert.equal(isLegacyUnclaimedHint(UNCLAIMED_HINT_TEXT), false)
    assert.equal(isLegacyAlreadyClaimedHint(LEGACY_ALREADY_CLAIMED_HINT_TEXT), true)
    assert.equal(isLegacyAlreadyClaimedHint(ALREADY_CLAIMED_HINT_TEXT), false)
  })
})
