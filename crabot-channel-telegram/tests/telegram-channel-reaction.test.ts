/**
 * Telegram add_reaction：TelegramClient.setMessageReaction + TelegramChannel.handleAddReaction
 *
 * Spec: 2026-06-04-channel-task-pickup-reaction-design.md §3
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { TelegramClient } from '../src/telegram-client'
// import { TelegramChannel } from '../src/telegram-channel'

describe('TelegramClient.setMessageReaction', () => {
  let fetchSpy: ReturnType<typeof vi.fn<any[], any>>
  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: true }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POST /setMessageReaction，body 含 reaction=[{type:"emoji", emoji}]', async () => {
    const client = new TelegramClient('TKN')
    await client.setMessageReaction(12345, 678, '👀')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.telegram.org/botTKN/setMessageReaction')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      chat_id: 12345,
      message_id: 678,
      reaction: [{ type: 'emoji', emoji: '👀' }],
    })
  })
})
