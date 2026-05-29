export type FeishuDocKind = 'docx' | 'wiki' | 'sheets' | 'unknown'
export interface FeishuDocRef { kind: FeishuDocKind; token: string }

const FEISHU_HOST_RE = /(?:^|\.)(?:feishu\.cn|larksuite\.com)$/

export function parseFeishuDocUrl(raw: string): FeishuDocRef | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (!FEISHU_HOST_RE.test(u.hostname)) return null
  const segs = u.pathname.split('/').filter(Boolean)
  const typeIdx = segs.findIndex(s => s === 'docx' || s === 'wiki' || s === 'sheets')
  if (typeIdx === -1) return { kind: 'unknown', token: '' }
  const kind = segs[typeIdx] as FeishuDocKind
  const token = segs[typeIdx + 1] ?? ''
  if (!token) return { kind: 'unknown', token: '' }
  return { kind, token }
}

const URL_RE = /https?:\/\/[^\s<>"']+/g

export function extractFeishuDocUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).filter(u => {
    const ref = parseFeishuDocUrl(u)
    return ref !== null && ref.kind !== 'unknown'
  })
}
