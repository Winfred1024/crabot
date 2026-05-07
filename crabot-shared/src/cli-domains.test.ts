import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { classifyCliSubcommand, REQUIRES_CONTENT_REVIEW } from './cli-domains.js'

describe('classifyCliSubcommand', () => {
  it('write 类命令', () => {
    assert.deepEqual(classifyCliSubcommand('provider add'), { domain: 'provider', kind: 'write' })
    assert.deepEqual(classifyCliSubcommand('schedule add'), { domain: 'schedule', kind: 'write' })
    assert.deepEqual(classifyCliSubcommand('mcp toggle'), { domain: 'mcp', kind: 'write' })
    assert.deepEqual(classifyCliSubcommand('agent set-model'), { domain: 'agent', kind: 'write' })
    assert.deepEqual(classifyCliSubcommand('config switch-default'), { domain: 'config', kind: 'write' })
    assert.deepEqual(classifyCliSubcommand('undo'), { domain: 'undo', kind: 'write' })
  })

  it('read 类命令', () => {
    assert.deepEqual(classifyCliSubcommand('provider list'), { domain: 'provider', kind: 'read' })
    assert.deepEqual(classifyCliSubcommand('agent show'), { domain: 'agent', kind: 'read' })
    assert.deepEqual(classifyCliSubcommand('agent doctor'), { domain: 'agent', kind: 'read' })
    assert.deepEqual(classifyCliSubcommand('schedule list'), { domain: 'schedule', kind: 'read' })
  })

  it('未知命令返回 null', () => {
    assert.equal(classifyCliSubcommand('foo bar'), null)
    assert.equal(classifyCliSubcommand(''), null)
  })

  it('全部 10 个 domain 都被覆盖（至少一条命令）', () => {
    const expectedDomains = new Set([
      'provider', 'agent', 'mcp', 'skill', 'schedule',
      'channel', 'friend', 'permission', 'config', 'undo',
    ])
    const samples: ReadonlyArray<readonly [string, string]> = [
      ['provider', 'provider list'],
      ['agent', 'agent list'],
      ['mcp', 'mcp list'],
      ['skill', 'skill list'],
      ['schedule', 'schedule list'],
      ['channel', 'channel list'],
      ['friend', 'friend list'],
      ['permission', 'permission list'],
      ['config', 'config show'],
      ['undo', 'undo'],
    ]
    for (const [domain, cmd] of samples) {
      const cls = classifyCliSubcommand(cmd)
      assert.ok(cls, `command "${cmd}" should classify`)
      assert.equal(cls!.domain, domain, `command "${cmd}" should map to domain ${domain}`)
    }
    assert.equal(samples.length, expectedDomains.size)
  })
})

describe('REQUIRES_CONTENT_REVIEW', () => {
  it('schedule add 在内', () => {
    assert.ok(REQUIRES_CONTENT_REVIEW.has('schedule add'))
  })
  it('其他 write 命令不在', () => {
    assert.ok(!REQUIRES_CONTENT_REVIEW.has('provider add'))
    assert.ok(!REQUIRES_CONTENT_REVIEW.has('mcp add'))
    assert.ok(!REQUIRES_CONTENT_REVIEW.has('agent restart'))
    assert.ok(!REQUIRES_CONTENT_REVIEW.has('schedule trigger'))
    assert.ok(!REQUIRES_CONTENT_REVIEW.has('schedule delete'))
  })
})
