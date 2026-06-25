import React, { useEffect, useRef, useState } from 'react'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { useSystemVersion, pollVersion } from '../../hooks/useSystemVersion'
import { versionService, type VersionState } from '../../services/version'

type Phase = 'idle' | 'starting' | 'upgrading' | 'restarting' | 'success' | 'failed' | 'timeout'

const POLL_INTERVAL = 3000
const TIMEOUT_MS = 5 * 60 * 1000

export const VersionUpgradeCard: React.FC = () => {
  const { state, refresh } = useSystemVersion()
  const toast = useToast()
  const [checking, setChecking] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const targetVersion = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 组件卸载时清理轮询定时器
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current)
  }, [])

  // system mode 不渲染整张卡片
  if (state && state.upgrade_capability === 'system') return null

  const handleCheck = () => {
    setChecking(true)
    refresh().finally(() => setChecking(false))
  }

  const startUpgradePolling = (expected: string | null) => {
    const startedAt = Date.now()
    targetVersion.current = expected
    setPhase('upgrading')
    timerRef.current = setInterval(async () => {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        clearInterval(timerRef.current!)
        timerRef.current = null
        setPhase('timeout')
        return
      }
      try {
        const fresh: VersionState = await pollVersion()
        if (fresh.last_upgrade?.phase === 'failed') {
          clearInterval(timerRef.current!)
          timerRef.current = null
          setPhase('failed')
          return
        }
        // 接口恢复且版本已变 → 成功
        if (
          fresh.last_upgrade?.phase === 'done' ||
          (expected && fresh.current_version === expected)
        ) {
          clearInterval(timerRef.current!)
          timerRef.current = null
          setPhase('success')
          toast.success('升级完成')
        }
      } catch {
        // 请求失败 = MM 正在重启，标记 restarting 继续轮询
        setPhase('restarting')
      }
    }, POLL_INTERVAL)
  }

  const handleUpgrade = async () => {
    setPhase('starting')
    try {
      await versionService.startUpgrade()
      startUpgradePolling(state?.latest_version ?? null)
    } catch (err) {
      setPhase('idle')
      toast.error(err instanceof Error ? err.message : '启动升级失败')
    }
  }

  if (!state) {
    return <Card title="版本与升级"><p className="settings-card__hint">加载中…</p></Card>
  }

  const blockers = state.source_blockers ?? []
  const inProgress = phase === 'starting' || phase === 'upgrading' || phase === 'restarting'
  const canUpgrade =
    state.upgrade_available &&
    !(state.upgrade_capability === 'source' && blockers.length > 0)

  return (
    <Card title="版本与升级">
      <div className="version-card">
        <div className="version-card__row">
          <span className="version-card__label">当前版本</span>
          <span className="version-card__value">{state.current_version ?? '未知'}</span>
        </div>
        <div className="version-card__row">
          <span className="version-card__label">最新版本</span>
          <span className="version-card__value">
            {state.latest_version ?? '未知'}
            {state.upgrade_available && <span className="version-card__tag">有更新</span>}
          </span>
        </div>
        {state.last_checked && (
          <div className="version-card__hint">
            上次检查：{new Date(state.last_checked).toLocaleString()}
          </div>
        )}
        {state.error && <div className="version-card__error">检查更新失败：{state.error}</div>}

        {state.upgrade_capability === 'source' && blockers.length > 0 && (
          <div className="version-card__warning">
            无法一键升级：{blockers.join('；')}。请在终端 <code>git pull && ./dev.sh</code>。
          </div>
        )}

        {inProgress && (
          <div className="version-card__progress">
            {phase === 'restarting' ? '服务正在重启…' : '升级中…'}
          </div>
        )}
        {phase === 'success' && <div className="version-card__ok">升级成功，可刷新页面。</div>}
        {phase === 'failed' && (
          <div className="version-card__error">升级失败，请在终端运行 <code>crabot status</code> 排查。</div>
        )}
        {phase === 'timeout' && (
          <div className="version-card__error">升级超时未恢复，请手动检查 <code>crabot status</code>。</div>
        )}

        {state.upgrade_capability === 'source' && state.upgrade_available && (state.source_blockers?.length ?? 0) === 0 && (
          <div className="version-card__hint">升级将通过 git pull 拉取最新代码并重新构建。</div>
        )}

        <div className="version-card__actions">
          <Button variant="secondary" onClick={handleCheck} disabled={checking || inProgress}>
            {checking ? '检查中…' : '检查更新'}
          </Button>
          <Button
            variant="primary"
            onClick={handleUpgrade}
            disabled={!canUpgrade || inProgress}
          >
            {inProgress ? '升级中…' : '升级到最新版本'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
