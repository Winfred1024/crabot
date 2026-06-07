import React, { useEffect, useMemo, useState } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { Button } from '../../components/Common/Button'
import type { SkillRegistryEntry } from '../../types'

interface FileEntry {
  /** 相对路径，'SKILL.md' 永远首位 */
  path: string
  /** null 表示该文件在 previous 不存在（即"新增"） */
  prevContent: string | null
  /** null 表示该文件在 current 不存在（即"删除"） */
  currContent: string | null
  isBinary: boolean
}

function decodeFile(value: string): { text: string; isBinary: boolean } {
  if (value.startsWith('base64:')) return { text: '[二进制文件]', isBinary: true }
  return { text: value, isBinary: false }
}

function buildFileEntries(skill: SkillRegistryEntry): FileEntry[] {
  const snap = skill.previous_snapshot!
  const prev: Record<string, string> = { 'SKILL.md': snap.content, ...(snap.files ?? {}) }
  // MVP：当前的附属文件无法在前端拿到（admin GET 只返 content 不返 files 副本），
  // 仅显示 SKILL.md 的 diff + 列出快照里有的附属（与"当前未知"对比）。
  // follow-up：admin 提供 GET /api/skills/:id/dir-files endpoint 拉当前附属。
  const curr: Record<string, string> = { 'SKILL.md': skill.content }

  const allPaths = new Set([...Object.keys(prev), ...Object.keys(curr)])
  const entries: FileEntry[] = []
  for (const p of allPaths) {
    const prevRaw = prev[p] ?? null
    const currRaw = curr[p] ?? null
    const prevDecoded = prevRaw !== null ? decodeFile(prevRaw) : null
    const currDecoded = currRaw !== null ? decodeFile(currRaw) : null
    entries.push({
      path: p,
      prevContent: prevDecoded?.text ?? null,
      currContent: currDecoded?.text ?? null,
      isBinary: (prevDecoded?.isBinary ?? false) || (currDecoded?.isBinary ?? false),
    })
  }
  // SKILL.md 置顶，其它按字母序
  entries.sort((a, b) => {
    if (a.path === 'SKILL.md') return -1
    if (b.path === 'SKILL.md') return 1
    return a.path.localeCompare(b.path)
  })
  return entries
}

function fileStatusIcon(e: FileEntry): string {
  if (e.prevContent === null) return '🟢'
  if (e.currContent === null) return '🔴'
  if (e.prevContent !== e.currContent) return '🟡'
  return '⚪'
}

interface Props {
  skill: SkillRegistryEntry
  open: boolean
  onClose: () => void
}

export const SkillDiffModal: React.FC<Props> = ({ skill, open, onClose }) => {
  const [splitView, setSplitView] = useState(true)
  const [activePath, setActivePath] = useState<string>('SKILL.md')

  const entries = useMemo(
    () => (skill.previous_snapshot ? buildFileEntries(skill) : []),
    [skill]
  )
  const activeEntry = entries.find(e => e.path === activePath) ?? entries[0]

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (open) document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open || !skill.previous_snapshot) return null

  const snap = skill.previous_snapshot

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        role="dialog"
        aria-modal="true"
        aria-label={`${skill.name} 版本对比`}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '90vw',
          width: '90vw',
          height: '85vh',
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '0.75rem 1rem',
          borderBottom: '1px solid var(--border-color, #3a3a3e)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
        }}>
          <div style={{ fontSize: '0.95rem' }}>
            <strong>{skill.name}</strong>
            <span style={{ marginLeft: '0.5rem', color: 'var(--text-secondary)' }}>
              对比上一版（v{snap.version} → v{skill.version}）
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <label style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={splitView}
                onChange={(e) => setSplitView(e.target.checked)}
                style={{ marginRight: '0.35rem', verticalAlign: 'middle' }}
              />
              并排显示
            </label>
            <Button variant="secondary" onClick={onClose} style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}>关闭</Button>
          </div>
        </div>

        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* 文件列表 */}
          <div style={{
            width: 240,
            borderRight: '1px solid var(--border-color, #3a3a3e)',
            overflowY: 'auto',
            padding: '0.5rem',
            flexShrink: 0,
          }}>
            {entries.map(e => (
              <div
                key={e.path}
                onClick={() => setActivePath(e.path)}
                style={{
                  padding: '0.4rem 0.6rem',
                  cursor: 'pointer',
                  borderRadius: 4,
                  background: e.path === activePath ? 'rgba(59,130,246,0.15)' : 'transparent',
                  color: e.path === activePath ? 'var(--primary, #3b82f6)' : 'inherit',
                  fontSize: '0.8rem',
                  fontFamily: 'monospace',
                  marginBottom: 2,
                  wordBreak: 'break-all',
                }}
              >
                <span style={{ marginRight: '0.4rem' }}>{fileStatusIcon(e)}</span>
                {e.path}
              </div>
            ))}
          </div>

          {/* diff 区 */}
          <div style={{ flex: 1, overflow: 'auto', background: '#ffffff', color: '#1a1a1e' }}>
            {!activeEntry ? null : activeEntry.isBinary ? (
              <div style={{ padding: '1rem', color: '#666' }}>二进制文件，不显示 diff</div>
            ) : activeEntry.currContent === null ? (
              <div style={{ padding: '1rem', color: '#666' }}>
                文件已从快照中删除（或当前版本不含此文件）。
                <pre style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>{activeEntry.prevContent ?? ''}</pre>
              </div>
            ) : activeEntry.prevContent === null ? (
              <div style={{ padding: '1rem', color: '#666' }}>
                此文件为新增（快照中不存在）。
                <pre style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>{activeEntry.currContent}</pre>
              </div>
            ) : (
              <ReactDiffViewer
                oldValue={activeEntry.prevContent}
                newValue={activeEntry.currContent}
                splitView={splitView}
                compareMethod={DiffMethod.LINES}
                useDarkTheme={false}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
