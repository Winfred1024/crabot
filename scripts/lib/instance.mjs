import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILENAME = 'instance.json'

export function hasInstance(homeDir) {
  return existsSync(join(homeDir, FILENAME))
}

export function readInstance(homeDir) {
  const raw = readFileSync(join(homeDir, FILENAME), 'utf-8')
  return JSON.parse(raw)
}

export function writeInstance(homeDir, manifest) {
  writeFileSync(join(homeDir, FILENAME), JSON.stringify(manifest, null, 2) + '\n')
}
