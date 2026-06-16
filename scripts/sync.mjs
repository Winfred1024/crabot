#!/usr/bin/env node

import './_preflight.mjs'

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import yaml from 'js-yaml'
import { detectMode } from './lib/mode.mjs'
import { readInstance, writeInstance, hasInstance } from './lib/instance.mjs'
import { mergeKindDoc } from './lib/yaml-merge.mjs'

const HOME_DIR = resolve(homedir(), '.crabot')
const ETC_DIR = '/etc/crabot'

if (detectMode(ETC_DIR) !== 'system') {
  console.error('[sync] not a system-mode install (no /etc/crabot/). Nothing to sync.')
  process.exit(1)
}

if (!hasInstance(HOME_DIR)) {
  console.error('[sync] no instance.json; run `crabot init` first.')
  process.exit(1)
}

const inst = readInstance(HOME_DIR)
const DATA_DIR = inst.data_dir

let newVersion = 0
try {
  newVersion = parseInt(readFileSync(join(ETC_DIR, 'cluster.version'), 'utf-8').trim(), 10) || 0
} catch { /* ok */ }

const oldVersion = inst.applied_cluster_version ?? 0
if (newVersion === oldVersion) {
  console.log(`[sync] already up to date (cluster.version=${newVersion})`)
  process.exit(0)
}

console.log(`[sync] applying cluster.version ${oldVersion} → ${newVersion}`)

function loadYaml(path) {
  if (!existsSync(path)) return null
  const raw = readFileSync(path, 'utf-8').trim()
  if (!raw) return null
  try { return yaml.load(raw) } catch { return null }
}

// 注：vendor 不走 sync——vendor 目录完全以 root 为准，admin 在 system mode 直读
// /etc/crabot/defaults/vendor.yaml（见 crabot-admin/src/vendor-registry.ts）。
const SLOT_KEY = { provider: 'name', agent: 'slot' }

for (const kind of ['provider', 'agent']) {
  const rootDoc = loadYaml(join(ETC_DIR, 'defaults', `${kind}.yaml`))
  if (!rootDoc) {
    console.log(`[sync]   - ${kind}.yaml: root 无默认，跳过`)
    continue
  }
  const userPath = resolve(DATA_DIR, 'admin', `${kind}.yaml`)
  const userDoc = loadYaml(userPath) ?? {}

  // doc 形如 { providers: [...] } 或 { model_slots: [...] }；
  // 容器 key 名沿用 root 的 top-level（约定俗成）
  const topKey =
    Object.keys(rootDoc).find(k => Array.isArray(rootDoc[k])) ?? Object.keys(rootDoc)[0]
  const rootList = rootDoc[topKey] ?? []
  const userList = (userDoc && userDoc[topKey]) ?? []
  const out = mergeKindDoc(rootDoc, userDoc, { key: SLOT_KEY[kind] })

  mkdirSync(dirname(userPath), { recursive: true })
  writeFileSync(userPath, yaml.dump(out))

  const rootKeys = new Set(rootList.map(e => e[SLOT_KEY[kind]]))
  const userKeys = new Set(userList.map(e => e[SLOT_KEY[kind]]))
  const overrode = [...rootKeys].filter(k => userKeys.has(k))
  const added = [...rootKeys].filter(k => !userKeys.has(k))
  const kept = [...userKeys].filter(k => !rootKeys.has(k))
  console.log(`[sync]   - ${kind}.yaml: 覆盖 [${overrode.join(', ')}], 新增 [${added.join(', ')}], 保留 [${kept.join(', ')}]`)
}

writeInstance(HOME_DIR, { ...inst, applied_cluster_version: newVersion, applied_at: new Date().toISOString() })
console.log(`[sync] applied_cluster_version → ${newVersion}`)
