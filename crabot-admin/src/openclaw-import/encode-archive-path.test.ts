/**
 * 归档 payload 路径编码测试（移植自 OpenClaw backup-shared.ts，须一字不差对齐）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §4
 */
import { describe, it, expect } from 'vitest'
import { encodeAbsolutePathForBackupArchive, buildArchivePayloadPath } from './encode-archive-path.js'

describe('encodeAbsolutePathForBackupArchive', () => {
  it('posix 绝对路径 → posix/<去掉前导斜杠>', () => {
    expect(encodeAbsolutePathForBackupArchive('/Users/x/.openclaw')).toBe('posix/Users/x/.openclaw')
  })

  it('windows 路径 → windows/<大写盘符>/<rest>', () => {
    expect(encodeAbsolutePathForBackupArchive('C:\\Users\\x')).toBe('windows/C/Users/x')
    expect(encodeAbsolutePathForBackupArchive('d:\\foo\\bar')).toBe('windows/D/foo/bar')
  })

  it('相对路径 → relative/<path>', () => {
    expect(encodeAbsolutePathForBackupArchive('foo/bar')).toBe('relative/foo/bar')
  })
})

describe('buildArchivePayloadPath', () => {
  it('拼出 <archiveRoot>/payload/<encoded>', () => {
    expect(buildArchivePayloadPath('bk-root', '/Users/x/.openclaw/openclaw.json')).toBe(
      'bk-root/payload/posix/Users/x/.openclaw/openclaw.json',
    )
  })
})
