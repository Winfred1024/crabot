import React, { useMemo, useState } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { Button } from '../../components/Common/Button'
import { Modal } from '../../components/Common/Modal'
import { Tooltip } from '../../components/Common/Tooltip'
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

  if (!skill.previous_snapshot) return null

  const snap = skill.previous_snapshot

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="full"
      ariaLabel={`${skill.name} 版本对比`}
      contentClassName="skill-diff-modal"
      hideCloseButton
      title={
        <span className="skill-diff__title">
          <strong className="skill-diff__name">{skill.name}</strong>
          <span className="skill-diff__versions">
            对比上一版（v{snap.version} → v{skill.version}）
          </span>
          <span className="skill-diff__title-spacer" />
          <label className="skill-diff__split-toggle">
            <input
              type="checkbox"
              checked={splitView}
              onChange={(e) => setSplitView(e.target.checked)}
            />
            <span>并排显示</span>
          </label>
          <Button variant="secondary" onClick={onClose}>关闭</Button>
        </span>
      }
    >
      <div className="skill-diff__layout">
        <aside className="skill-diff__filelist" aria-label="文件列表">
          {entries.map(e => (
            <Tooltip key={e.path} content={e.path}>
              <button
                type="button"
                onClick={() => setActivePath(e.path)}
                className={`skill-diff__file${e.path === activePath ? ' skill-diff__file--active' : ''}`}
              >
                <span className="skill-diff__file-icon" aria-hidden="true">{fileStatusIcon(e)}</span>
                <span className="skill-diff__file-path">{e.path}</span>
              </button>
            </Tooltip>
          ))}
        </aside>

        <section className="skill-diff__viewer" aria-label="差异内容">
          {!activeEntry ? null : activeEntry.isBinary ? (
            <div className="skill-diff__notice">二进制文件，不显示 diff</div>
          ) : activeEntry.currContent === null ? (
            <div className="skill-diff__notice">
              <div>文件已从快照中删除（或当前版本不含此文件）。</div>
              <pre className="skill-diff__raw">{activeEntry.prevContent ?? ''}</pre>
            </div>
          ) : activeEntry.prevContent === null ? (
            <div className="skill-diff__notice">
              <div>此文件为新增（快照中不存在）。</div>
              <pre className="skill-diff__raw">{activeEntry.currContent}</pre>
            </div>
          ) : (
            <ReactDiffViewer
              oldValue={activeEntry.prevContent}
              newValue={activeEntry.currContent}
              splitView={splitView}
              compareMethod={DiffMethod.LINES}
              useDarkTheme
              styles={{
                variables: {
                  dark: {
                    diffViewerBackground: 'var(--bg-secondary)',
                    diffViewerColor: 'var(--text-primary)',
                    addedBackground: 'rgba(92, 184, 122, 0.14)',
                    addedColor: '#a8e0b7',
                    removedBackground: 'rgba(224, 96, 96, 0.14)',
                    removedColor: '#f0a0a0',
                    wordAddedBackground: 'rgba(92, 184, 122, 0.32)',
                    wordRemovedBackground: 'rgba(224, 96, 96, 0.32)',
                    gutterColor: 'var(--text-muted)',
                    gutterBackground: 'var(--bg-primary)',
                    gutterBackgroundDark: 'var(--bg-primary)',
                    addedGutterBackground: 'rgba(92, 184, 122, 0.08)',
                    removedGutterBackground: 'rgba(224, 96, 96, 0.08)',
                    codeFoldGutterBackground: 'var(--surface)',
                    codeFoldBackground: 'var(--surface)',
                    emptyLineBackground: 'transparent',
                  },
                },
              }}
            />
          )}
        </section>
      </div>
    </Modal>
  )
}
