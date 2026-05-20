import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ManualCleanupDialog, AutoCleanupSettingsDialog } from './CleanupDialogs'
import { traceService } from '../../services/trace'
import { providerService } from '../../services/provider'
import { ToastProvider } from '../../contexts/ToastContext'

vi.mock('../../services/trace')
vi.mock('../../services/provider')

describe('ManualCleanupDialog', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('预览 → 显示影响数', async () => {
    ;(traceService.cleanupOld as ReturnType<typeof vi.fn>).mockResolvedValue({
      affected_count: 156, affected_bytes: 4_400_000, deleted_trace_ids: [],
    })
    render(<ToastProvider><ManualCleanupDialog open onClose={vi.fn()} onDeleted={vi.fn()} /></ToastProvider>)
    const dayInput = screen.getByLabelText(/天前/) as HTMLInputElement
    fireEvent.change(dayInput, { target: { value: '30' } })
    fireEvent.click(screen.getByText('预览'))
    await waitFor(() => {
      expect(screen.getByText(/156 条 trace/)).toBeInTheDocument()
    })
    expect(traceService.cleanupOld).toHaveBeenCalledWith(30, true)
  })

  it('确认删除 → 调 dry_run=false', async () => {
    ;(traceService.cleanupOld as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ affected_count: 5, affected_bytes: 1024, deleted_trace_ids: [] })
      .mockResolvedValueOnce({ affected_count: 5, affected_bytes: 1024, deleted_trace_ids: ['t1','t2','t3','t4','t5'] })
    const onDeleted = vi.fn()
    render(<ToastProvider><ManualCleanupDialog open onClose={vi.fn()} onDeleted={onDeleted} /></ToastProvider>)
    fireEvent.change(screen.getByLabelText(/天前/), { target: { value: '30' } })
    fireEvent.click(screen.getByText('预览'))
    await waitFor(() => screen.getByText(/5 条 trace/))
    fireEvent.click(screen.getByText('确认删除'))
    await waitFor(() => {
      expect(traceService.cleanupOld).toHaveBeenLastCalledWith(30, false)
      expect(onDeleted).toHaveBeenCalled()
    })
  })
})

describe('AutoCleanupSettingsDialog', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('toggle off 时保存 trace_retention_days: null', async () => {
    ;(providerService.getGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ trace_retention_days: 30 })
    ;(providerService.updateGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({})
    render(<ToastProvider><AutoCleanupSettingsDialog open onClose={vi.fn()} /></ToastProvider>)
    await waitFor(() => screen.getByLabelText(/启用自动清理/))
    fireEvent.click(screen.getByLabelText(/启用自动清理/))  // 关
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(providerService.updateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ trace_retention_days: null })
      )
    })
  })

  it('toggle on + 输入 retention 7 → 保存', async () => {
    ;(providerService.getGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({ trace_retention_days: null })
    ;(providerService.updateGlobalConfig as ReturnType<typeof vi.fn>).mockResolvedValue({})
    render(<ToastProvider><AutoCleanupSettingsDialog open onClose={vi.fn()} /></ToastProvider>)
    await waitFor(() => screen.getByLabelText(/启用自动清理/))
    fireEvent.click(screen.getByLabelText(/启用自动清理/))
    fireEvent.change(screen.getByLabelText(/保留最近/), { target: { value: '7' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => {
      expect(providerService.updateGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({ trace_retention_days: 7 })
      )
    })
  })
})
