/**
 * 把 crabot 各 manager 接成引擎要的 ImportDeps。
 *
 * 设计依据：2026-06-15-openclaw-migration-design.md §8
 * index.ts 侧用真实 manager 方法填 ImportManagers，本桥接负责拼 Set + 包装签名。
 */
import path from 'node:path'
import type { CreateModelProviderParams, CreateChannelInstanceParams } from '../types.js'
import type { ImportDeps } from './run-import.js'

export type ImportManagers = {
  listProviderNames: () => string[]
  createProvider: (p: CreateModelProviderParams) => Promise<unknown>
  listChannelNames: () => string[]
  createChannel: (p: CreateChannelInstanceParams) => Promise<unknown>
  listMcpNames: () => string[]
  importMcpJson: (json: string) => Promise<unknown>
  listSkillNames: () => string[]
  importSkillDir: (dir: string) => Promise<unknown>
  writeLongTerm: (p: { type: string; content: string }) => Promise<unknown>
  workspaceDir: string
}

export function buildImportDeps(m: ImportManagers): ImportDeps {
  return {
    existingProviderNames: new Set(m.listProviderNames()),
    createProvider: async (p) => {
      await m.createProvider(p)
    },
    existingChannelNames: new Set(m.listChannelNames()),
    createChannel: async (p) => {
      await m.createChannel(p)
    },
    existingMcpNames: new Set(m.listMcpNames()),
    importMcpJson: async (json) => {
      await m.importMcpJson(json)
    },
    existingSkillNames: new Set(m.listSkillNames()),
    importSkillDir: async (dir) => {
      await m.importSkillDir(dir)
    },
    writeLongTerm: async (p) => {
      await m.writeLongTerm(p)
    },
    workspaceDestDir: path.join(m.workspaceDir, 'openclaw-workspace'),
  }
}
