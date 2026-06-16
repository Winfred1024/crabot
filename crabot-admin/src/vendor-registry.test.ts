import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validatePresetVendor,
  resolvePresetVendors,
  loadVendorOverride,
} from './vendor-registry.js'
import type { PresetVendor } from './types.js'

const BUILTIN: PresetVendor[] = [
  { id: 'openai', name: 'OpenAI', format: 'openai', endpoint: 'https://api.openai.com/v1' },
  { id: 'ollama', name: 'Ollama', format: 'openai', endpoint: 'http://localhost:11434/v1' },
]

describe('validatePresetVendor', () => {
  it('合法条目原样返回（含可选字段）', () => {
    const out = validatePresetVendor({
      id: 'x', name: 'X', format: 'anthropic', endpoint: 'https://x',
      models_api: '/models', recommended: true, auth_type: 'apikey',
      vision_id_prefixes: ['claude-'],
      default_models: [{ model_id: 'm', display_name: 'M', type: 'llm', supports_vision: true, max_tokens: 8192, description: 'desc', tags: ['a', 'b'] }],
    })
    expect(out).not.toBeNull()
    expect(out!.id).toBe('x')
    expect(out!.auth_type).toBe('apikey')
    expect(out!.default_models).toHaveLength(1)
    expect(out!.default_models![0].max_tokens).toBe(8192)
    expect(out!.default_models![0].description).toBe('desc')
    expect(out!.default_models![0].tags).toEqual(['a', 'b'])
  })

  it('缺 id / 缺 endpoint / 非法 format → null', () => {
    expect(validatePresetVendor({ name: 'X', format: 'openai', endpoint: 'y' })).toBeNull()
    expect(validatePresetVendor({ id: 'x', name: 'X', format: 'openai' })).toBeNull()
    expect(validatePresetVendor({ id: 'x', name: 'X', format: 'bogus', endpoint: 'y' })).toBeNull()
  })

  it('default_models 中坏项被跳过，好项保留', () => {
    const out = validatePresetVendor({
      id: 'x', name: 'X', format: 'openai', endpoint: 'y',
      default_models: [
        { model_id: 'good', display_name: 'G', type: 'llm' },
        { model_id: '', display_name: 'bad', type: 'llm' },
        { model_id: 'wrongtype', display_name: 'W', type: 'embedding' },
      ],
    })
    expect(out!.default_models).toEqual([{ model_id: 'good', display_name: 'G', type: 'llm' }])
  })

  it('format=openai-responses + apikey 被接受（Responses API 可配）', () => {
    const out = validatePresetVendor({
      id: 'my-responses', name: '我的 Responses', format: 'openai-responses', endpoint: 'https://api.openai.com/v1',
    })
    expect(out).not.toBeNull()
    expect(out!.format).toBe('openai-responses')
  })

  it('auth_type=oauth 被拒绝（固定设备码流程不可自定义）', () => {
    expect(validatePresetVendor({
      id: 'fake-chatgpt', name: '伪订阅', format: 'openai-responses', endpoint: 'https://evil/codex', auth_type: 'oauth',
    })).toBeNull()
  })
})

describe('resolvePresetVendors', () => {
  it('override=null → 返回内置副本', () => {
    expect(resolvePresetVendors(BUILTIN, null)).toEqual(BUILTIN)
  })

  it('merge：同 id 覆盖原位次、新 id 追加尾部、未覆盖保留', () => {
    const out = resolvePresetVendors(BUILTIN, {
      mode: 'merge',
      vendors: [
        { id: 'openai', name: 'OpenAI 改名', format: 'openai', endpoint: 'https://api.openai.com/v1' },
        { id: 'corp', name: '公司代理', format: 'openai', endpoint: 'https://corp/v1' },
      ],
    })
    expect(out.map(v => v.id)).toEqual(['openai', 'ollama', 'corp'])
    expect(out[0].name).toBe('OpenAI 改名')
  })

  it('replace：完全接管，内置全隐藏', () => {
    const out = resolvePresetVendors(BUILTIN, {
      mode: 'replace',
      vendors: [{ id: 'corp', name: '公司代理', format: 'openai', endpoint: 'https://corp/v1' }],
    })
    expect(out.map(v => v.id)).toEqual(['corp'])
  })

  // 受保护：openai-responses（ChatGPT 订阅）固定流程，任何模式都不能被 override 干掉
  const BUILTIN_PROTECTED: PresetVendor[] = [
    { id: 'chatgpt-subscription', name: 'ChatGPT 订阅', format: 'openai-responses', endpoint: 'https://chatgpt.com/backend-api/codex', auth_type: 'oauth' },
    { id: 'openai', name: 'OpenAI', format: 'openai', endpoint: 'https://api.openai.com/v1' },
  ]

  it('replace：受保护的 openai-responses 内置始终保留', () => {
    const out = resolvePresetVendors(BUILTIN_PROTECTED, {
      mode: 'replace',
      vendors: [{ id: 'corp', name: '公司代理', format: 'openai', endpoint: 'https://corp/v1' }],
    })
    expect(out.map(v => v.id)).toEqual(['chatgpt-subscription', 'corp'])
  })

  it('merge：受保护的 id 不可被同 id override 覆盖', () => {
    const out = resolvePresetVendors(BUILTIN_PROTECTED, {
      mode: 'merge',
      vendors: [{ id: 'chatgpt-subscription', name: '冒名', format: 'openai', endpoint: 'https://evil/v1' }],
    })
    const cg = out.find(v => v.id === 'chatgpt-subscription')!
    expect(cg.name).toBe('ChatGPT 订阅')        // 仍是内置定义
    expect(cg.format).toBe('openai-responses')  // 未被改成 openai
  })
})

describe('loadVendorOverride', () => {
  async function withTmpDir(fn: (dir: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vendor-reg-'))
    try { await fn(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
  }

  it('文件不存在 → null', async () => {
    await withTmpDir(async (dir) => {
      expect(await loadVendorOverride(dir)).toBeNull()
    })
  })

  it('空文件 → null', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'vendor.yaml'), '   \n')
      expect(await loadVendorOverride(dir)).toBeNull()
    })
  })

  it('坏 YAML → null', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'vendor.yaml'), 'mode: [unclosed')
      expect(await loadVendorOverride(dir)).toBeNull()
    })
  })

  it('1 坏条目 + 1 好条目 → 跳过坏的；mode 缺省=merge', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'vendor.yaml'), [
        'vendors:',
        '  - id: good',
        '    name: Good',
        '    format: openai',
        '    endpoint: https://good',
        '  - id: bad',
        '    name: Bad',
        '    format: not-a-format',
        '    endpoint: https://bad',
      ].join('\n'))
      const ov = await loadVendorOverride(dir)
      expect(ov!.mode).toBe('merge')
      expect(ov!.vendors.map(v => v.id)).toEqual(['good'])
    })
  })

  it('mode: replace 被读出', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'vendor.yaml'), 'mode: replace\nvendors: []\n')
      expect((await loadVendorOverride(dir))!.mode).toBe('replace')
    })
  })
})

describe('initVendorRegistry + getPresetVendors + findPresetVendor', () => {
  async function withTmpDir(fn: (dir: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vendor-init-'))
    try { await fn(dir) } finally { await fs.rm(dir, { recursive: true, force: true }) }
  }

  it('replace 模式隐藏普通内置，但受保护的 chatgpt-subscription 保留', async () => {
    await withTmpDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'vendor.yaml'), [
        'mode: replace',
        'vendors:',
        '  - id: corp',
        '    name: 公司代理',
        '    format: openai',
        '    endpoint: https://corp/v1',
      ].join('\n'))
      const { initVendorRegistry, getPresetVendors, findPresetVendor } = await import('./vendor-registry.js')
      await initVendorRegistry(dir)
      expect(findPresetVendor('corp')).toBeDefined()
      expect(findPresetVendor('openai')).toBeUndefined()        // 普通内置被 replace 隐藏
      expect(findPresetVendor('chatgpt-subscription')).toBeDefined() // 受保护，始终保留
      // 结果 = 受保护内置 + override 自定义
      expect(getPresetVendors().map(v => v.id).sort()).toEqual(['chatgpt-subscription', 'corp'])
    })
  })

  it('空目录 → 回退纯内置（含 openai）', async () => {
    await withTmpDir(async (dir) => {
      const { initVendorRegistry, findPresetVendor } = await import('./vendor-registry.js')
      await initVendorRegistry(dir)
      expect(findPresetVendor('openai')).toBeDefined()
    })
  })
})
