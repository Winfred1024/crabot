#!/usr/bin/env node

// Crabot Start — 生产模式启动
// 加载环境变量 → 创建数据目录 → 密码检查 → 启动 Module Manager（前台）

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import net from 'node:net'
import { resolveDataDir } from './lib/data-dir.mjs'
import { writePid, clearPid, checkSingleInstance, isPidAlive } from './lib/pid.mjs'
import { scanModules, applyMigration } from './upgrade-lib/migrate.mjs'
import { runScript } from './upgrade-lib/runner.mjs'
import { hasInstance, readInstance } from './lib/instance.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// auto-init：缺 instance.json → 同步调 crabot init（在 const OFFSET 读取前）
{
  const homeCrabot = resolve(homedir(), '.crabot')
  if (!hasInstance(homeCrabot)) {
    console.log('[crabot] first run, auto-running init...')
    const initEntry = resolve(__dirname, 'init.mjs')
    const r = spawnSync(process.execPath, [initEntry], { stdio: 'inherit', env: { ...process.env } })
    if (r.status !== 0) {
      console.error('[crabot] init failed; aborting start')
      process.exit(1)
    }
    // init 跑完，从 instance.json 读 port_offset / data_dir，覆盖 process.env
    const inst = readInstance(homeCrabot)
    if (inst.port_offset && !process.env.CRABOT_PORT_OFFSET) {
      process.env.CRABOT_PORT_OFFSET = String(inst.port_offset)
    }
    if (!process.env.DATA_DIR) {
      process.env.DATA_DIR = inst.data_dir
    }
  }
}

const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const DAEMON_MODE = process.argv.includes('-d') || process.argv.includes('--daemon')

// ── 环境变量 ──

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return
  const lines = readFileSync(filePath, 'utf-8').split('\n')
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line || !line.includes('=')) continue
    const idx = line.indexOf('=')
    const key = line.slice(0, idx)
    const val = line.slice(idx + 1)
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

const DATA_DIR = resolveDataDir({ envValue: process.env.DATA_DIR, offset: OFFSET, repoRoot: ROOT })
process.env.DATA_DIR = DATA_DIR

// 一次性提示：走了 legacy source install 兼容分支
// 条件：未设 DATA_DIR + offset=0 + 落到了 $REPO/data 而不是 ~/.crabot/data
if (!process.env.DATA_DIR_NOTICE_SHOWN && !process.env.DATA_DIR && OFFSET === 0) {
  const repoData = resolve(ROOT, 'data')
  if (DATA_DIR === repoData) {
    console.warn(`[crabot] using legacy source install data at ${repoData}`)
    console.warn(`[crabot]   (set DATA_DIR=~/.crabot/data to switch to user-mode default)`)
    process.env.DATA_DIR_NOTICE_SHOWN = '1'
  }
}

loadEnvFile(resolve(DATA_DIR, 'admin/.env'))
loadEnvFile(resolve(ROOT, '.env'))

if (!process.env.CRABOT_JWT_SECRET) {
  process.env.CRABOT_JWT_SECRET = randomBytes(32).toString('hex')
}

// PATH 兜底：onboard/install 有些场景未持久化 ~/.local/bin 到 shell profile，
// 导致 Node spawn 子进程时找不到 uv。若该目录存在且未在 PATH 中，prepend 进去。
const LOCAL_BIN = resolve(homedir(), '.local/bin')
if (existsSync(LOCAL_BIN)) {
  const currentPath = (process.env.PATH || '').split(':').filter(Boolean)
  if (!currentPath.includes(LOCAL_BIN)) {
    process.env.PATH = [LOCAL_BIN, ...currentPath].join(':')
  }
}

// NO_PROXY 兜底：用户开了系统代理（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY）时，
// Python httpx 默认 trust_env=True 会把 localhost RPC 也走代理 → 502 Bad Gateway，
// memory 等 Python 模块 register 失败、卡在 starting。Node http 不读代理变量不受影响，
// 但显式声明 loopback 不走代理对 TS 也无害。
{
  const required = ['localhost', '127.0.0.1', '::1']
  const merge = (existing) => {
    const set = new Set(
      (existing || '').split(',').map((s) => s.trim()).filter(Boolean)
    )
    for (const h of required) set.add(h)
    return Array.from(set).join(',')
  }
  const merged = merge(process.env.NO_PROXY || process.env.no_proxy)
  process.env.NO_PROXY = merged
  process.env.no_proxy = merged
}

// ── 数据目录 ──

for (const sub of ['admin', 'agent', 'memory']) {
  mkdirSync(resolve(DATA_DIR, sub), { recursive: true })
}

// ── 密码检查 ──

const adminEnvPath = resolve(DATA_DIR, 'admin/.env')

if (DAEMON_MODE && !process.env.CRABOT_ADMIN_PASSWORD) {
  // 后台模式下不能交互；检查 admin/.env 是否已有密码
  const envExists = existsSync(adminEnvPath)
  const envHasPassword = envExists && /^CRABOT_ADMIN_PASSWORD=/m.test(
    readFileSync(adminEnvPath, 'utf-8'),
  )
  if (!envHasPassword) {
    console.error('[crabot] No admin password set. Run `crabot start` (foreground) once to set it interactively.')
    process.exit(1)
  }
}

if (!process.env.CRABOT_ADMIN_PASSWORD) {
  const prompter = createPrompter()
  const password = await prompter.ask('Set admin password: ')
  if (!password || password.length < 4) {
    console.error('[crabot] Password must be at least 4 characters.')
    process.exit(1)
  }
  const confirm = await prompter.ask('Confirm password: ')
  prompter.close()
  if (password !== confirm) {
    console.error('[crabot] Passwords do not match.')
    process.exit(1)
  }
  const line = `CRABOT_ADMIN_PASSWORD=${password}\n`
  writeFileSync(adminEnvPath, existsSync(adminEnvPath) ? readFileSync(adminEnvPath, 'utf-8') + line : line)
  process.env.CRABOT_ADMIN_PASSWORD = password
  console.log('[crabot] Password saved.')
}

// ── 启动 Module Manager ──

const mmEntry = resolve(ROOT, 'crabot-core/dist/main.js')
if (!existsSync(mmEntry)) {
  console.error('[crabot] crabot-core/dist/main.js not found. Run build first.')
  process.exit(1)
}

// system mode 下检测 cluster.version 是否过期
{
  const homeCrabot = resolve(homedir(), '.crabot')
  if (hasInstance(homeCrabot)) {
    const inst = readInstance(homeCrabot)
    if (inst.mode === 'system') {
      let current = 0
      try { current = parseInt(readFileSync('/etc/crabot/cluster.version', 'utf-8').trim(), 10) || 0 } catch {}
      const applied = inst.applied_cluster_version ?? 0
      if (current > applied) {
        if (DAEMON_MODE) {
          console.error(`[crabot] cluster config has updates (v${applied}→v${current}). Run \`crabot sync\` first, or use foreground start.`)
          process.exit(1)
        }
        console.log(`[crabot] root 默认配置已更新（版本 ${applied} → ${current}）。是否拉取最新默认？[y/N]`)
        const answer = (await readStdinLine()).trim().toLowerCase()
        if (answer === 'y' || answer === 'yes') {
          const syncEntry = resolve(__dirname, 'sync.mjs')
          const r = spawnSync(process.execPath, [syncEntry], { stdio: 'inherit', env: { ...process.env } })
          if (r.status !== 0) {
            console.error('[crabot] sync failed; aborting start')
            process.exit(1)
          }
        } else {
          console.log('[crabot] sync skipped; aborting start (run again to retry)')
          process.exit(1)
        }
      }
    }
  }
}

// 单实例预检
const single = checkSingleInstance(DATA_DIR)
if (!single.ok) {
  console.error(`[crabot] already running (pid=${single.runningPid}). Run 'crabot stop' first.`)
  process.exit(1)
}

// 端口预检（避免拿到 EADDRINUSE 才报错）
async function probePort(port) {
  return await new Promise((res) => {
    const srv = net.createServer()
    srv.once('error', () => res(false))
    srv.once('listening', () => srv.close(() => res(true)))
    srv.listen(port, '127.0.0.1')
  })
}
if (!await probePort(19000 + OFFSET)) {
  console.error(`[crabot] port ${19000 + OFFSET} already in use. Check 'lsof -i :${19000 + OFFSET}'.`)
  process.exit(1)
}

const MM_PORT = 19000 + OFFSET
const WEB_PORT = 3000 + OFFSET

console.log(`[crabot] Starting Module Manager (port ${MM_PORT})...`)
console.log(`[crabot] Admin Web: http://localhost:${WEB_PORT}`)

// Migration 兜底：start 自动跑缺失的 migration（覆盖 upgrade-time 漏跑场景）
// 用 applyMigration 包装版（chainUpgrade + writeSchemaVersion 原子，不可能漏写
// SCHEMA_VERSION）；不做 backup（启动不备份，upgrade.mjs 主路径才备）。
const pending = scanModules(ROOT, DATA_DIR)
if (pending.length > 0) {
  console.log(`[crabot] applying ${pending.length} pending migration(s)...`)
  for (const m of pending) {
    console.log(`[crabot]   ${m.moduleId}: ${m.dataVersion ?? 'fresh'} → ${m.codeVersion}`)
    const result = await applyMigration(
      resolve(ROOT, m.moduleId),
      m.dataDir,
      m.dataVersion,
      m.codeVersion,
      runScript,
    )
    if (!result.ok) {
      console.error(`[crabot] migration failed for ${m.moduleId} at ${result.failedAt}`)
      process.exit(1)
    }
  }
  console.log('[crabot] migrations done')
}

if (!DAEMON_MODE) {
  // 前台模式：写本进程 PID（stop 时 SIGTERM 给我，我转发给 MM）
  writePid(DATA_DIR, process.pid)

  const child = spawn(process.execPath, [mmEntry], {
    cwd: resolve(ROOT, 'crabot-core'),
    stdio: 'inherit',
    env: { ...process.env },
  })

  const cleanup = () => clearPid(DATA_DIR)
  child.on('exit', (code) => {
    cleanup()
    process.exit(code ?? 1)
  })
  child.on('error', (err) => {
    cleanup()
    console.error(`[crabot] failed to spawn Module Manager: ${err.message}`)
    process.exit(1)
  })
  process.on('exit', cleanup)

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig))
  }
} else {
  // 后台模式：spawn detached supervisor，父进程轮询 health 后退出
  const supervisorEntry = resolve(__dirname, 'supervisor.mjs')
  const sup = spawn(process.execPath, [supervisorEntry], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CRABOT_SUPERVISOR_DATA_DIR: DATA_DIR,
      CRABOT_SUPERVISOR_MM_ENTRY: mmEntry,
      CRABOT_SUPERVISOR_MM_CWD: resolve(ROOT, 'crabot-core'),
    },
  })
  // 父进程立即写 supervisor.pid 到 mm.pid（避免 race）
  writePid(DATA_DIR, sup.pid)
  sup.unref()

  console.log('[crabot] Starting in background...')
  console.log('[crabot] Waiting for Module Manager to become healthy... (up to 30s)')

  // 健康轮询（最多 30s）
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!isPidAlive(sup.pid)) {
      console.error('[crabot] supervisor exited unexpectedly. Check logs at', resolve(DATA_DIR, 'logs/mm.stderr.log'))
      process.exit(1)
    }
    try {
      const r = await fetch(`http://localhost:${MM_PORT}/health`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) {
        const r2 = await fetch(`http://localhost:${WEB_PORT}/health`, { signal: AbortSignal.timeout(1500) })
        if (r2.ok) {
          console.log(`[crabot] \x1b[32m●\x1b[0m MM ready (port ${MM_PORT})`)
          console.log(`[crabot] \x1b[32m●\x1b[0m Admin Web ready (port ${WEB_PORT})`)
          console.log(`[crabot] Started. PID ${sup.pid}. Run \`crabot status\` to check, \`crabot stop\` to stop.`)
          process.exit(0)
        }
      }
    } catch { /* keep trying */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  console.error(`[crabot] timeout after 30s. Check logs at ${resolve(DATA_DIR, 'logs/mm.stderr.log')}`)
  console.error(`[crabot] supervisor still running at pid ${sup.pid}; if it eventually starts, fine; otherwise crabot stop.`)
  process.exit(1)
}

// ── 辅助函数 ──

async function readStdinLine() {
  return new Promise((res) => {
    let buf = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.once('data', (chunk) => { buf += chunk; res(buf) })
    process.stdin.resume()
  })
}

function createPrompter() {
  if (process.stdin.isTTY) {
    return {
      ask(prompt) {
        return new Promise((res) => {
          process.stdout.write(prompt)
          process.stdin.setRawMode(true)
          process.stdin.resume()
          let input = ''
          const onData = (ch) => {
            const c = ch.toString()
            if (c === '\n' || c === '\r') {
              process.stdin.setRawMode(false)
              process.stdin.removeListener('data', onData)
              process.stdin.pause()
              process.stdout.write('\n')
              res(input)
            } else if (c === '\x7f' || c === '\b') {
              if (input.length > 0) input = input.slice(0, -1)
            } else if (c === '\x03') {
              process.exit(1)
            } else {
              input += c
            }
          }
          process.stdin.on('data', onData)
        })
      },
      close() {},
    }
  }
  const rl = createInterface({ input: process.stdin })
  const lines = []
  let waiting = null
  let closed = false
  rl.on('line', (line) => {
    if (waiting) { const cb = waiting; waiting = null; cb(line) }
    else lines.push(line)
  })
  rl.on('close', () => {
    closed = true
    if (waiting) { const cb = waiting; waiting = null; cb('') }
  })
  return {
    ask(prompt) {
      process.stdout.write(prompt)
      if (lines.length > 0) return Promise.resolve(lines.shift())
      if (closed) return Promise.resolve('')
      return new Promise((res) => { waiting = res })
    },
    close() { rl.close() },
  }
}
