import { api } from './api'
import type { SubAgentRegistryEntry } from '../types'

export const subagentService = {
  async list(): Promise<SubAgentRegistryEntry[]> {
    return api.get<SubAgentRegistryEntry[]>('/subagents')
  },

  async get(id: string): Promise<SubAgentRegistryEntry> {
    return api.get<SubAgentRegistryEntry>(`/subagents/${id}`)
  },

  async create(data: Omit<SubAgentRegistryEntry, 'id' | 'is_builtin' | 'created_at' | 'updated_at'>): Promise<SubAgentRegistryEntry> {
    return api.post<SubAgentRegistryEntry>('/subagents', data)
  },

  async update(id: string, data: Partial<SubAgentRegistryEntry>): Promise<SubAgentRegistryEntry> {
    return api.patch<SubAgentRegistryEntry>(`/subagents/${id}`, data)
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/subagents/${id}`)
  },
}
