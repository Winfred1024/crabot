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
 * 强制注入到每次 rg 调用的硬限制。这些 flag 不可让上层覆盖：
 *
 * - `--max-filesize=10M`：跳过单个 > 10MB 的文件。
 *   2026-06-07 panic 复盘：用户机器在 crabot agent 主进程内同时 spawn 7+ 个 rg
 *   子进程，单个 rg RSS 飙到 17.5 GB（mmap 巨大日志/数据文件），瞬时占 50+ GB
 *   把 32 GB 机器逼到 kernel watchdog panic。源码工程的合理 grep 不需要扫
 *   10MB+ 的单文件——通常那种文件是 sqlite db / 历史日志 / 模型 weights /
 *   数据 CSV，对源码任务无意义但内存代价巨大。
 * - `--threads=1`：默认 rg 用所有物理核并行。改成单线程后，单 rg 进程内存
 *   占用降一个数量级（不需要每核一套 ranker / decompressor / mmap window），
 *   而且单次 grep 在 SSD 上 IO bound > CPU bound，加线程也快不了多少。
 *
 * 顺序：硬限制 flag 放最前面，让用户传入的 args 不能覆盖（rg 多次声明同 flag
 * 时后写覆盖前写，所以这里放前面意味着上层"加固"是允许的，"放宽"不允许）。
 */
const FORCED_LIMITS: ReadonlyArray<string> = [
  '--max-filesize=10M',
  '--threads=1',
]

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
    const proc = spawn(rgPath, [...FORCED_LIMITS, ...args], {
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
