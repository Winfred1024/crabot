import type { InternalHandler, FormattedDiagnostic } from './types'
import { extractFilePaths } from '../engine/tool-orchestration'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { classifyCliSubcommand, REQUIRES_CONTENT_REVIEW } from 'crabot-shared'
import { parseCrabotInvocation } from './crabot-cmd-parser.js'

const handlers = new Map<string, InternalHandler>()

export function registerInternalHandler(name: string, handler: InternalHandler): void {
  handlers.set(name, handler)
}

export function getInternalHandler(name: string): InternalHandler | undefined {
  return handlers.get(name)
}

// --- Built-in: lsp-diagnostics ---

registerInternalHandler('lsp-diagnostics', async (input, context) => {
  if (!context.lspManager) {
    return { action: 'continue' }
  }

  const filePath = input.toolInput ? extractFilePaths(input.toolInput)[0] : undefined
  if (!filePath) {
    return { action: 'continue' }
  }

  try {
    const content = await fsp.readFile(filePath, 'utf-8')
    context.lspManager.notifyFileChanged(filePath, content)
    const diagnostics = await context.lspManager.getDiagnostics(filePath)

    if (diagnostics.length === 0) {
      return { action: 'continue' }
    }

    const message = formatDiagnosticsMessage(diagnostics)
    const hasErrors = diagnostics.some((d) => d.severity === 'error')

    return {
      action: hasErrors ? 'block' : 'continue',
      message,
    }
  } catch {
    return { action: 'continue' }
  }
})

// --- Built-in: compile-check ---

registerInternalHandler('compile-check', async (_input, context) => {
  const cwd = context.workingDirectory
  const detected = detectProjectType(cwd)

  if (!detected) {
    return { action: 'continue' }
  }

  return new Promise((resolve) => {
    const child = exec(detected.command, { cwd, timeout: 55_000 }, (error, _stdout, stderr) => {
      if (error) {
        resolve({
          action: 'block',
          message: `Compile check failed (${detected.type}):\n${(stderr || error.message).slice(0, 2000)}`,
        })
      } else {
        resolve({ action: 'continue' })
      }
    })
    child.stdin?.end()
  })
})

// --- Built-in: cli-permission-gate ---
// 解析 Bash 命令中的 crabot 调用，按 effective permissions 决策：
//   1. --reveal → 永远 block（master 也不行）
//   2. 未识别子命令 → fail-closed block（master 也拦，避免新命令未入表前默认放行）
//   3. master → 短路放行
//   4. 硬闸：cli_access[domain] 与 (read/write) 不匹配 → block
//   5. 软闸：REQUIRES_CONTENT_REVIEW（仅 schedule add）→ 调 contentReviewer，deny → block
registerInternalHandler('cli-permission-gate', async (input, context) => {
  const cmdStr = String(input.toolInput?.['command'] ?? '')
  const parsed = parseCrabotInvocation(cmdStr)
  if (!parsed) return { action: 'continue' }

  // 1. --reveal 永不放行（master 也不行，by design）
  if (parsed.hasReveal) {
    return {
      action: 'block',
      message: 'PERMISSION_DENIED: `--reveal` 永不暴露给 agent。',
    }
  }

  // 2. 解析 (domain, kind) —— 未识别 fail-closed，即便 master 也拦
  const cls = classifyCliSubcommand(parsed.subcommand)
  if (!cls) {
    return {
      action: 'block',
      message: `PERMISSION_DENIED: 未识别的 crabot 子命令 \`${parsed.subcommand}\`（fail-closed）。`,
    }
  }

  // 3. master 短路（master 身份特权，不依赖 cli_access 配置）
  if (context.senderIsMaster) {
    return { action: 'continue' }
  }

  // 4. 硬闸：cli_access[domain]
  const cliAccess = context.resolvedPermissions?.cli_access
  if (!cliAccess) {
    return {
      action: 'block',
      message: 'PERMISSION_DENIED: 当前权限上下文缺失，无法放行 CLI 命令（fail-closed）。',
    }
  }
  const allowed = cliAccess[cls.domain]
  const passes =
    (cls.kind === 'read' && (allowed === 'read' || allowed === 'write')) ||
    (cls.kind === 'write' && allowed === 'write')
  if (!passes) {
    return {
      action: 'block',
      message: `PERMISSION_DENIED: cli_access.${cls.domain}=${allowed}，无法执行 ${cls.kind} 命令 \`${parsed.subcommand}\`。`,
    }
  }

  // 5. 软闸：内容审核（仅 schedule add）
  if (REQUIRES_CONTENT_REVIEW.has(parsed.subcommand)) {
    if (!context.contentReviewer || !context.resolvedPermissions) {
      return {
        action: 'block',
        message: 'PERMISSION_DENIED: 内容审核器未配置（fail-closed）。',
      }
    }
    // 显式 try/catch：reviewer 抛错时本 handler 必须 fail-closed deny。
    // 不能依赖 hook-executor 的 catch（它会把 error 转成 action:'continue'，等于 fail-OPEN，
    // 完全破坏内容审核的安全语义）。
    let review
    try {
      review = await context.contentReviewer({
        effectivePermissions: context.resolvedPermissions,
        commandText: cmdStr,
      })
    } catch (err) {
      return {
        action: 'block',
        message: `PERMISSION_DENIED: 内容审核器异常（fail-closed） — ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (review.verdict === 'deny') {
      return {
        action: 'block',
        message: `PERMISSION_DENIED: 该请求未通过内容审核 — ${review.reason}`,
      }
    }
  }

  return { action: 'continue' }
})

// --- Legacy alias: block-cli-write → cli-permission-gate ---
registerInternalHandler('block-cli-write', async (input, context) => {
  const fwd = getInternalHandler('cli-permission-gate')
  if (!fwd) {
    return { action: 'block', message: 'PERMISSION_DENIED: cli-permission-gate handler 未注册。' }
  }
  return fwd(input, context)
})

// --- Legacy alias: block-cli → cli-permission-gate ---
registerInternalHandler('block-cli', async (input, context) => {
  const fwd = getInternalHandler('cli-permission-gate')
  if (!fwd) {
    return { action: 'block', message: 'PERMISSION_DENIED: cli-permission-gate handler 未注册。' }
  }
  return fwd(input, context)
})

// --- Helpers ---

function formatDiagnosticsMessage(diagnostics: ReadonlyArray<FormattedDiagnostic>): string {
  const lines = diagnostics.map((d) =>
    `${d.filePath}:${d.line}:${d.column} [${d.severity.toUpperCase()}] ${d.message} (${d.source})`
  )
  return `LSP Diagnostics:\n${lines.join('\n')}`
}

interface ProjectType {
  readonly type: string
  readonly command: string
}

function detectProjectType(cwd: string): ProjectType | undefined {
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    return { type: 'node', command: 'npm run build --if-present 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    return { type: 'rust', command: 'cargo check 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'go.mod'))) {
    return { type: 'go', command: 'go build ./... 2>&1' }
  }
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'setup.py'))) {
    return { type: 'python', command: 'python -m py_compile $(find . -name "*.py" -not -path "*/venv/*" | head -20) 2>&1' }
  }
  return undefined
}
