// scripts/_preflight.mjs
//
// Side-effect import — 每个直接被 user 调用的 entry 在 `import './lib/*'` 之前
// `import './_preflight.mjs'` 一行即可（ESM 保证 static import 按声明顺序求值）。
//
// 用途：兼容老版本升级路径漏装 scripts/lib 依赖的场景。scripts/lib 是独立 npm 包
// （依赖 proper-lockfile 等），不属于 root workspace；老版本 install.sh / upgrade
// 流程没装它，老用户升到新版后第一次 start 时 import lib/registry.mjs 会崩。
//
// 这里 detect 缺失 → 自动跑一次 corepack pnpm install --prod；失败给出明确指引。

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptsLibDir = resolve(__dirname, 'lib')
const pkg = resolve(scriptsLibDir, 'package.json')
const nm = resolve(scriptsLibDir, 'node_modules')

if (existsSync(pkg) && !existsSync(nm)) {
  console.log('[crabot] scripts/lib deps missing, auto-installing once...')
  const r = spawnSync('corepack', ['pnpm', 'install', '--prod', '--prefer-offline'], {
    cwd: scriptsLibDir, stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('[crabot] scripts/lib pnpm install failed; please run manually:')
    console.error(`[crabot]   cd ${scriptsLibDir} && corepack pnpm install --prod`)
    process.exit(1)
  }
}
