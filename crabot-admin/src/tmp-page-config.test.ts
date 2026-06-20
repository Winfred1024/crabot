import { describe, it, expect } from 'vitest'
import { resolveTmpPageBaseUrl } from './tmp-page-proxy'

describe('resolveTmpPageBaseUrl', () => {
  it('优先用 CRABOT_PUBLIC_BASE_URL', () => {
    expect(resolveTmpPageBaseUrl('https://x.example.com', 3000)).toBe('https://x.example.com')
  })
  it('去掉尾部斜杠', () => {
    expect(resolveTmpPageBaseUrl('https://x.example.com/', 3000)).toBe('https://x.example.com')
  })
  it('未配置时退化为本地 web 地址', () => {
    expect(resolveTmpPageBaseUrl(undefined, 3000)).toBe('http://localhost:3000')
  })
})
