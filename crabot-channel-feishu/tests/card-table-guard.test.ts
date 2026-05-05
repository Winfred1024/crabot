import { describe, it, expect } from 'vitest'
import { splitTextByTableLimit } from '../src/card-table-guard'

const tableBlock = (header: string) =>
  `| ${header} | x |\n|---|---|\n| a | 1 |\n| b | 2 |`

describe('splitTextByTableLimit', () => {
  it('returns text unchanged when there are no markdown tables', () => {
    expect(splitTextByTableLimit('hello world')).toEqual(['hello world'])
  })

  it('returns text unchanged when table count is at the limit', () => {
    const text = Array.from({ length: 5 }, (_, i) => tableBlock(`H${i}`)).join('\n\n')
    expect(splitTextByTableLimit(text)).toEqual([text])
  })

  it('splits text when table count exceeds the 5-table limit', () => {
    const text = Array.from({ length: 6 }, (_, i) => tableBlock(`H${i}`)).join('\n\n')
    const chunks = splitTextByTableLimit(text)
    expect(chunks.length).toBe(2)
    const tableCount = (s: string) => (s.match(/^\|[-:| ]+\|$/gm) ?? []).length
    expect(chunks.every(c => tableCount(c) <= 5)).toBe(true)
    expect(chunks.reduce((n, c) => n + tableCount(c), 0)).toBe(6)
  })

  it('keeps narrative paragraphs alongside their nearby tables', () => {
    const text = [
      '简介段落，前奏文字。',
      tableBlock('A'),
      tableBlock('B'),
      tableBlock('C'),
      tableBlock('D'),
      tableBlock('E'),
      '中间小结。',
      tableBlock('F'),
      '结尾说明。',
    ].join('\n\n')
    const chunks = splitTextByTableLimit(text)
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain('简介段落')
    expect(chunks[1]).toContain('结尾说明')
  })

  it('handles 10-table report (real-world repro of bug)', () => {
    const text = Array.from({ length: 10 }, (_, i) => `## 段 ${i}\n\n${tableBlock(`H${i}`)}`).join('\n\n')
    const chunks = splitTextByTableLimit(text)
    const tableCount = (s: string) => (s.match(/^\|[-:| ]+\|$/gm) ?? []).length
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.every(c => tableCount(c) <= 5)).toBe(true)
    expect(chunks.reduce((n, c) => n + tableCount(c), 0)).toBe(10)
  })
})
