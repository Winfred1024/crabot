import { execFileSync } from 'node:child_process'

/**
 * 同步执行 git，返回 stdout（trim 后）。失败抛错。
 * proxyUrl 非空时给子进程注入 HTTPS_PROXY/HTTP_PROXY（git 走 https，认这两个 env）。
 */
export function defaultGitRunner(
  args: string[],
  opts?: { cwd?: string; proxyUrl?: string | null },
): string {
  const env = { ...process.env }
  if (opts?.proxyUrl) {
    env.HTTPS_PROXY = opts.proxyUrl
    env.HTTP_PROXY = opts.proxyUrl
  }
  return execFileSync('git', args, {
    cwd: opts?.cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
