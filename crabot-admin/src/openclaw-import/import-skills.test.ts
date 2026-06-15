/**
 * skill 导入编排测试：整目录 extract → importFromLocalPath，冲突跳过（真实归档 fixture）。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §5.5 / §7 / §8
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { importSkills } from './import-skills.js'

let tmpRoot: string
let archivePath: string
const SKILLS_PREFIX = 'bk-root/payload/posix/h/.openclaw/skills'

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-skills-'))
  const skills = path.join(tmpRoot, 'bk-root', 'payload', 'posix', 'h', '.openclaw', 'skills')
  await fs.mkdir(path.join(skills, 'foo'), { recursive: true })
  await fs.writeFile(path.join(skills, 'foo', 'SKILL.md'), '# foo', 'utf8')
  await fs.mkdir(path.join(skills, 'bar'), { recursive: true })
  await fs.writeFile(path.join(skills, 'bar', 'SKILL.md'), '# bar', 'utf8')
  archivePath = path.join(tmpRoot, 'backup.tar.gz')
  await tar.c({ file: archivePath, gzip: true, cwd: tmpRoot }, ['bk-root'])
})

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

function makeDeps(existing: string[] = []) {
  const installed: string[] = []
  return {
    installed,
    deps: {
      existingSkillNames: new Set(existing),
      importSkillDir: vi.fn(async (dir: string) => {
        // 校验：extract 出来的目录里确有 SKILL.md
        await fs.access(path.join(dir, 'SKILL.md'))
        installed.push(path.basename(dir))
      }),
    },
  }
}

describe('importSkills', () => {
  it('选中的 skill extract 出目录并 importFromLocalPath，结果 imported', async () => {
    const { installed, deps } = makeDeps()
    const tempDir = path.join(tmpRoot, 'extract1')

    const results = await importSkills({ archivePath, skillsArchivePrefix: SKILLS_PREFIX, skillNames: ['foo', 'bar'], tempDir, deps })

    expect(installed.sort()).toEqual(['bar', 'foo'])
    expect(results.filter((r) => r.status === 'imported').map((r) => r.name).sort()).toEqual(['bar', 'foo'])
  })

  it('crabot 已有同名 skill → 跳过 conflict，不 import', async () => {
    const { installed, deps } = makeDeps(['foo'])
    const tempDir = path.join(tmpRoot, 'extract2')

    const results = await importSkills({ archivePath, skillsArchivePrefix: SKILLS_PREFIX, skillNames: ['foo'], tempDir, deps })

    expect(installed).toEqual([])
    expect(results).toEqual([{ kind: 'skill', name: 'foo', status: 'skipped', reason: 'conflict' }])
  })
})
