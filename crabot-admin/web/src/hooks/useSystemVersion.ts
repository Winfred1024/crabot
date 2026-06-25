import { useEffect, useState } from 'react'
import { versionService, type VersionState } from '../services/version'

let cache: VersionState | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function setCache(next: VersionState) {
  cache = next
  emit()
}

function load(force = false): Promise<void> {
  if (inflight) return inflight
  inflight = (force ? versionService.check() : versionService.get())
    .then(setCache)
    .catch(() => {}) // 失败保留旧值，徽标不闪
    .finally(() => { inflight = null })
  return inflight
}

export function useSystemVersion() {
  const [state, setState] = useState<VersionState | null>(cache)
  useEffect(() => {
    const l = () => setState(cache)
    listeners.add(l)
    if (!cache) void load()
    return () => { listeners.delete(l) }
  }, [])
  return {
    state,
    refresh: () => load(true),
    /** 直接替换缓存（升级状态机轮询时用） */
    setCache,
  }
}

/** 供轮询场景直接拉取（不经 hook 缓存订阅链路） */
export function pollVersion(): Promise<VersionState> {
  return versionService.get().then((s) => { setCache(s); return s })
}

/** 仅供测试使用：重置模块级缓存，防止用例间串扰 */
export function __resetForTest() {
  cache = null
  inflight = null
  listeners.clear()
}
