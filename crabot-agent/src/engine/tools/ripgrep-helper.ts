/**
 * ripgrep adapter — Grep / Glob 工具共用的 rg 子进程封装。
 *
 * 历史原因：旧 grep-tool 用 `walkDirectory + files.map(searchFile)` 纯 JS 同步
 * 读所有文件到内存，在大仓 grep 一次就能爆 4GB+ 堆。对照 claude-code 的
 * GrepTool 实现（spawn rg + 流式 stdout），这里也走原生二进制方案：rg
 * 进程内做匹配，crabot agent 堆只承受输出行。
 *
 * 二进制由 @vscode/ripgrep 提供，npm install 时自动下载平台对应的 rg。
 */

import { spawn } from 'node:child_process'
import { rgPath } from '@vscode/ripgrep'

export interface RipgrepResult {
  /** rg 进程的 stdout 全文（已按 maxBytes 截断）。 */
  stdout: string
  /** rg 进程的 stderr 全文。 */
  stderr: string
  /** 是否因 maxBytes 提前 kill。 */
  truncated: boolean
  /** 进程退出码。rg 约定：0=找到匹配，1=没匹配，2=错误，128+=信号。 */
  exitCode: number
}

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024 // 16MB stdout 上限——再多上层也消化不了
const KILL_GRACE_MS = 500

/**
 * 跑 ripgrep，把 stdout 累到内存上限就 kill。stderr 总是收完（小）。
 *
 * - args: 不要带二进制路径，纯参数
 * - cwd: 不传则 rg 用当前进程 cwd
 * - signal: 可选外部 abort
 *
 * 退出码语义见 RipgrepResult。调用方自己根据 exitCode 决定怎么对外返回——
 * 比如 grep 工具 exitCode=1 应该映射成 "No matches found"，而 exitCode=2
 * 才是真正错误（invalid regex / path 不存在等）。
 */
export function runRipgrep(
  args: ReadonlyArray<string>,
  opts: {
    cwd?: string
    maxBytes?: number
    signal?: AbortSignal
  } = {},
): Promise<RipgrepResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

  return new Promise((resolve, reject) => {
    const proc = spawn(rgPath, [...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let truncated = false
    let killed = false

    const killProc = () => {
      if (killed) return
      killed = true
      try {
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            try { proc.kill('SIGKILL') } catch { /* already dead */ }
          }
        }, KILL_GRACE_MS).unref()
      } catch { /* already dead */ }
    }

    const onAbort = () => {
      truncated = true
      killProc()
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort()
        return resolve({ stdout: '', stderr: '', truncated: true, exitCode: 130 })
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      stdoutBytes += chunk.length
      if (stdoutBytes > maxBytes) {
        // 超额：取到上限为止，丢弃 stream 后续，kill 进程。
        const allowed = maxBytes - (stdoutBytes - chunk.length)
        if (allowed > 0) stdout += chunk.subarray(0, allowed).toString('utf-8')
        truncated = true
        killProc()
        return
      }
      stdout += chunk.toString('utf-8')
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })

    proc.on('error', (err) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      reject(new Error(`ripgrep spawn failed: ${err.message}`))
    })

    proc.on('close', (code, signal) => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort)
      const exitCode = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 0)
      resolve({ stdout, stderr, truncated, exitCode })
    })
  })
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  // 仅为 close 回调里映射用，覆盖常见值即可
  const map: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }
  return map[signal as string]
}

/** ripgrep 默认就跳 .git 等 hidden VCS 目录，这里只额外排掉非 hidden 的"基本不想搜"目录。 */
export const DEFAULT_EXCLUDE_GLOBS: ReadonlyArray<string> = [
  '!node_modules',
  '!.git',
  '!.hg',
  '!.svn',
  '!dist',
  '!.next',
  '!.cache',
]
