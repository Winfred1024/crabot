import React, { useState } from 'react'
import type { PermissionTemplate } from '../../../types'
import { Button } from '../../../components/Common/Button'

interface TemplateInitButtonProps {
  templates: readonly PermissionTemplate[]
  onInitialize: (template: PermissionTemplate) => void
}

export const TemplateInitButton: React.FC<TemplateInitButtonProps> = ({ templates, onInitialize }) => {
  const [open, setOpen] = useState(false)

  const handlePick = (tpl: PermissionTemplate) => {
    setOpen(false)
    onInitialize(tpl)
  }

  return (
    <div className="template-init-button">
      <Button variant="secondary" onClick={() => setOpen((v) => !v)}>
        用模板初始化 ▾
      </Button>
      {open && (
        <div className="template-init-dropdown" role="menu">
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              role="menuitem"
              className="template-init-dropdown-item"
              onClick={() => handlePick(tpl)}
            >
              <strong>{tpl.name}</strong>
              {tpl.is_system && <span className="template-init-tag">系统</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
