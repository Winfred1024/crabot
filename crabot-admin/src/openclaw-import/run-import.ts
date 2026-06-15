/**
 * top 导入编排：解析归档 → 按 selection 路由到各导入器 → 汇总 → 清理临时目录。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §8 / §9
 * v1 不做跨资源自动 delete 回滚（导入 additive + 冲突跳过可重入；部分失败在 summary 里可见）。
 * 临时提取目录在 finally 中清理（用后即焚）。
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { listArchiveEntries, readArchiveTextFile } from './archive-reader.js'
import { validateManifest } from './validate-manifest.js'
import { buildArchivePayloadPath } from './encode-archive-path.js'
import { importProviders, type ProviderImportDeps } from './import-providers.js'
import { importChannels, type ChannelImportDeps, type ChannelSelection } from './import-channels.js'
import { importMcpServers, type McpImportDeps } from './import-mcp.js'
import { importSkills, type SkillImportDeps } from './import-skills.js'
import { importMemory, type MemoryImportDeps } from './import-memory.js'
import { importWorkspace } from './import-workspace.js'
import type { ImportItemResult } from './import-types.js'
import type { OpenClawModelsConfig, OpenClawChannelsConfig, OpenClawMcpConfig } from './openclaw-config.js'

export type ImportSelections = {
  providers: string[]
  channels: ChannelSelection[]
  mcp: string[]
  skills: string[]
  memory: boolean
  workspace: boolean
}

export type ImportDeps = ProviderImportDeps &
  ChannelImportDeps &
  McpImportDeps &
  SkillImportDeps &
  MemoryImportDeps & {
    /** workspace 文件提取到的目标目录（建议 crabot workspace 下独立子目录，避免 clobber） */
    workspaceDestDir: string
  }

export type ImportSummary = { results: ImportItemResult[]; errors: string[] }

type OpenClawConfig = { channels?: OpenClawChannelsConfig; models?: OpenClawModelsConfig; mcp?: OpenClawMcpConfig }

/** 从归档条目里找出记忆 markdown（workspace 根 MEMORY.md/memory.md + memory/ 下文件）。 */
function findMemoryFileEntries(
  entries: string[],
  archiveRoot: string,
  workspaceDirs: string[],
): Array<{ name: string; entryPath: string }> {
  const found: Array<{ name: string; entryPath: string }> = []
  for (const wsDir of workspaceDirs) {
    const roots = new Set([
      buildArchivePayloadPath(archiveRoot, path.posix.join(wsDir, 'MEMORY.md')),
      buildArchivePayloadPath(archiveRoot, path.posix.join(wsDir, 'memory.md')),
    ])
    const memoryDirPrefix = `${buildArchivePayloadPath(archiveRoot, path.posix.join(wsDir, 'memory'))}/`
    const wsPrefix = `${buildArchivePayloadPath(archiveRoot, wsDir)}/`
    for (const entry of entries) {
      if (entry.endsWith('/')) continue
      if (roots.has(entry) || entry.startsWith(memoryDirPrefix)) {
        found.push({ name: entry.slice(wsPrefix.length), entryPath: entry })
      }
    }
  }
  return found
}

export async function runImport(params: {
  archivePath: string
  tempDir: string
  selections: ImportSelections
  deps: ImportDeps
}): Promise<ImportSummary> {
  const { archivePath, tempDir, selections, deps } = params
  const results: ImportItemResult[] = []
  const errors: string[] = []

  try {
    const entries = await listArchiveEntries(archivePath)
    const manifestEntry = entries.find((e) => e.endsWith('/manifest.json') && !e.includes('/payload/'))
    if (!manifestEntry) throw new Error('备份缺少 manifest.json')

    const manifestRaw = JSON.parse((await readArchiveTextFile(archivePath, manifestEntry)) ?? '')
    const validation = validateManifest(manifestRaw)
    if (!validation.ok) throw new Error(validation.error)

    const archiveRoot = path.posix.dirname(manifestEntry)
    const mPaths = (manifestRaw as { paths?: { stateDir?: string; configPath?: string; workspaceDirs?: string[] } }).paths ?? {}
    const stateDir = mPaths.stateDir ?? ''
    const configPath = mPaths.configPath ?? ''
    const workspaceDirs = (mPaths.workspaceDirs ?? []).filter((p): p is string => typeof p === 'string')

    const configText = await readArchiveTextFile(archivePath, buildArchivePayloadPath(archiveRoot, configPath))
    const config: OpenClawConfig = configText ? JSON.parse(configText) : {}

    // 配置类（顺序执行，每类独立捕获错误）
    await runStep(errors, 'provider', async () => {
      results.push(...(await importProviders(config.models, selections.providers, deps)))
    })
    await runStep(errors, 'channel', async () => {
      results.push(...(await importChannels(config.channels, selections.channels, deps)))
    })
    await runStep(errors, 'mcp', async () => {
      results.push(...(await importMcpServers(config.mcp, selections.mcp, deps)))
    })

    // skill：整目录 extract → importFromLocalPath
    if (selections.skills.length > 0) {
      await runStep(errors, 'skill', async () => {
        const skillsPrefix = buildArchivePayloadPath(archiveRoot, path.posix.join(stateDir, 'skills'))
        results.push(
          ...(await importSkills({ archivePath, skillsArchivePrefix: skillsPrefix, skillNames: selections.skills, tempDir: path.join(tempDir, 'skills'), deps })),
        )
      })
    }

    // memory：workspace markdown → Memory v2
    if (selections.memory && validation.includeWorkspace) {
      await runStep(errors, 'memory', async () => {
        const memoryFiles = findMemoryFileEntries(entries, archiveRoot, workspaceDirs)
        results.push(...(await importMemory({ archivePath, memoryFiles, deps })))
      })
    }

    // workspace：非记忆文件拷贝（此处提取整 workspace 子树到独立目录）
    if (selections.workspace && validation.includeWorkspace && workspaceDirs[0]) {
      await runStep(errors, 'workspace', async () => {
        const wsPrefix = buildArchivePayloadPath(archiveRoot, workspaceDirs[0])
        results.push(...(await importWorkspace({ archivePath, workspaceArchivePrefix: wsPrefix, destDir: deps.workspaceDestDir })))
      })
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }

  return { results, errors }
}

async function runStep(errors: string[], label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
