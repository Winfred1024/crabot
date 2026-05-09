import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SceneProfileList } from './SceneProfileList'

const listSceneProfiles = vi.fn()
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
      ...actual.sceneProfileService,
      list: (...args: unknown[]) => listSceneProfiles(...args),
    },
  }
})

function renderSceneProfileList() {
  return render(
    <MemoryRouter>
      <SceneProfileList />
    </MemoryRouter>,
  )
}

describe('SceneProfileList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows scene profile content snippets and removes section counts from list rows', async () => {
    listSceneProfiles.mockResolvedValue({
      profiles: [
        {
          scene: { type: 'friend', friend_id: 'friend-1' },
          label: 'Alice',
          content: '回复时先确认需求背景，再同步预计交付时间。',
          source_memory_ids: ['mem-1'],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-20T00:00:00.000Z',
          last_declared_at: '2026-04-20T08:00:00.000Z',
        },
      ],
    })

    renderSceneProfileList()

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('回复时先确认需求背景，再同步预计交付时间。')).toBeInTheDocument()
    expect(screen.queryByText(/Section 数/u)).not.toBeInTheDocument()
  })

  it('shows governance status tags derived from existing profile data', async () => {
    listSceneProfiles.mockResolvedValue({
      profiles: [
        {
          scene: { type: 'friend', friend_id: 'friend-1' },
          label: 'Alice',
          content: '',
          source_memory_ids: [],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: new Date().toISOString(),
          last_declared_at: null,
        },
      ],
    })

    renderSceneProfileList()

    expect(await screen.findByText('缺描述')).toBeInTheDocument()
    expect(screen.getByText('无来源')).toBeInTheDocument()
  })

  it('filters the list by quality state without another backend field', async () => {
    listSceneProfiles.mockResolvedValue({
      profiles: [
        {
          scene: { type: 'friend', friend_id: 'friend-1' },
          label: 'Alice',
          content: '',
          source_memory_ids: ['mem-1'],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-20T00:00:00.000Z',
          last_declared_at: null,
        },
        {
          scene: { type: 'friend', friend_id: 'friend-2' },
          label: 'Bob',
          content: '完整画像',
          source_memory_ids: ['mem-2'],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-20T00:00:00.000Z',
          last_declared_at: null,
        },
      ],
    })

    renderSceneProfileList()

    await screen.findByText('Alice')
    fireEvent.change(screen.getByLabelText('治理筛选'), { target: { value: 'missing-content' } })

    expect(screen.getByText('Alice')).toBeInTheDocument()
    expect(screen.queryByText('Bob')).not.toBeInTheDocument()
    expect(screen.getByText('缺描述')).toBeInTheDocument()
  })
})
