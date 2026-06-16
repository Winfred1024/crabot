#!/usr/bin/env node

import './_preflight.mjs'

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, hostname, userInfo } from 'node:os'
import yaml from 'js-yaml'
import { resolveDataDir } from './lib/data-dir.mjs'
import { detectMode } from './lib/mode.mjs'
import { hasInstance, readInstance, writeInstance } from './lib/instance.mjs'
import { allocateOffset } from './lib/registry.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CRABOT_HOME = resolve(__dirname, '..')
const HOME_DIR = resolve(homedir(), '.crabot')
const ETC_DIR = '/etc/crabot'

const user = userInfo().username
const host = hostname()

mkdirSync(HOME_DIR, { recursive: true })

const mode = detectMode(ETC_DIR)

if (hasInstance(HOME_DIR)) {
  console.log('[init] instance.json already exists, nothing to do.')
  const inst = readInstance(HOME_DIR)
  console.log(`[init] mode=${inst.mode}, offset=${inst.port_offset}, data_dir=${inst.data_dir}`)
  process.exit(0)
}

if (mode === 'user') {
  // user mode 简单写一份 instance.json
  //
  // data_dir 解析：默认 ~/.crabot/data，但对 install-from-source 历史用户做
  // 向后兼容——$REPO/data/admin 存在就用 $REPO/data。理由见
  // scripts/lib/data-dir.mjs 的 resolveDataDir 注释（system mode 多用户部署 merge
  // 之前的历史路径）。这里跟 resolveDataDir 用同样的检测，保持单点真相。
  const userModeDataDir = resolveDataDir({ envValue: undefined, offset: 0, repoRoot: CRABOT_HOME })
  if (userModeDataDir === resolve(CRABOT_HOME, 'data')) {
    console.log(`[init] 检测到 legacy source install 历史数据 ${userModeDataDir}，使用它`)
  }
  const manifest = {
    mode: 'user',
    port_offset: 0,
    applied_cluster_version: null,
    applied_at: new Date().toISOString(),
    data_dir: userModeDataDir,
    crabot_home: CRABOT_HOME,
  }
  writeInstance(HOME_DIR, manifest)
  console.log('[init] mode=user, instance.json written')
  process.exit(0)
}

// system mode
console.log('[init] 检测到 system mode 安装（' + CRABOT_HOME + '）')

const REG_PATH = join(ETC_DIR, 'registry/ports.json')
if (!existsSync(REG_PATH)) {
  console.error('[init] /etc/crabot/registry/ports.json 不存在；请联系管理员检查安装')
  process.exit(1)
}

let allocation
try {
  allocation = await allocateOffset(REG_PATH, { user, hostname: host, pidAtInit: process.pid })
} catch (err) {
  if (err.code === 'EACCES') {
    console.error('[init] 写 /etc/crabot/registry/ports.json 权限拒绝。')
    console.error('[init] 需要把你加入 crabot group：sudo usermod -a -G crabot ' + user)
    console.error('[init] 加完之后重新登录 shell 再试。')
    process.exit(1)
  }
  throw err
}

const OFF = allocation.offset
console.log(`[init] 申请端口偏移... ${allocation.reused ? '复用' : '已分配'} OFFSET=${OFF}`)

// 拉取 defaults
const DATA_DIR = resolveDataDir({ offset: OFF })
mkdirSync(resolve(DATA_DIR, 'admin'), { recursive: true })

let clusterVersion = 0
try {
  clusterVersion = parseInt(readFileSync(join(ETC_DIR, 'cluster.version'), 'utf-8').trim(), 10) || 0
} catch { /* ok */ }

console.log('[init] 拉取 root 默认配置...')
for (const kind of ['provider', 'agent', 'vendor']) {
  const src = join(ETC_DIR, 'defaults', `${kind}.yaml`)
  if (!existsSync(src)) continue
  const raw = readFileSync(src, 'utf-8').trim()
  if (!raw) continue
  let parsed
  try { parsed = yaml.load(raw) } catch (e) {
    console.error(`[init] ${src} 解析失败，跳过：${e.message}`)
    continue
  }
  if (!parsed) continue
  // 落盘到 user 本地（具体路径与现有 admin 配置存储对齐——此处用 DATA_DIR/admin/<kind>.yaml）
  const dst = resolve(DATA_DIR, 'admin', `${kind}.yaml`)
  writeFileSync(dst, raw)
  console.log(`[init]   - ${kind}.yaml: 已同步`)
}

// 写 shell rc
const shell = process.env.SHELL || ''
const rcFile = shell.includes('zsh') ? '.zshrc'
  : shell.includes('bash') ? '.bashrc'
  : '.profile'
const rcPath = resolve(homedir(), rcFile)

const exportLines = [
  `export CRABOT_PORT_OFFSET=${OFF}`,
  `export DATA_DIR=$HOME/.crabot/data-${OFF}`,
]
const existingRc = existsSync(rcPath) ? readFileSync(rcPath, 'utf-8') : ''
const toAppend = exportLines.filter(line => !existingRc.includes(line))
if (toAppend.length > 0) {
  appendFileSync(rcPath, '\n# Added by crabot init\n' + toAppend.join('\n') + '\n')
  console.log(`[init] 写入 shell 配置：${rcPath}`)
  for (const l of toAppend) console.log(`[init]   + ${l}`)
} else {
  console.log(`[init] shell 配置已存在所需 export，跳过`)
}

// 写 instance.json
writeInstance(HOME_DIR, {
  mode: 'system',
  port_offset: OFF,
  applied_cluster_version: clusterVersion,
  applied_at: new Date().toISOString(),
  data_dir: DATA_DIR,
  crabot_home: CRABOT_HOME,
})
console.log(`[init] 生成 ${join(HOME_DIR, 'instance.json')}`)
console.log(`[init] 完成。请重新登录 shell 或执行 \`source ${rcFile}\` 让环境变量生效。`)
