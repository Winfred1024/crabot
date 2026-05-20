/**
 * 长文本分段——用于 wechat-channel 主动控制顺序
 *
 * 背景：channel-wechat 一次 POST 一整段长文本给 wechat-connector 后，下游
 * 可能自行拆分并异步推到 MQTT/Puppet，Puppet 并发处理导致接收方看到的顺序乱。
 * 把拆分逻辑前置到这里 + 串行发送 + 段间小间隔，让发送顺序由我们这层掌控。
 *
 * 策略：先按段落 \n\n 拼，单段超阈值再按行 \n 拼，再按中文/英文句末符号切，最后硬切。
 */

const SENTENCE_BREAK_REGEX = /([。．！？!?；;])/

export function splitLongText(text: string, maxLen: number): string[] {
  if (maxLen <= 0) throw new Error(`maxLen must be > 0, got ${maxLen}`)
  if (text.length <= maxLen) return [text]

  const paragraphs = text.split(/\n\n+/)
  const segments: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.length > 0) {
      segments.push(current)
      current = ''
    }
  }

  for (const para of paragraphs) {
    if (para.length === 0) continue

    if (para.length > maxLen) {
      flush()
      for (const piece of splitOversizedParagraph(para, maxLen)) {
        segments.push(piece)
      }
      continue
    }

    const joiner = current.length === 0 ? '' : '\n\n'
    if (current.length + joiner.length + para.length > maxLen) {
      flush()
      current = para
    } else {
      current = current + joiner + para
    }
  }
  flush()

  return segments
}

function splitOversizedParagraph(para: string, maxLen: number): string[] {
  const lines = para.split('\n')
  const out: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.length > 0) {
      out.push(current)
      current = ''
    }
  }

  for (const line of lines) {
    if (line.length > maxLen) {
      flush()
      for (const piece of splitOversizedLine(line, maxLen)) {
        out.push(piece)
      }
      continue
    }

    const joiner = current.length === 0 ? '' : '\n'
    if (current.length + joiner.length + line.length > maxLen) {
      flush()
      current = line
    } else {
      current = current + joiner + line
    }
  }
  flush()

  return out
}

function splitOversizedLine(line: string, maxLen: number): string[] {
  const parts = line.split(SENTENCE_BREAK_REGEX)
  const sentences: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    const body = parts[i] ?? ''
    const punct = parts[i + 1] ?? ''
    const merged = body + punct
    if (merged.length > 0) sentences.push(merged)
  }

  const out: string[] = []
  let current = ''

  const flush = (): void => {
    if (current.length > 0) {
      out.push(current)
      current = ''
    }
  }

  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      flush()
      for (const piece of hardSplit(sentence, maxLen)) {
        out.push(piece)
      }
      continue
    }
    if (current.length + sentence.length > maxLen) {
      flush()
      current = sentence
    } else {
      current = current + sentence
    }
  }
  flush()

  return out
}

function hardSplit(s: string, maxLen: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += maxLen) {
    out.push(s.slice(i, i + maxLen))
  }
  return out
}
