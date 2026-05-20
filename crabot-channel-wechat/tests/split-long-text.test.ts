import { describe, it, expect } from 'vitest'
import { splitLongText } from '../src/split-long-text.js'

describe('splitLongText', () => {
  it('短文本不拆', () => {
    expect(splitLongText('hello', 100)).toEqual(['hello'])
  })

  it('恰好等于阈值不拆', () => {
    const s = 'a'.repeat(100)
    expect(splitLongText(s, 100)).toEqual([s])
  })

  it('按段落 \\n\\n 切，每段独立超阈值时单段一发', () => {
    // 每段 5 字符 + 单段 + 阈值刚好 5 → greedy 加上 \n\n 必然超阈值 → 每段独立
    const t = ['第一段内容', '第二段内容', '第三段内容'].join('\n\n')
    const out = splitLongText(t, 5)
    expect(out).toEqual(['第一段内容', '第二段内容', '第三段内容'])
  })

  it('多个短段落可聚合到同一段（不超阈值）', () => {
    const t = 'AAA\n\nBBB\n\nCCC'
    const out = splitLongText(t, 8)
    expect(out).toEqual(['AAA\n\nBBB', 'CCC'])
  })

  it('单段超过阈值时按行 \\n 切', () => {
    const t = ['行一', '行二', '行三', '行四'].join('\n')
    const out = splitLongText(t, 5)
    expect(out).toEqual(['行一\n行二', '行三\n行四'])
  })

  it('单行超过阈值按句末符号切', () => {
    const t = '第一句话。第二句话。第三句话。'
    const out = splitLongText(t, 6)
    expect(out).toEqual(['第一句话。', '第二句话。', '第三句话。'])
  })

  it('没有可切边界时硬切', () => {
    const t = 'abcdefghij'
    expect(splitLongText(t, 3)).toEqual(['abc', 'def', 'ghi', 'j'])
  })

  it('段落间多个空行折叠不产生空段（走 split 流程）', () => {
    // 阈值 3 强制走 split：'A\n\n\n\nB' 拆为 paragraphs=['A','B']，greedy 各成一段
    const t = 'A\n\n\n\nB'
    const out = splitLongText(t, 3)
    expect(out).toEqual(['A', 'B'])
  })

  it('保留段间顺序', () => {
    const longPara = 'X'.repeat(50)
    const t = `START\n\n${longPara}\n\nEND`
    const out = splitLongText(t, 20)
    expect(out[0]).toBe('START')
    expect(out[out.length - 1]).toBe('END')
    expect(out.join('')).toContain(longPara)
  })

  it('maxLen 必须为正', () => {
    expect(() => splitLongText('x', 0)).toThrow()
    expect(() => splitLongText('x', -1)).toThrow()
  })
})
