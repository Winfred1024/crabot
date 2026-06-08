import React, { useState } from 'react'
import type { CliAccessConfig, CliDomain, CliPerm } from '../../../types'
import { CLI_DOMAIN_LABELS } from '../../../types'

const PRIMARY_DOMAINS: readonly CliDomain[] = ['schedule', 'mcp', 'skill', 'channel'] as const
const ADVANCED_DOMAINS: readonly CliDomain[] = [
  'provider', 'agent', 'friend', 'permission', 'config', 'undo',
] as const

interface CliAccessEditorProps {
  value: CliAccessConfig
  onChange: (next: CliAccessConfig) => void
}

const PERMS: readonly CliPerm[] = ['none', 'read', 'write'] as const

export const CliAccessEditor: React.FC<CliAccessEditorProps> = ({ value, onChange }) => {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const handleChange = (domain: CliDomain, perm: CliPerm) => {
    onChange({ ...value, [domain]: perm })
  }

  const renderRow = (domain: CliDomain) => (
    <div key={domain} className="cli-access-row">
      <span className="cli-access-row__label">{CLI_DOMAIN_LABELS[domain]}</span>
      <div className="cli-access-row__perms" role="radiogroup">
        {PERMS.map((perm) => (
          <label
            key={perm}
            className={`cli-access-perm cli-access-perm--${perm} ${value[domain] === perm ? 'cli-access-perm--active' : ''}`}
          >
            <input
              type="radio"
              name={`cli-access-${domain}`}
              aria-label={`${domain}-${perm}`}
              checked={value[domain] === perm}
              onChange={() => handleChange(domain, perm)}
            />
            <span>{perm === 'none' ? '禁用' : perm === 'read' ? '只读' : '读写'}</span>
          </label>
        ))}
      </div>
    </div>
  )

  return (
    <div className="cli-access-editor">
      <div className="cli-access-list">
        {PRIMARY_DOMAINS.map(renderRow)}
      </div>
      <button
        type="button"
        className="cli-access-advanced-toggle"
        onClick={() => setAdvancedOpen((v) => !v)}
        aria-expanded={advancedOpen}
      >
        {advancedOpen ? '▼' : '▶'} 高级权限（系统级 CLI）
      </button>
      {advancedOpen && (
        <div className="cli-access-list">
          {ADVANCED_DOMAINS.map(renderRow)}
        </div>
      )}
    </div>
  )
}
