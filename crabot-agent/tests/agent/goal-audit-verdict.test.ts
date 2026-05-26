import { describe, expect, it } from 'vitest'
import { buildAuditVerdictSummary, AUDIT_PARSE_FAILURE_SENTINEL } from '../../src/agent/goal-audit.js'

describe('buildAuditVerdictSummary', () => {
  it('pass 时返回 summary 只含 [audit PASS] 标签，无 error', () => {
    const r = buildAuditVerdictSummary({ pass: true, failedCriteria: [], rawOutput: '' })
    expect(r.summary).toBe('[audit PASS]')
    expect(r.error).toBeUndefined()
  })

  it('fail 时 summary 含 [audit FAIL] + 失败 criteria 列表 + error 字段', () => {
    const r = buildAuditVerdictSummary({
      pass: false,
      failedCriteria: ['c-typecheck', 'c-tests'],
      rawOutput: '',
    })
    expect(r.summary).toBe('[audit FAIL] 不达标: c-typecheck, c-tests')
    expect(r.error).toBe('不达标: c-typecheck, c-tests')
  })

  it('fail 但 failedCriteria 为空（罕见 case）→ 不附 criteria 列表', () => {
    const r = buildAuditVerdictSummary({ pass: false, failedCriteria: [], rawOutput: '' })
    expect(r.summary).toBe('[audit FAIL]')
    expect(r.error).toBe('审计未通过')
  })

  it('哨兵 failure（auditor 没 emit AUDIT_RESULT）→ summary 显式带哨兵串', () => {
    const r = buildAuditVerdictSummary({
      pass: false,
      failedCriteria: [AUDIT_PARSE_FAILURE_SENTINEL],
      rawOutput: 'auditor 输出乱七八糟没结论',
    })
    expect(r.summary).toContain('[audit FAIL]')
    expect(r.summary).toContain(AUDIT_PARSE_FAILURE_SENTINEL)
    expect(r.error).toContain(AUDIT_PARSE_FAILURE_SENTINEL)
  })
})
