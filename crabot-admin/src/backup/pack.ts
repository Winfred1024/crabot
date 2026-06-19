/**
 * staging 目录（manifest.json + payload/）打成 gzip tar。
 * 用 tar v7（项目已有依赖）；cwd=staging 让归档内路径相对根。
 * 设计依据：2026-06-19-crabot-backup-migration-design.md §4
 */
import * as tar from 'tar'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function packArchive(params: { staging: string; outPath: string }): Promise<void> {
  const { staging, outPath } = params
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const top = await fs.readdir(staging)
  await tar.c({ gzip: true, file: outPath, cwd: staging }, top)
}
