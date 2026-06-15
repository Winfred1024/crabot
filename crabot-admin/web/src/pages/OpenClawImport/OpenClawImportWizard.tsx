/**
 * 从 OpenClaw 迁移导入向导（四步）。
 *
 * 设计依据：crabot-docs/superpowers/specs/2026-06-15-openclaw-migration-design.md §8
 * 1 上传解析 → 2 配置类(provider/channel) → 3 内容类(skills/mcp/memory/workspace) → 4 预览执行
 * 视觉对齐 Admin 设计系统（见 OpenClawImportWizard.css）。
 */
import React, { useMemo, useRef, useState } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { useToast } from '../../contexts/ToastContext'
import {
  openclawImportService,
  type BackupOverview,
  type ImportSelections,
  type ImportSummary,
} from '../../services/openclawImport'
import './OpenClawImportWizard.css'

const PROVIDER_SKIP_LABEL: Record<string, string> = {
  oauth: 'OAuth 凭证无法迁移，请在 crabot 重新配置',
  'secret-ref': '密钥为引用，备份中无明文，请重新填写',
  'unsupported-format': 'crabot 不支持的类型',
}

const SKIP_REASON_LABEL: Record<string, string> = {
  conflict: 'crabot 已存在同名，已跳过',
  'not-migratable': '不可迁移',
  'missing-secret': '密钥不在备份中',
}

const STEP_TITLES = ['上传与解析', '配置类', '内容类', '预览与执行']

export const OpenClawImportWizard: React.FC = () => {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState('')
  const [overview, setOverview] = useState<BackupOverview | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)

  const [selProviders, setSelProviders] = useState<Set<string>>(new Set())
  const [selChannels, setSelChannels] = useState<Set<string>>(new Set())
  const [selMcp, setSelMcp] = useState<Set<string>>(new Set())
  const [selSkills, setSelSkills] = useState<Set<string>>(new Set())
  const [importMemory, setImportMemory] = useState(false)
  const [importWorkspace, setImportWorkspace] = useState(false)

  const channelKey = (c: { source_channel: string; account_id?: string }) => `${c.source_channel}:${c.account_id ?? 'default'}`

  function toggle(set: Set<string>, key: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  async function handleParse() {
    if (!file) return
    setBusy(true)
    try {
      const res = await openclawImportService.parseBackup(file)
      setToken(res.token)
      setOverview(res.overview)
      setSelProviders(new Set(res.overview.providers.filter((p) => p.migratable).map((p) => p.source_name)))
      setSelChannels(new Set(res.overview.channels.filter((c) => c.migratable && c.credentials === 'available').map(channelKey)))
      setSelMcp(new Set(res.overview.mcpServers.filter((m) => m.migratable).map((m) => m.source_name)))
      setSelSkills(new Set(res.overview.skills))
      setImportMemory(res.overview.memory.present)
      setImportWorkspace(false)
      setStep(1)
      toast.success('备份解析成功')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '解析失败')
    } finally {
      setBusy(false)
    }
  }

  const selections: ImportSelections = useMemo(() => {
    const channels = (overview?.channels ?? [])
      .filter((c) => selChannels.has(channelKey(c)))
      .map((c) => ({ source_channel: c.source_channel, account_id: c.account_id ?? 'default' }))
    return { providers: [...selProviders], channels, mcp: [...selMcp], skills: [...selSkills], memory: importMemory, workspace: importWorkspace }
  }, [overview, selProviders, selChannels, selMcp, selSkills, importMemory, importWorkspace])

  async function handleExecute() {
    setBusy(true)
    try {
      const result = await openclawImportService.executeImport(token, selections)
      setSummary(result)
      setStep(3)
      toast.success(`导入完成：成功 ${result.results.filter((r) => r.status === 'imported').length} 项`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <MainLayout>
      <div className="oci-wrap">
        <header className="oci-head">
          <div className="oci-head-mark">🦞</div>
          <div>
            <h1 className="oci-title">从 OpenClaw 迁移</h1>
            <p className="oci-subtitle">
              上传 OpenClaw 的备份（<code>openclaw backup create</code> 产物 .tar.gz），按需迁移配置与内容到 crabot。
            </p>
          </div>
        </header>

        <Stepper step={step} />

        {step === 0 && <UploadStep file={file} setFile={setFile} busy={busy} onParse={handleParse} />}

        {step === 1 && overview && (
          <ConfigStep
            overview={overview}
            selProviders={selProviders}
            selChannels={selChannels}
            onToggleProvider={(k) => toggle(selProviders, k, setSelProviders)}
            onToggleChannel={(k) => toggle(selChannels, k, setSelChannels)}
            channelKey={channelKey}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}

        {step === 2 && overview && (
          <ContentStep
            overview={overview}
            selMcp={selMcp}
            selSkills={selSkills}
            importMemory={importMemory}
            importWorkspace={importWorkspace}
            onToggleMcp={(k) => toggle(selMcp, k, setSelMcp)}
            onToggleSkill={(k) => toggle(selSkills, k, setSelSkills)}
            setImportMemory={setImportMemory}
            setImportWorkspace={setImportWorkspace}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}

        {step === 3 && !summary && <PreviewStep selections={selections} busy={busy} onBack={() => setStep(2)} onExecute={handleExecute} />}
        {step === 3 && summary && <ResultStep summary={summary} />}
      </div>
    </MainLayout>
  )
}

// ── 子组件 ──────────────────────────────────────────────

const Stepper: React.FC<{ step: number }> = ({ step }) => (
  <div className="oci-stepper">
    {STEP_TITLES.map((title, i) => (
      <div key={i} className={`oci-step ${i === step ? 'is-current' : i < step ? 'is-done' : ''}`}>
        <div className="oci-step-node">{i < step ? '✓' : i + 1}</div>
        <div className="oci-step-label">{title}</div>
      </div>
    ))}
  </div>
)

const Row: React.FC<{ disabled?: boolean; checked: boolean; onToggle: () => void; index: number; children: React.ReactNode }> = ({
  disabled,
  checked,
  onToggle,
  index,
  children,
}) => (
  <label className={`oci-row ${disabled ? 'is-disabled' : ''}`} style={{ animationDelay: `${index * 28}ms` }}>
    <input className="oci-check" type="checkbox" disabled={disabled} checked={checked} onChange={onToggle} />
    {children}
  </label>
)

const UploadStep: React.FC<{ file: File | null; setFile: (f: File | null) => void; busy: boolean; onParse: () => void }> = ({ file, setFile, busy, onParse }) => {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="oci-card">
      <div className={`oci-drop ${file ? 'has-file' : ''}`} onClick={() => inputRef.current?.click()}>
        <div className="oci-drop-icon">{file ? '📦' : '⬆'}</div>
        <p className="oci-drop-main">{file ? '已选择备份文件' : '点击选择备份文件'}</p>
        <p className="oci-drop-sub">支持 .tar.gz（openclaw backup create 产物）</p>
        {file && <p className="oci-drop-file">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</p>}
        <input
          ref={inputRef}
          type="file"
          accept=".gz,.tar,.tgz,application/gzip,application/x-gzip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          style={{ display: 'none' }}
        />
      </div>
      <div className="oci-footer">
        <span />
        <button className="btn btn-primary btn-lg" disabled={busy || !file} onClick={onParse}>
          {busy ? '解析中…' : '上传并解析'}
        </button>
      </div>
    </div>
  )
}

const ConfigStep: React.FC<{
  overview: BackupOverview
  selProviders: Set<string>
  selChannels: Set<string>
  onToggleProvider: (k: string) => void
  onToggleChannel: (k: string) => void
  channelKey: (c: { source_channel: string; account_id?: string }) => string
  onBack: () => void
  onNext: () => void
}> = ({ overview, selProviders, selChannels, onToggleProvider, onToggleChannel, channelKey, onBack, onNext }) => (
  <div>
    <section className="oci-card">
      <div className="oci-card-head">
        <h3 className="oci-card-title">Provider</h3>
        <span className="oci-count">{overview.providers.length}</span>
      </div>
      {overview.providers.length === 0 && <p className="oci-empty">备份中没有 provider。</p>}
      {overview.providers.map((p, i) => (
        <Row key={p.source_name} index={i} disabled={!p.migratable} checked={selProviders.has(p.source_name)} onToggle={() => onToggleProvider(p.source_name)}>
          <span className="oci-row-main">
            <span className="oci-row-name">{p.source_name}</span>
            <span className="oci-row-meta">{p.format ?? '—'} · {p.endpoint}</span>
          </span>
          {!p.migratable && p.skip_reason && <span className="oci-tag">{PROVIDER_SKIP_LABEL[p.skip_reason]}</span>}
        </Row>
      ))}
    </section>

    <section className="oci-card">
      <div className="oci-card-head">
        <h3 className="oci-card-title">Channel</h3>
        <span className="oci-count">{overview.channels.length}</span>
      </div>
      <p className="oci-hint">仅 Telegram / 飞书 / Lark 可迁移，其余 channel crabot 暂无对应模块。</p>
      {overview.channels.length === 0 && <p className="oci-empty">备份中没有可识别的 channel。</p>}
      {overview.channels.map((c, i) => {
        const key = channelKey(c)
        const selectable = c.migratable && c.credentials === 'available'
        return (
          <Row key={key} index={i} disabled={!selectable} checked={selChannels.has(key)} onToggle={() => onToggleChannel(key)}>
            <span className="oci-row-main">
              <span className="oci-row-name">{c.source_channel}</span>
              {c.account_id && <span className="oci-row-meta">{c.account_id}{c.feishu_domain ? ` · ${c.feishu_domain}` : ''}</span>}
            </span>
            {!c.migratable && <span className="oci-tag oci-tag--muted">无对应模块</span>}
            {c.migratable && c.credentials === 'unavailable' && <span className="oci-tag">密钥不在备份，需手填</span>}
          </Row>
        )
      })}
    </section>

    <div className="oci-footer">
      <button className="btn btn-secondary" onClick={onBack}>上一步</button>
      <button className="btn btn-primary" onClick={onNext}>下一步</button>
    </div>
  </div>
)

const ContentStep: React.FC<{
  overview: BackupOverview
  selMcp: Set<string>
  selSkills: Set<string>
  importMemory: boolean
  importWorkspace: boolean
  onToggleMcp: (k: string) => void
  onToggleSkill: (k: string) => void
  setImportMemory: (v: boolean) => void
  setImportWorkspace: (v: boolean) => void
  onBack: () => void
  onNext: () => void
}> = ({ overview, selMcp, selSkills, importMemory, importWorkspace, onToggleMcp, onToggleSkill, setImportMemory, setImportWorkspace, onBack, onNext }) => {
  const noWs = !overview.manifest.includeWorkspace
  return (
    <div>
      <section className="oci-card">
        <div className="oci-card-head">
          <h3 className="oci-card-title">Skills</h3>
          <span className="oci-count">{overview.skills.length}</span>
        </div>
        {overview.skills.length === 0 && <p className="oci-empty">备份中没有 skill。</p>}
        {overview.skills.map((s, i) => (
          <Row key={s} index={i} checked={selSkills.has(s)} onToggle={() => onToggleSkill(s)}>
            <span className="oci-row-main"><span className="oci-row-name">{s}</span></span>
          </Row>
        ))}
      </section>

      <section className="oci-card">
        <div className="oci-card-head">
          <h3 className="oci-card-title">MCP Servers</h3>
          <span className="oci-count">{overview.mcpServers.length}</span>
        </div>
        {overview.mcpServers.length === 0 && <p className="oci-empty">备份中没有 MCP server。</p>}
        {overview.mcpServers.map((m, i) => (
          <Row key={m.source_name} index={i} disabled={!m.migratable} checked={selMcp.has(m.source_name)} onToggle={() => onToggleMcp(m.source_name)}>
            <span className="oci-row-main">
              <span className="oci-row-name">{m.name}</span>
              <span className="oci-row-meta">{m.transport}</span>
            </span>
            {m.requires_local_env && <span className="oci-tag">依赖本机环境</span>}
          </Row>
        ))}
      </section>

      <section className="oci-card">
        <div className="oci-card-head"><h3 className="oci-card-title">记忆与工作区</h3></div>
        {noWs && <p className="oci-hint" style={{ color: 'var(--warning-text)' }}>此备份未包含 workspace，记忆与工作区文件均缺失。请用完整备份（不带 --no-include-workspace）重新导出。</p>}
        <Row index={0} disabled={noWs || !overview.memory.present} checked={importMemory} onToggle={() => setImportMemory(!importMemory)}>
          <span className="oci-row-main">
            <span className="oci-row-name">导入记忆</span>
            <span className="oci-row-meta">{overview.memory.fileCount} 个文件 → Memory v2</span>
          </span>
        </Row>
        <Row index={1} disabled={noWs || !overview.workspace.present} checked={importWorkspace} onToggle={() => setImportWorkspace(!importWorkspace)}>
          <span className="oci-row-main">
            <span className="oci-row-name">导入工作区文件</span>
            <span className="oci-row-meta">{overview.workspace.fileCount} 个文件</span>
          </span>
        </Row>
      </section>

      <div className="oci-footer">
        <button className="btn btn-secondary" onClick={onBack}>上一步</button>
        <button className="btn btn-primary" onClick={onNext}>下一步</button>
      </div>
    </div>
  )
}

const PreviewStep: React.FC<{ selections: ImportSelections; busy: boolean; onBack: () => void; onExecute: () => void }> = ({ selections, busy, onBack, onExecute }) => (
  <div>
    <section className="oci-card">
      <div className="oci-card-head"><h3 className="oci-card-title">即将导入</h3></div>
      <ul className="oci-stats">
        <li><span>Provider</span><b>{selections.providers.length}</b></li>
        <li><span>Channel</span><b>{selections.channels.length}</b></li>
        <li><span>MCP</span><b>{selections.mcp.length}</b></li>
        <li><span>Skills</span><b>{selections.skills.length}</b></li>
        <li><span>记忆</span><b>{selections.memory ? '是' : '否'}</b></li>
        <li><span>工作区文件</span><b>{selections.workspace ? '是' : '否'}</b></li>
      </ul>
      <p className="oci-hint" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>冲突项（crabot 已存在同名）将自动跳过。</p>
    </section>
    <div className="oci-footer">
      <button className="btn btn-secondary" onClick={onBack}>上一步</button>
      <button className="btn btn-primary btn-lg" disabled={busy} onClick={onExecute}>{busy ? '导入中…' : '执行导入'}</button>
    </div>
  </div>
)

const ResultStep: React.FC<{ summary: ImportSummary }> = ({ summary }) => {
  const imported = summary.results.filter((r) => r.status === 'imported')
  const skipped = summary.results.filter((r) => r.status === 'skipped')
  return (
    <section className="oci-card">
      <div className="oci-result-head">
        <div className="oci-result-badge">✓</div>
        <div>
          <h3 className="oci-card-title">导入完成</h3>
          <p className="oci-subtitle">成功 {imported.length} 项 · 跳过 {skipped.length} 项{summary.errors.length ? ` · 错误 ${summary.errors.length}` : ''}</p>
        </div>
      </div>

      {imported.length > 0 && (
        <>
          <div className="oci-group-label is-ok">已导入</div>
          {imported.map((r, i) => (
            <div className="oci-result-row" key={i}><span className="oci-result-kind">{r.kind}</span>{r.name}</div>
          ))}
        </>
      )}

      {skipped.length > 0 && (
        <>
          <div className="oci-group-label is-skip">已跳过</div>
          {skipped.map((r, i) => (
            <div className="oci-result-row" key={i}>
              <span className="oci-result-kind">{r.kind}</span>
              {r.name} — {r.reason ? SKIP_REASON_LABEL[r.reason] : '已跳过'}
            </div>
          ))}
        </>
      )}

      {summary.errors.length > 0 && (
        <>
          <div className="oci-group-label is-err">错误</div>
          {summary.errors.map((e, i) => (
            <div className="oci-result-row" key={i} style={{ color: 'var(--error)' }}>{e}</div>
          ))}
        </>
      )}
    </section>
  )
}
