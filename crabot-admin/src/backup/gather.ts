/**
 * 把选中类别从 DATA_DIR 文件快照进 staging/payload/<category>/。
 * 文件层面复制（热拷安全：admin 用 tmp+rename 原子写，memory long_term 逐文件原子写）。
 * 设计依据：2026-06-19-crabot-backup-migration-design.md §5 / §6.4
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { CATEGORY_PATHS } from './categories.js'
import { scrubProvidersJson, scrubChannelConfigJson } from './scrub-secrets.js'
import type { BackupCategory, BackupSelection } from './types.js'

export type GatherDeps = {
  adminDataDir: string
  memoryDataDir: string
  /** 服务在跑时注入：调 memory export_memories RPC 拿短期记忆 + 水位；离线时不传。 */
  exportShortTermMemory?: () => Promise<unknown>
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 复制单文件，按需 scrub。 */
async function copyFileWithScrub(
  srcDir: string, destDir: string, rel: string, includeSecrets: boolean,
): Promise<void> {
  const src = path.join(srcDir, rel)
  if (!(await exists(src))) return
  const dest = path.join(destDir, rel)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  if (!includeSecrets && rel === 'model_providers.json') {
    await fs.writeFile(dest, scrubProvidersJson(await fs.readFile(src, 'utf-8')))
    return
  }
  await fs.copyFile(src, dest)
}

/** 复制整目录；channel-configs 目录下的 json 在不含密钥时逐个 scrub。 */
async function copyDirWithScrub(
  srcDir: string, destDir: string, rel: string, includeSecrets: boolean,
): Promise<void> {
  const src = path.join(srcDir, rel)
  if (!(await exists(src))) return
  const dest = path.join(destDir, rel)
  if (!includeSecrets && rel === 'channel-configs') {
    await fs.mkdir(dest, { recursive: true })
    for (const name of await fs.readdir(src)) {
      const s = path.join(src, name)
      if ((await fs.stat(s)).isFile() && name.endsWith('.json')) {
        await fs.writeFile(path.join(dest, name), scrubChannelConfigJson(await fs.readFile(s, 'utf-8')))
      } else {
        await fs.cp(s, path.join(dest, name), { recursive: true })
      }
    }
    return
  }
  await fs.cp(src, dest, { recursive: true })
}

async function gatherOne(
  category: BackupCategory, payloadDir: string, selection: BackupSelection, deps: GatherDeps,
): Promise<void> {
  const destDir = path.join(payloadDir, category)
  if (category === 'memory') {
    const ltSrc = path.join(deps.memoryDataDir, 'long_term')
    if (await exists(ltSrc)) {
      await fs.cp(ltSrc, path.join(destDir, 'long_term'), { recursive: true })
    }
    if (deps.exportShortTermMemory) {
      const data = await deps.exportShortTermMemory()
      await fs.mkdir(destDir, { recursive: true })
      await fs.writeFile(path.join(destDir, 'short_term.json'), JSON.stringify(data, null, 2))
    }
    return
  }
  for (const cp of CATEGORY_PATHS[category]) {
    if (cp.kind === 'file') {
      await copyFileWithScrub(deps.adminDataDir, destDir, cp.rel, selection.includeSecrets)
    } else {
      await copyDirWithScrub(deps.adminDataDir, destDir, cp.rel, selection.includeSecrets)
    }
  }
}

export async function gatherCategories(params: {
  staging: string
  selection: BackupSelection
  deps: GatherDeps
}): Promise<void> {
  const { staging, selection, deps } = params
  const payloadDir = path.join(staging, 'payload')
  await fs.mkdir(payloadDir, { recursive: true })
  for (const category of selection.categories) {
    await gatherOne(category, payloadDir, selection, deps)
  }
}
