import { describe, it, expect } from 'vitest'
import { CATEGORY_PATHS, DEFAULT_CATEGORIES, isBackupCategory } from './categories.js'
import { BACKUP_CATEGORIES } from './types.js'

describe('categories', () => {
  it('每个类别都有路径清单', () => {
    for (const cat of BACKUP_CATEGORIES) {
      expect(CATEGORY_PATHS[cat]).toBeDefined()
      expect(Array.isArray(CATEGORY_PATHS[cat])).toBe(true)
    }
  })

  it('默认类别不含调试/聊天（spec §5）', () => {
    expect(DEFAULT_CATEGORIES).toEqual(['config', 'channels', 'skills', 'memory', 'tasks'])
  })

  it('config 类别含 global_model_config 与 mcp-servers，不含 channel/friends', () => {
    const rels = CATEGORY_PATHS.config.map((p) => p.rel)
    expect(rels).toContain('global_model_config.json')
    expect(rels).toContain('mcp-servers.json')
    expect(rels).not.toContain('friends.json')
    expect(rels).not.toContain('channel-instances.json')
  })

  it('channels 类别把 friends/权限 并入', () => {
    const rels = CATEGORY_PATHS.channels.map((p) => p.rel)
    expect(rels).toContain('channel-instances.json')
    expect(rels).toContain('friends.json')
    expect(rels).toContain('friend-permission-configs.json')
  })

  it('isBackupCategory 校验', () => {
    expect(isBackupCategory('config')).toBe(true)
    expect(isBackupCategory('chat')).toBe(false)
  })
})
