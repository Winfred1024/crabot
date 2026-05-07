/**
 * Tail-N 行读取日志文件。
 *
 * 用 fs.readFile 全量读 + split 是简单实现；超大文件（>50MB）建议改用反向流读，
 * 当前 use case 单模块日志一般几 MB，简单实现就够。
 */
import fs from 'node:fs/promises'

export async function tailLogFile(filePath: string, lines: number): Promise<string> {
  let content: string
  try {
    content = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return ''
    throw err
  }
  const all = content.split('\n')
  const trimmed = all[all.length - 1] === '' ? all.slice(0, -1) : all
  const tailLines = trimmed.slice(Math.max(0, trimmed.length - lines))
  return tailLines.join('\n') + (tailLines.length > 0 ? '\n' : '')
}
