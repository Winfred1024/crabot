import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../../..')

// 守卫：daemon 启动路径（crabot start -d）在运行时直接 import 的第三方包，
// 必须落在 root package.json 的 dependencies。
//
// 历史教训：rotating-file-stream 曾被放进 devDependencies。release 打包对
// root node_modules 跑 `pnpm install --prod` 把 devDeps 裁掉 → 用户机器上
// supervisor.mjs 顶层 `import { createStream } from 'rotating-file-stream'`
// 抛 MODULE_NOT_FOUND → detached 后台进程静默退出（stdio:'ignore'），连
// mm.stderr.log 都来不及建，表现为「crabot start -d 起不来且日志也没有」。
const DAEMON_BOOT_SCRIPTS = ['scripts/start.mjs', 'scripts/supervisor.mjs']

function bareImports(file) {
  const src = readFileSync(resolve(ROOT, file), 'utf-8')
  const specifiers = new Set()
  const re = /^\s*import\s+(?:[^'"]*\sfrom\s+)?['"]([^'"]+)['"]/gm
  let m
  while ((m = re.exec(src)) !== null) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('node:')) continue
    // 取包名（含 scoped）
    const pkg = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0]
    specifiers.add(pkg)
  }
  return specifiers
}

describe('daemon 启动路径的运行时依赖', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'))
  const deps = pkg.dependencies ?? {}

  for (const file of DAEMON_BOOT_SCRIPTS) {
    for (const spec of bareImports(file)) {
      it(`${file} 直接 import 的 ${spec} 必须在 root dependencies（不能只在 devDependencies）`, () => {
        expect(deps).toHaveProperty(spec)
      })
    }
  }
})
