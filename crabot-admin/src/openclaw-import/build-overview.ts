/**
 * 组装 OpenClaw 备份概览：读 manifest + config，跑三分析器，检出 skills/memory/workspace。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §4 / §5 / §8
 * 只读小文件 + 列条目检测，不全解压。
 */
import path from 'node:path'
import { listArchiveEntries, readArchiveTextFile } from './archive-reader.js'
import { validateManifest } from './validate-manifest.js'
import { buildArchivePayloadPath } from './encode-archive-path.js'
import { analyzeProviders, type AnalyzedProvider } from './analyze-providers.js'
import { analyzeChannels, type AnalyzedChannel } from './analyze-channels.js'
import { analyzeMcpServers, type AnalyzedMcpServer } from './analyze-mcp.js'
import type { OpenClawModelsConfig, OpenClawChannelsConfig, OpenClawMcpConfig } from './openclaw-config.js'

/** 概览里的 provider：脱敏，绝不含 api_key 明文（概览会发给浏览器）。 */
export type ProviderOverviewItem = {
  source_name: string
  endpoint: string
  format: AnalyzedProvider['format']
  migratable: boolean
  skip_reason?: AnalyzedProvider['skip_reason']
  has_api_key: boolean
}

export type BackupOverview = {
  manifest: { schemaVersion: 1; includeWorkspace: boolean; createdAt: string; runtimeVersion: string }
  providers: ProviderOverviewItem[]
  channels: AnalyzedChannel[]
  mcpServers: AnalyzedMcpServer[]
  /** 检出的 skill 目录名 */
  skills: string[]
  /** 记忆内容（workspace 的 MEMORY.md + memory/*.md） */
  memory: { present: boolean; fileCount: number }
  /** workspace 非记忆文件 */
  workspace: { present: boolean; fileCount: number }
}

type OpenClawConfig = {
  channels?: OpenClawChannelsConfig
  models?: OpenClawModelsConfig
  mcp?: OpenClawMcpConfig
}

/** manifest.paths 子集（只取本模块用到的字段）。 */
type ManifestPaths = { stateDir: string; configPath: string; workspaceDirs: string[] }

function readManifestPaths(raw: unknown): ManifestPaths {
  const paths = (raw as { paths?: Record<string, unknown> })?.paths ?? {}
  return {
    stateDir: typeof paths.stateDir === 'string' ? paths.stateDir : '',
    configPath: typeof paths.configPath === 'string' ? paths.configPath : '',
    workspaceDirs: Array.isArray(paths.workspaceDirs) ? (paths.workspaceDirs.filter((p) => typeof p === 'string') as string[]) : [],
  }
}

function isFileEntry(entry: string): boolean {
  return !entry.endsWith('/')
}

/** 检出 skills/<name>/ 目录名。 */
function detectSkills(entries: string[], archiveRoot: string, stateDir: string): string[] {
  const prefix = `${buildArchivePayloadPath(archiveRoot, path.posix.join(stateDir, 'skills'))}/`
  const names = new Set<string>()
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const rest = entry.slice(prefix.length)
    const name = rest.split('/')[0]
    if (name) names.add(name)
  }
  return [...names]
}

/** 检出记忆文件（workspace 根 MEMORY.md/memory.md + memory/ 下文件）与其余 workspace 文件。 */
function detectMemoryAndWorkspace(
  entries: string[],
  archiveRoot: string,
  workspaceDirs: string[],
): { memory: number; workspace: number } {
  let memory = 0
  let workspace = 0
  for (const wsDir of workspaceDirs) {
    const wsPrefix = `${buildArchivePayloadPath(archiveRoot, wsDir)}/`
    const rootMemory = new Set([
      buildArchivePayloadPath(archiveRoot, path.posix.join(wsDir, 'MEMORY.md')),
      buildArchivePayloadPath(archiveRoot, path.posix.join(wsDir, 'memory.md')),
    ])
    const memoryDirPrefix = `${buildArchivePayloadPath(archiveRoot, path.posix.join(wsDir, 'memory'))}/`

    for (const entry of entries) {
      if (!entry.startsWith(wsPrefix) || !isFileEntry(entry)) continue
      if (rootMemory.has(entry) || entry.startsWith(memoryDirPrefix)) {
        memory += 1
      } else {
        workspace += 1
      }
    }
  }
  return { memory, workspace }
}

export async function buildBackupOverview(
  archivePath: string,
): Promise<{ ok: true; overview: BackupOverview } | { ok: false; error: string }> {
  const entries = await listArchiveEntries(archivePath)

  const manifestEntry = entries.find((e) => e.endsWith('/manifest.json') && !e.includes('/payload/'))
  if (!manifestEntry) {
    return { ok: false, error: '备份缺少 manifest.json' }
  }
  const manifestText = await readArchiveTextFile(archivePath, manifestEntry)
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(manifestText ?? '')
  } catch {
    return { ok: false, error: 'manifest.json 解析失败' }
  }

  const validation = validateManifest(manifestRaw)
  if (!validation.ok) {
    return { ok: false, error: validation.error }
  }

  const archiveRoot = path.posix.dirname(manifestEntry)
  const mPaths = readManifestPaths(manifestRaw)

  const configEntry = buildArchivePayloadPath(archiveRoot, mPaths.configPath)
  const configText = await readArchiveTextFile(archivePath, configEntry)
  let config: OpenClawConfig = {}
  if (configText) {
    try {
      config = JSON.parse(configText) as OpenClawConfig
    } catch {
      return { ok: false, error: 'openclaw.json 解析失败' }
    }
  }

  const skills = detectSkills(entries, archiveRoot, mPaths.stateDir)
  const counts = validation.includeWorkspace
    ? detectMemoryAndWorkspace(entries, archiveRoot, mPaths.workspaceDirs)
    : { memory: 0, workspace: 0 }

  return {
    ok: true,
    overview: {
      manifest: {
        schemaVersion: 1,
        includeWorkspace: validation.includeWorkspace,
        createdAt: validation.createdAt,
        runtimeVersion: validation.runtimeVersion,
      },
      providers: analyzeProviders(config.models).map((p) => ({
        source_name: p.source_name,
        endpoint: p.endpoint,
        format: p.format,
        migratable: p.migratable,
        ...(p.skip_reason ? { skip_reason: p.skip_reason } : {}),
        has_api_key: p.api_key !== null,
      })),
      channels: analyzeChannels(config.channels),
      mcpServers: analyzeMcpServers(config.mcp),
      skills,
      memory: { present: counts.memory > 0, fileCount: counts.memory },
      workspace: { present: counts.workspace > 0, fileCount: counts.workspace },
    },
  }
}
