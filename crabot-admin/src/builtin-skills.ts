/**
 * Crabot 内置 Skill 注入数据。
 *
 * SKILL.md 内容来自 ./builtin-skills/*.md（snapshot of superpowers v5.0.7 MIT），
 * 启动时由 readFileSync 同步加载到内存。
 *
 * 由 AdminModule.initialize() 在 SkillManager.initialize() 之后调用 seedBuiltinSkills。
 * Spec: crabot-docs/superpowers/specs/2026-05-18-subagent-phase2b-builtin-design.md §2
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import type { SkillRegistryEntry } from './mcp-skill-manager.js'

// CommonJS: __dirname 在 tsconfig module: "commonjs" 下自动可用
// dev（vitest）: __dirname = .../crabot-admin/src → ../builtin-skills = crabot-admin/builtin-skills ✅
// prod（编译后）: __dirname = .../crabot-admin/dist → ../builtin-skills = crabot-admin/builtin-skills ✅
const SKILL_DIR = join(__dirname, '..', 'builtin-skills')
const SEED_TIMESTAMP = '2026-05-18T00:00:00.000Z'

function loadSkillContent(filename: string): string {
  try {
    return readFileSync(join(SKILL_DIR, filename), 'utf-8')
  } catch (err) {
    throw new Error(
      `Failed to load builtin skill snapshot ${filename} from ${SKILL_DIR}: ${(err as Error).message}`
    )
  }
}

export const BUILTIN_SKILL_IDS = {
  writingPlans: 'builtin-skill-writing-plans',
  systematicDebugging: 'builtin-skill-systematic-debugging',
  verificationBeforeCompletion: 'builtin-skill-verification-before-completion',
} as const

export function getBuiltinSkills(): SkillRegistryEntry[] {
  return [
    {
      id: BUILTIN_SKILL_IDS.writingPlans,
      name: 'writing-plans',
      description: 'planner 输出 plan 的标准（含自检流程）；用于 code_planner 的核心行为规范',
      version: '1.0.0-superpowers-5.0.7',
      content: loadSkillContent('writing-plans.md'),
      is_builtin: true,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: SEED_TIMESTAMP,
      updated_at: SEED_TIMESTAMP,
    },
    {
      id: BUILTIN_SKILL_IDS.systematicDebugging,
      name: 'systematic-debugging',
      description: '调试时找根因而非随机 fix；用于 code_writer 在测试失败时的策略',
      version: '1.0.0-superpowers-5.0.7',
      content: loadSkillContent('systematic-debugging.md'),
      is_builtin: true,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: SEED_TIMESTAMP,
      updated_at: SEED_TIMESTAMP,
    },
    {
      id: BUILTIN_SKILL_IDS.verificationBeforeCompletion,
      name: 'verification-before-completion',
      description: '完成前必须运行 verification 命令再上报；用于 code_writer 防"假完成"',
      version: '1.0.0-superpowers-5.0.7',
      content: loadSkillContent('verification-before-completion.md'),
      is_builtin: true,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: SEED_TIMESTAMP,
      updated_at: SEED_TIMESTAMP,
    },
  ]
}
