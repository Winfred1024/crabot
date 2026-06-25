#!/usr/bin/env node

import './_preflight.mjs'

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { detectMode } from './upgrade-lib/mode.mjs'
import { resolveCliDataDir } from './lib/instance.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CRABOT_HOME = resolve(__dirname, '..')
const CLI = join(CRABOT_HOME, 'cli.mjs')
const DATA_DIR = resolveCliDataDir({ homeDir: resolve(homedir(), '.crabot'), repoRoot: CRABOT_HOME })
const STATUS_DIR = join(DATA_DIR, 'admin')
const STATUS_FILE = join(STATUS_DIR, 'upgrade-status.json')

function readVersion() {
  const p = join(CRABOT_HOME, 'VERSION')
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() : null
}

function writeStatus(patch) {
  mkdirSync(STATUS_DIR, { recursive: true })
  let prev = {}
  if (existsSync(STATUS_FILE)) {
    try { prev = JSON.parse(readFileSync(STATUS_FILE, 'utf-8')) } catch {}
  }
  writeFileSync(STATUS_FILE, JSON.stringify({ ...prev, ...patch }, null, 2))
}

function node(args) {
  execFileSync(process.execPath, [CLI, ...args], { cwd: CRABOT_HOME, stdio: 'inherit' })
}

async function main() {
  const mode = detectMode(CRABOT_HOME) // 'release' | 'source'
  const fromVersion = readVersion()
  writeStatus({
    phase: 'upgrading',
    started_at: new Date().toISOString(),
    from_version: fromVersion,
    finished_at: undefined,
    error: undefined,
    to_version: undefined,
  })

  try {
    // 1) 停 MM（必须先停，否则 upgrade 会因 MM 运行而拒绝）
    node(['stop'])

    // 2) source 模式自己 git pull（runSourceUpgrade 不含 pull）
    if (mode === 'source') {
      execFileSync('git', ['pull', '--ff-only'], { cwd: CRABOT_HOME, stdio: 'inherit' })
    }

    // 3) 升级（非交互）：release=下载解压+迁移，source=install+build+迁移
    node(['upgrade', '-y'])

    // 4) 重启（后台 supervisor，立即返回）
    writeStatus({ phase: 'restarting' })
    node(['start', '-d'])

    writeStatus({
      phase: 'done',
      to_version: readVersion(),
      finished_at: new Date().toISOString(),
    })
  } catch (err) {
    writeStatus({
      phase: 'failed',
      error: err?.message || String(err),
      finished_at: new Date().toISOString(),
    })
    process.exit(1)
  }
}

main().catch((err) => {
  writeStatus({ phase: 'failed', error: err?.message || String(err), finished_at: new Date().toISOString() })
  process.exit(1)
})
