import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const SHARED_MODULE = 'crabot-shared'
const JS_MODULES = [
  'crabot-core',
  'crabot-admin',
  'crabot-agent',
  'crabot-channel-host',
  'crabot-channel-wechat',
  'crabot-channel-telegram',
  'crabot-channel-feishu',
  'crabot-mcp-tools',
]
const PY_MODULE = 'crabot-memory'

// Windows 上 corepack/pnpm/uv/npx 这些都是 .cmd shim，spawn 不开 shell 不会按
// PATHEXT 匹配后缀，必须显式拼 .cmd。开 shell:true 又会触发 Node 24 的 DEP0190
// 警告（args 数组未转义有注入风险），所以走「显式后缀 + 不开 shell」。
const WIN_CMD_SHIMS = new Set(['corepack', 'pnpm', 'npm', 'npx', 'yarn', 'uv', 'tsx'])
function resolveBin(cmd) {
  if (process.platform !== 'win32') return cmd
  return WIN_CMD_SHIMS.has(cmd) ? `${cmd}.cmd` : cmd
}

function runCmd(cmd, args, cwd, logger) {
  return new Promise((resolve, reject) => {
    logger.info(`$ ${cmd} ${args.join(' ')}    (cwd: ${cwd})`)
    const proc = spawn(resolveBin(cmd), args, { cwd, stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

// 所有 pnpm 调用走 corepack，避免被用户机器上抢占 PATH 的全局 pnpm 干扰
// （否则可能用错 major 版本，把 lockfile v9.0 降级成 v5.4）
async function installAndBuild(moduleDir, logger) {
  // --prefer-offline：lock 未变时跳过网络 verify，毫秒级返回
  await runCmd('corepack', ['pnpm', 'install', '--prefer-offline'], moduleDir, logger)
  await runCmd('corepack', ['pnpm', 'run', 'build'], moduleDir, logger)
}

export async function runSourceUpgrade(crabotHome, logger) {
  // 注意：不调 `corepack enable` —— 它会尝试往 Node 安装目录（Windows 下是
  // Program Files）写 pnpm/yarn 系统 shim，需要管理员权限。我们已经显式用
  // `corepack pnpm ...` 调用，corepack 会按 package.json 的 packageManager
  // 字段按需下载到用户 cache（%LOCALAPPDATA%\node\corepack）执行，不需要 enable。
  await runCmd('corepack', ['pnpm', 'install', '--prefer-offline'], crabotHome, logger)

  const sharedDir = join(crabotHome, SHARED_MODULE)
  if (existsSync(sharedDir)) {
    await installAndBuild(sharedDir, logger)
  }

  for (const mod of JS_MODULES) {
    const dir = join(crabotHome, mod)
    if (!existsSync(dir)) continue
    await installAndBuild(dir, logger)
  }

  // 前端
  const webDir = join(crabotHome, 'crabot-admin', 'web')
  if (existsSync(webDir)) {
    await installAndBuild(webDir, logger)
  }

  await runCmd('corepack', ['pnpm', 'run', 'build:cli'], crabotHome, logger)

  const memoryDir = join(crabotHome, PY_MODULE)
  if (existsSync(memoryDir)) {
    await runCmd('uv', ['sync'], memoryDir, logger)
  }
}

export async function syncPythonDeps(crabotHome, logger) {
  const memoryDir = join(crabotHome, PY_MODULE)
  if (existsSync(memoryDir)) {
    await runCmd('uv', ['sync'], memoryDir, logger)
  }
}
