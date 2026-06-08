#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { resolveDataDir } from './lib/data-dir.mjs'
import { hasInstance, readInstance } from './lib/instance.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const DATA_DIR = resolveDataDir({ envValue: process.env.DATA_DIR, offset: OFFSET })
const HOME_DIR = resolve(homedir(), '.crabot')
const ARGS = process.argv.slice(2)
const JSON_OUT = ARGS.includes('--json')

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
}

async function probeHealth(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}

async function fetchModules(rpcPort) {
  try {
    const r = await fetch(`http://localhost:${rpcPort}/modules`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return null
    const data = await r.json()
    return Array.isArray(data) ? data : data.modules || null
  } catch { return null }
}

const inst = hasInstance(HOME_DIR) ? readInstance(HOME_DIR) : {
  mode: 'unknown', port_offset: OFFSET, data_dir: DATA_DIR, crabot_home: ROOT,
}

const ENDPOINTS = {
  admin_ui:  { url: `http://localhost:${3000 + OFFSET}`,  label: 'Admin UI' },
  mm:        { url: `http://localhost:${19000 + OFFSET}`, label: 'Module Manager' },
  admin_rpc: { url: `http://localhost:${19001 + OFFSET}`, label: 'Admin RPC' },
}

const health = {}
for (const [k, v] of Object.entries(ENDPOINTS)) {
  health[k] = await probeHealth(v.url + '/health')
}
const running = health.mm && health.admin_ui

const modules = running ? await fetchModules(19001 + OFFSET) : null

let clusterCurrent = null
let clusterApplied = inst.applied_cluster_version ?? null
if (inst.mode === 'system') {
  try {
    const fs = await import('node:fs')
    const raw = fs.readFileSync('/etc/crabot/cluster.version', 'utf-8').trim()
    clusterCurrent = parseInt(raw, 10)
  } catch { /* ignore */ }
}

const logsStdout = resolve(DATA_DIR, 'logs/mm.stdout.log')
const logsStderr = resolve(DATA_DIR, 'logs/mm.stderr.log')
const hasLogs = existsSync(logsStdout) || existsSync(logsStderr)

if (JSON_OUT) {
  console.log(JSON.stringify({
    mode: inst.mode,
    port_offset: inst.port_offset ?? OFFSET,
    data_dir: DATA_DIR,
    crabot_home: inst.crabot_home ?? ROOT,
    instance_init: inst.applied_at ?? null,
    running,
    endpoints: Object.fromEntries(
      Object.entries(ENDPOINTS).map(([k, v]) => [k, { url: v.url, healthy: health[k] }])
    ),
    modules,
    cluster: inst.mode === 'system' ? {
      current_version: clusterCurrent,
      applied_version: clusterApplied,
      updates_pending: clusterCurrent !== null && clusterApplied !== null && clusterCurrent > clusterApplied,
    } : null,
    logs: hasLogs ? { stdout: logsStdout, stderr: logsStderr } : null,
  }, null, 2))
  process.exit(0)
}

// 人类视图
const dot = (ok) => ok ? c.green('●') : c.red('●')
console.log()
console.log('  ' + c.bold('Crabot Instance'))
console.log('  ' + '─'.repeat(54))
console.log(`  Mode              ${inst.mode}`)
console.log(`  Port Offset       ${inst.port_offset ?? OFFSET}`)
console.log(`  DATA_DIR          ${DATA_DIR}`)
console.log(`  CRABOT_HOME       ${inst.crabot_home ?? ROOT}`)
if (inst.applied_at) console.log(`  Instance Init     ${inst.applied_at}`)
console.log()
console.log('  ' + c.bold('Endpoints'))
console.log('  ' + '─'.repeat(54))
for (const [k, v] of Object.entries(ENDPOINTS)) {
  console.log(`  ${v.label.padEnd(17)} ${v.url.padEnd(25)} ${dot(health[k])}`)
}
console.log()
if (running && modules) {
  console.log('  ' + c.bold(`Modules (${modules.length})`))
  console.log('  ' + '─'.repeat(54))
  for (const m of modules) {
    const status = m.status || 'unknown'
    const pidStr = m.pid ? `pid ${m.pid}` : ''
    console.log(`  ${(m.id ?? m.module_id ?? '?').padEnd(17)} ${status.padEnd(10)} ${pidStr}`)
  }
  console.log()
} else if (!running) {
  console.log('  ' + c.dim('Modules: instance not running'))
  console.log()
}
if (inst.mode === 'system') {
  console.log('  ' + c.bold('Cluster Config'))
  console.log('  ' + '─'.repeat(54))
  if (clusterCurrent === null) {
    console.log('  ' + c.dim('(no /etc/crabot/cluster.version readable)'))
  } else if (clusterCurrent > (clusterApplied ?? 0)) {
    console.log(`  Cluster Version   ${clusterCurrent}  (applied: ${clusterApplied}, ${clusterCurrent - (clusterApplied ?? 0)} updates pending)`)
    console.log('  ' + c.dim('  Run `crabot sync` to apply.'))
  } else {
    console.log(`  Cluster Version   ${clusterCurrent}  (applied: ${clusterApplied}, up to date)`)
  }
  console.log()
}
if (hasLogs) {
  console.log('  ' + c.bold('Logs'))
  console.log('  ' + '─'.repeat(54))
  if (existsSync(logsStdout)) console.log(`  MM stdout         ${logsStdout}`)
  if (existsSync(logsStderr)) console.log(`  MM stderr         ${logsStderr}`)
  console.log('  ' + c.dim('  Tail with: tail -f $LOG_PATH'))
  console.log()
}
