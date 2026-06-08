/**
 * shouldSkipTaskReflection 决策表测试。
 *
 * Spec: crabot-docs/superpowers/specs/2026-06-03-dispatcher-immediate-reply-and-overdue-removal-design.md §7.2.1
 */

import { describe, it, expect } from 'vitest'
import {
  shouldSkipTaskReflection,
  TOOL_CALL_REFLECTION_THRESHOLD,
} from '../../src/agent/agent-handler.js'

function r(overrides: Partial<Parameters<typeof shouldSkipTaskReflection>[0]> = {}) {
  return {
    outcome: 'completed' as const,
    tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD,
    wrote_memory_or_scene: false,
    ...overrides,
  }
}

describe('shouldSkipTaskReflection', () => {
  it('正常长跑 + 没写记忆 → 跑反思（不 skip）', () => {
    expect(shouldSkipTaskReflection(r({
      tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD,
      wrote_memory_or_scene: false,
    }))).toBe(false)
  })

  it('早退（exitsLoop 工具触发，有 exitToolCall）→ skip', () => {
    expect(shouldSkipTaskReflection(r({
      exitToolCall: { name: 'submit_audit_result', input: {} },
      tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD * 2,  // 即使长跑也 skip
    }))).toBe(true)
  })

  it('outcome=failed → skip', () => {
    expect(shouldSkipTaskReflection(r({
      outcome: 'failed',
      tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD * 2,
    }))).toBe(true)
  })

  it('outcome=max_turns → skip（非 completed 都 skip）', () => {
    expect(shouldSkipTaskReflection(r({
      outcome: 'max_turns',
      tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD * 2,
    }))).toBe(true)
  })

  it('outcome=aborted → skip', () => {
    expect(shouldSkipTaskReflection(r({
      outcome: 'aborted',
      tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD * 2,
    }))).toBe(true)
  })

  it('tool_call_count < 阈值 → skip（"没什么值得反思的"）', () => {
    expect(shouldSkipTaskReflection(r({
      tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD - 1,
    }))).toBe(true)
  })

  it('tool_call_count == 阈值 → 不 skip（边界 inclusive）', () => {
    expect(shouldSkipTaskReflection(r({
      tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD,
    }))).toBe(false)
  })

  it('worker 主动 store_memory / set_scene_profile → skip（反思兜底不必要）', () => {
    expect(shouldSkipTaskReflection(r({
      tool_call_count: TOOL_CALL_REFLECTION_THRESHOLD * 2,
      wrote_memory_or_scene: true,
    }))).toBe(true)
  })

  it('TOOL_CALL_REFLECTION_THRESHOLD 是模块常量', () => {
    expect(TOOL_CALL_REFLECTION_THRESHOLD).toBe(10)
  })
})
