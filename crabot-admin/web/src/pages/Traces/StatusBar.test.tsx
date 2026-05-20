import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { StatusBar } from './StatusBar'
import { traceService } from '../../services/trace'

vi.mock('../../services/trace')

describe('StatusBar', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('renders disk usage and trace count', async () => {
    ;(traceService.getDiskUsage as ReturnType<typeof vi.fn>).mockResolvedValue({
      total_bytes: 24_500_000,
      trace_count: 1234,
      oldest_iso: '2026-04-21T14:32:00Z',
    })
    render(<StatusBar onOpenManualCleanup={vi.fn()} onOpenAutoCleanupSettings={vi.fn()} />)
    expect(await screen.findByText(/23\.4 MB/)).toBeInTheDocument()
    expect(screen.getByText(/1,234/)).toBeInTheDocument()
  })

  it('clicking 手动清理 triggers handler', async () => {
    ;(traceService.getDiskUsage as ReturnType<typeof vi.fn>).mockResolvedValue({ total_bytes: 0, trace_count: 0 })
    const onOpen = vi.fn()
    render(<StatusBar onOpenManualCleanup={onOpen} onOpenAutoCleanupSettings={vi.fn()} />)
    await screen.findByText(/0 B/)
    fireEvent.click(screen.getByText('手动清理'))
    expect(onOpen).toHaveBeenCalled()
  })

  it('clicking 自动清理设置 triggers handler', async () => {
    ;(traceService.getDiskUsage as ReturnType<typeof vi.fn>).mockResolvedValue({ total_bytes: 0, trace_count: 0 })
    const onOpen = vi.fn()
    render(<StatusBar onOpenManualCleanup={vi.fn()} onOpenAutoCleanupSettings={onOpen} />)
    await screen.findByText(/0 B/)
    fireEvent.click(screen.getByText('自动清理设置'))
    expect(onOpen).toHaveBeenCalled()
  })
})
