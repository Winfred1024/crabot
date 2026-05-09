import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SceneProfileDetail } from './SceneProfileDetail'

const getSceneProfile = vi.fn()
const patchSceneProfile = vi.fn()
const deleteSceneProfile = vi.fn()
const getEntryV2 = vi.fn()
const toastMock = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}

vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => toastMock,
}))

vi.mock('../../services/memory', async () => {
  const actual = await vi.importActual<typeof import('../../services/memory')>('../../services/memory')
  return {
    ...actual,
    sceneProfileService: {
      list: vi.fn(),
      get: (...args: unknown[]) => getSceneProfile(...args),
      patch: (...args: unknown[]) => patchSceneProfile(...args),
      delete: (...args: unknown[]) => deleteSceneProfile(...args),
    },
  }
})

vi.mock('../../services/memoryV2', async () => {
  const actual = await vi.importActual<typeof import('../../services/memoryV2')>('../../services/memoryV2')
  return {
    ...actual,
    memoryV2Service: {
      ...actual.memoryV2Service,
      getEntry: (...args: unknown[]) => getEntryV2(...args),
    },
  }
})

function renderSceneProfileDetail(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/memory/scenes/:key" element={<SceneProfileDetail />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('SceneProfileDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getEntryV2.mockResolvedValue({
      id: 'mem-1',
      type: 'fact',
      status: 'confirmed',
      brief: '偏好 TypeScript',
      body: '完整内容',
    })
  })

  it('shows the description in view mode and saves edits without section ui', async () => {
    getSceneProfile.mockResolvedValue({
      profile: {
        scene: { type: 'friend', friend_id: 'friend-1' },
        label: 'Alice',
        content: '回复时先确认需求背景，再同步预计交付时间。',
        source_memory_ids: ['mem-1'],
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-20T00:00:00.000Z',
        last_declared_at: '2026-04-20T08:00:00.000Z',
      },
    })
    patchSceneProfile.mockResolvedValue({
      profile: {
        scene: { type: 'friend', friend_id: 'friend-1' },
        label: 'Alice（新版）',
        content: '升级后的描述',
        source_memory_ids: ['mem-1'],
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-20T01:00:00.000Z',
        last_declared_at: '2026-04-20T08:00:00.000Z',
      },
    })

    renderSceneProfileDetail('/memory/scenes/friend%3Afriend-1?context_label=Alice')

    expect(await screen.findAllByText('Alice')).not.toHaveLength(0)
    expect(screen.getByText('回复时先确认需求背景，再同步预计交付时间。')).toBeInTheDocument()
    expect(screen.queryByText(/Section 数/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新增分节' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '编辑画像' }))

    expect(screen.getByLabelText('标签（label）')).toHaveValue('Alice')
    expect(screen.getByLabelText('描述')).toHaveValue('回复时先确认需求背景，再同步预计交付时间。')
    expect(screen.queryByText(/Sections（/u)).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('分节主题')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('标签（label）'), { target: { value: 'Alice（新版）' } })
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '升级后的描述' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(patchSceneProfile).toHaveBeenCalledWith('friend:friend-1', {
        label: 'Alice（新版）',
        content: '升级后的描述',
      })
    })
  })

  it('shows description input when creating a new profile and does not expose section controls', async () => {
    getSceneProfile.mockResolvedValue({ profile: null })

    renderSceneProfileDetail('/memory/scenes/group%3Awechat-main%3Agroup-1?context_label=开发组群')

    expect(await screen.findByText('开发组群')).toBeInTheDocument()
    expect(screen.getByText('当前还没有场景画像。只有当这个场景存在长期稳定规则、身份约束或协作边界时，才建议创建。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新增分节' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '创建画像' }))

    expect(screen.getByLabelText('标签（label）')).toHaveValue('开发组群')
    expect(screen.getByLabelText('描述')).toHaveValue('')
    expect(screen.queryByText(/Sections（/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新增分节' })).not.toBeInTheDocument()
  })

  it('blocks save when description is blank', async () => {
    getSceneProfile.mockResolvedValue({ profile: null })

    renderSceneProfileDetail('/memory/scenes/group%3Awechat-main%3Agroup-2?context_label=空白测试群')

    expect(await screen.findByText('空白测试群')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '创建画像' }))
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建画像' }))

    expect(patchSceneProfile).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith('描述不能为空')
  })

  it('renders source memories as links when source ids exist', async () => {
    getSceneProfile.mockResolvedValue({
      profile: {
        scene: { type: 'friend', friend_id: 'friend-1' },
        label: 'Alice',
        content: '完整说明',
        source_memory_ids: ['mem-1'],
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-20T00:00:00.000Z',
      },
    })

    renderSceneProfileDetail('/memory/scenes/friend%3Afriend-1')

    expect(await screen.findByRole('link', { name: '偏好 TypeScript' })).toHaveAttribute(
      'href',
      '/memory/short-term?tab=long&mode=search&memory_id=mem-1',
    )
  })
})
