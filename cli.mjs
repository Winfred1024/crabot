#!/usr/bin/env node

// cli.mjs — Crabot CLI 入口
// 纯 JS，不依赖任何第三方包，跨平台（macOS/Linux/Windows）

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Windows 上 ESM dynamic import 不接受 C:\... 绝对路径，必须转 file:///C:/...
const importPath = (p) => import(pathToFileURL(p).href)

// 让下游（auth.ts、scripts/*）能在任意 cwd 下找到安装根目录
if (!process.env.CRABOT_HOME) {
  process.env.CRABOT_HOME = __dirname
}

const args = process.argv.slice(2)
const command = args[0] ?? 'help'

const bootstrapCommands = new Set(['start', 'stop', 'check', 'help', 'upgrade'])

if (command === 'password') {
  await importPath(resolve(__dirname, 'scripts/password.mjs'))
} else if (bootstrapCommands.has(command)) {
  const scriptPath = resolve(__dirname, `scripts/${command}.mjs`)
  if (existsSync(scriptPath)) {
    await importPath(scriptPath)
  } else {
    console.error(`Bootstrap command "${command}" not yet available in cli.mjs.`)
    process.exit(1)
  }
} else {
  const cliEntry = resolve(__dirname, 'dist/cli/main.js')
  if (!existsSync(cliEntry)) {
    console.error('CLI not built. Run "crabot start" first or build with "pnpm run build:cli".')
    process.exit(1)
  }
  const { run } = await importPath(cliEntry)
  run(process.argv)
}
