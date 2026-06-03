import React from 'react'
import { Button } from '../../components/Common/Button'

export interface EventSubscriptionCardProps {
  /** 卡片标题文案（caller 决定平台特定措辞，如「去飞书后台订阅事件」） */
  title: string
  /** 标题下方说明文字 */
  description: string
  /** 跳转按钮文案 */
  buttonLabel: string
  /** 平台事件订阅页直链 */
  url: string
  events: ReadonlyArray<{ name: string; identifier: string }>
  extraInstructions?: ReadonlyArray<string>
}

export const EventSubscriptionCard: React.FC<EventSubscriptionCardProps> = ({
  title,
  description,
  buttonLabel,
  url,
  events,
  extraInstructions,
}) => {
  return (
    <div
      style={{
        marginTop: '1rem',
        padding: '0.875rem 1rem',
        background: 'rgba(245, 158, 11, 0.08)',
        border: '1px solid rgba(245, 158, 11, 0.4)',
        borderRadius: 6,
      }}
    >
      <p style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-primary)' }}>
        {title}
      </p>
      <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.375rem', lineHeight: 1.55 }}>
        {description}
      </p>

      <table
        style={{
          width: '100%',
          marginTop: '0.625rem',
          fontSize: '0.75rem',
          borderCollapse: 'collapse',
        }}
      >
        <tbody>
          {events.map((e) => (
            <tr key={e.identifier} style={{ borderTop: '1px solid rgba(245, 158, 11, 0.2)' }}>
              <td style={{ padding: '0.25rem 0.5rem 0.25rem 0', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                {e.name}
              </td>
              <td
                style={{
                  padding: '0.25rem 0',
                  color: 'var(--text-muted)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '0.7rem',
                }}
              >
                {e.identifier}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: '0.75rem' }}>
        <Button
          variant="secondary"
          onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
        >
          {buttonLabel}
        </Button>
      </div>
      <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.5rem', wordBreak: 'break-all' }}>
        {url}
      </p>

      {extraInstructions && extraInstructions.length > 0 && (
        <div style={{ marginTop: '0.625rem' }}>
          {extraInstructions.map((tip, i) => (
            <p
              key={i}
              style={{
                fontSize: '0.7rem',
                color: 'var(--text-secondary)',
                marginTop: i === 0 ? 0 : '0.25rem',
                lineHeight: 1.55,
              }}
            >
              ⓘ {tip}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
