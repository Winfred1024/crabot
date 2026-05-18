/**
 * SubAgent 注册表管理器
 *
 * 仿 MCPServerManager / SkillManager 模式：data/admin/subagents.json + 文件原子写入。
 */

import fs from 'fs/promises'
import path from 'path'
import { generateId, generateTimestamp } from 'crabot-shared'
import type { SubAgentRegistryEntry } from './types.js'

export type CreateSubAgentParams = Omit<
  SubAgentRegistryEntry,
  'id' | 'is_builtin' | 'enabled' | 'created_at' | 'updated_at'
> & { enabled?: boolean }

export type UpdateSubAgentParams = Partial<
  Pick<
    SubAgentRegistryEntry,
    | 'name'
    | 'description'
    | 'when_to_use'
    | 'role'
    | 'workflow'
    | 'deliverables'
    | 'verification'
    | 'provider_id'
    | 'model_id'
    | 'model_role'
    | 'builtin_capabilities'
    | 'allowed_mcp_server_ids'
    | 'allowed_skill_ids'
    | 'max_turns'
    | 'hook_preset'
    | 'enabled'
  >
>

export class SubAgentManager {
  private entries: Map<string, SubAgentRegistryEntry> = new Map()
  private readonly filePath: string

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'subagents.json')
  }

  async initialize(): Promise<void> {
    await this.load()
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const list: SubAgentRegistryEntry[] = JSON.parse(raw)
      this.entries = new Map(list.map((e) => [e.id, e]))
    } catch {
      this.entries = new Map()
    }
  }

  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  private async save(): Promise<void> {
    await this.atomicWriteFile(
      this.filePath,
      JSON.stringify(Array.from(this.entries.values()), null, 2)
    )
  }

  list(): SubAgentRegistryEntry[] {
    return Array.from(this.entries.values())
  }

  listEnabled(): SubAgentRegistryEntry[] {
    return this.list().filter((e) => e.enabled)
  }

  get(id: string): SubAgentRegistryEntry | undefined {
    return this.entries.get(id)
  }

  getByName(name: string): SubAgentRegistryEntry | undefined {
    for (const e of this.entries.values()) {
      if (e.name === name) return e
    }
    return undefined
  }

  async create(params: CreateSubAgentParams): Promise<SubAgentRegistryEntry> {
    if (this.getByName(params.name)) {
      throw new Error(`SubAgent "${params.name}" 已存在`)
    }
    this.validateModelSpec(params)
    const now = generateTimestamp()
    const entry: SubAgentRegistryEntry = {
      ...params,
      id: generateId(),
      is_builtin: false,
      enabled: params.enabled ?? true,
      created_at: now,
      updated_at: now,
    }
    this.entries.set(entry.id, entry)
    await this.save()
    return entry
  }

  async update(id: string, params: UpdateSubAgentParams): Promise<SubAgentRegistryEntry> {
    // 注：内置项（is_builtin=true）允许 update 修改任意字段（包括 enabled / model 引用 / prompt 段）
    // 仅 delete 受 is_builtin 限制。语义来自 spec §1.1 "内置项可编辑可禁用不可删"
    const existing = this.entries.get(id)
    if (!existing) throw new Error(`SubAgent not found: ${id}`)

    if (params.name && params.name !== existing.name) {
      const dup = this.getByName(params.name)
      if (dup && dup.id !== id) throw new Error(`SubAgent "${params.name}" 已存在`)
    }

    const next: SubAgentRegistryEntry = {
      ...existing,
      ...params,
      id: existing.id,
      is_builtin: existing.is_builtin,
      created_at: existing.created_at,
      updated_at: generateTimestamp(),
    }
    this.validateModelSpec(next)
    this.entries.set(id, next)
    await this.save()
    return next
  }

  async delete(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`SubAgent not found: ${id}`)
    if (entry.is_builtin) throw new Error(`内置 SubAgent "${entry.name}" 不可删除`)
    this.entries.delete(id)
    await this.save()
  }

  /** 内置项 seed：仅当不存在同 id 时插入 */
  async seedBuiltin(entries: SubAgentRegistryEntry[]): Promise<void> {
    let changed = false
    for (const e of entries) {
      if (!this.entries.has(e.id)) {
        this.entries.set(e.id, e)
        changed = true
      }
    }
    if (changed) await this.save()
  }

  private validateModelSpec(entry: Pick<SubAgentRegistryEntry, 'provider_id' | 'model_id' | 'model_role'>): void {
    const hasSpecific = entry.provider_id !== null && entry.model_id !== null
    const hasRole = entry.model_role !== null
    if (!hasSpecific && !hasRole) {
      throw new Error('model spec 缺失：provider_id+model_id 或 model_role 至少需一组')
    }
  }
}
