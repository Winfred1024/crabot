import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TemplateInitButton } from './TemplateInitButton'
import type { PermissionTemplate } from '../../../types'

const fakeTemplates: PermissionTemplate[] = [
  {
    id: 'group_scheduler',
    name: '群聊排程',
    is_system: true,
    tool_access: {} as any,
    cli_access: {} as any,
    storage: null,
    memory_scopes: [],
    created_at: '', updated_at: '',
  },
  {
    id: 'standard',
    name: '普通权限',
    is_system: true,
    tool_access: {} as any,
    cli_access: {} as any,
    storage: null,
    memory_scopes: [],
    created_at: '', updated_at: '',
  },
]

describe('TemplateInitButton', () => {
  it('点开下拉显示所有模板', () => {
    render(<TemplateInitButton templates={fakeTemplates} onInitialize={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /用模板初始化/ }))
    expect(screen.getByText('群聊排程')).toBeInTheDocument()
    expect(screen.getByText('普通权限')).toBeInTheDocument()
  })

  it('选中某模板触发 onInitialize 传该模板对象', () => {
    const handler = vi.fn()
    render(<TemplateInitButton templates={fakeTemplates} onInitialize={handler} />)
    fireEvent.click(screen.getByRole('button', { name: /用模板初始化/ }))
    fireEvent.click(screen.getByText('群聊排程'))
    expect(handler.mock.calls[0][0]).toEqual(fakeTemplates[0])
  })
})
