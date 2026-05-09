import React from 'react'

export type ProviderTestState = {
  status: 'pending' | 'success' | 'error'
  latency_ms?: number
  error?: string
}

interface ProviderTestBadgeProps {
  result?: ProviderTestState
  /** idle 状态渲染什么——按钮形态/事件由调用方自己决定 */
  idleButton: React.ReactNode
  /** 成功状态 hover tooltip，提示当前测速语义 */
  successTooltip?: string
  /** error 状态是否在 ✗ 旁边把错误文本拼出来；默认只显示 ✗ + title */
  showErrorText?: boolean
}

export const ProviderTestBadge: React.FC<ProviderTestBadgeProps> = ({
  result,
  idleButton,
  successTooltip,
  showErrorText,
}) => {
  if (!result) return <>{idleButton}</>

  if (result.status === 'pending') {
    return <span className="provider-test-result pending">测速中...</span>
  }

  if (result.status === 'success') {
    return (
      <span className="provider-test-result success" title={successTooltip}>
        ✓ {result.latency_ms}ms
      </span>
    )
  }

  return (
    <span className="provider-test-result error" title={result.error}>
      {showErrorText && result.error ? `✗ ${result.error}` : '✗'}
    </span>
  )
}
