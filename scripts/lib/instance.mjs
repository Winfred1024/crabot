import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILENAME = 'instance.json'

export function hasInstance(homeDir) {
  return existsSync(join(homeDir, FILENAME))
}

export function readInstance(homeDir) {
  const path = join(homeDir, FILENAME)
  const raw = readFileSync(path, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`instance.json 损坏（${path}：${err.message}）；请删除后重新运行 \`crabot init\``)
  }
}

export function writeInstance(homeDir, manifest) {
  writeFileSync(join(homeDir, FILENAME), JSON.stringify(manifest, null, 2) + '\n')
}
