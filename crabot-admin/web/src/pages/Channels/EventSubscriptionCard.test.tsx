import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EventSubscriptionCard } from './EventSubscriptionCard'

const sampleEvents = [
  { name: '接收消息',   identifier: 'im.message.receive_v1' },
  { name: '用户进群',   identifier: 'im.chat.member.user.added_v1' },
  { name: '群信息修改', identifier: 'im.chat.updated_v1' },
]

describe('EventSubscriptionCard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openSpy: any

  beforeEach(() => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    openSpy.mockRestore()
  })

  it('renders all events with Chinese name + identifier', () => {
    render(
      <EventSubscriptionCard
        url="https://open.feishu.cn/app/cli_x/event"
        events={sampleEvents}
      />,
    )
    for (const e of sampleEvents) {
      expect(screen.getByText(e.name)).toBeTruthy()
      expect(screen.getByText(e.identifier)).toBeTruthy()
    }
  })

  it('opens url in new tab when button clicked', () => {
    render(
      <EventSubscriptionCard
        url="https://open.feishu.cn/app/cli_x/event"
        events={sampleEvents}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /打开飞书事件订阅页/ }))
    expect(openSpy).toHaveBeenCalledWith(
      'https://open.feishu.cn/app/cli_x/event',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('renders extra_instructions in order', () => {
    render(
      <EventSubscriptionCard
        url="https://x"
        events={sampleEvents}
        extraInstructions={['第一条提示', '第二条提示', '第三条提示']}
      />,
    )
    expect(screen.getByText(/第一条提示/)).toBeTruthy()
    expect(screen.getByText(/第二条提示/)).toBeTruthy()
    expect(screen.getByText(/第三条提示/)).toBeTruthy()
  })

  it('does not render instruction section when extraInstructions absent', () => {
    render(<EventSubscriptionCard url="https://x" events={sampleEvents} />)
    expect(screen.queryByText(/必须发版/)).toBeNull()
  })
})
