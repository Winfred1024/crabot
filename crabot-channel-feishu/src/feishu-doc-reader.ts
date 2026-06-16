import type { FeishuClient } from './feishu-client.js'
import type { FeishuDocRef } from './feishu-url.js'

export interface DocReadResult {
  type: 'docx' | 'wiki' | 'sheets' | 'file'
  title: string
  text?: string
  truncated?: boolean
  file_token?: string
  filename?: string
  url: string
}

export interface DocMetaResult {
  type: 'docx' | 'wiki' | 'sheets' | 'file'
  title: string
}

const DEFAULT_MAX_CHARS = 50_000

function unsupportedError(msg: string): Error {
  return Object.assign(new Error(msg), { code: 'UNSUPPORTED' })
}

export class FeishuDocReader {
  constructor(private readonly client: FeishuClient) {}

  async read(ref: FeishuDocRef, opts?: { maxChars?: number }): Promise<DocReadResult> {
    const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS
    switch (ref.kind) {
      case 'docx': return this.readDocxFull(ref.token, maxChars, 'docx')
      case 'wiki': return this.readWikiFull(ref.token, maxChars)
      case 'sheets': return this.readSheetsFull(ref.token, maxChars)
      case 'file': return this.readFile(ref.token)
      default: throw unsupportedError(`本期不支持读取此类型飞书文档（kind=${ref.kind}）`)
    }
  }

  async readMeta(ref: FeishuDocRef): Promise<DocMetaResult> {
    switch (ref.kind) {
      case 'docx': {
        const data = await this.client.rawGet<{ document?: { title?: string } }>(
          `/open-apis/docx/v1/documents/${ref.token}`)
        return { type: 'docx', title: data.document?.title ?? '' }
      }
      case 'wiki': {
        const node = await this.resolveWikiNode(ref.token)
        if (node.obj_type === 'file') return { type: 'file', title: node.title }
        if (node.obj_type !== 'docx') return { type: 'wiki', title: '' }
        const data = await this.client.rawGet<{ document?: { title?: string } }>(
          `/open-apis/docx/v1/documents/${node.obj_token}`)
        return { type: 'wiki', title: data.document?.title ?? '' }
      }
      case 'sheets': {
        const data = await this.client.rawGet<{ sheets?: Array<{ sheet_id?: string; title?: string }> }>(
          `/open-apis/sheets/v3/spreadsheets/${ref.token}/sheets/query`)
        const title = data.sheets?.[0]?.title ?? ''
        return { type: 'sheets', title }
      }
      case 'file': return { type: 'file', title: '' }
      default: throw unsupportedError(`本期不支持读取此类型飞书文档（kind=${ref.kind}）`)
    }
  }

  private async readDocxFull(
    documentId: string,
    maxChars: number,
    resultType: 'docx' | 'wiki',
  ): Promise<DocReadResult> {
    const [raw, meta] = await Promise.all([
      this.client.rawGet<{ content?: string }>(`/open-apis/docx/v1/documents/${documentId}/raw_content`, { lang: 0 }),
      this.client.rawGet<{ document?: { title?: string } }>(`/open-apis/docx/v1/documents/${documentId}`),
    ])
    const rawText = raw.content ?? ''
    const truncated = rawText.length > maxChars
    // url 由 RPC 调用方填充，reader 层不持有原始 URL
    return {
      type: resultType,
      title: meta.document?.title ?? '',
      text: truncated ? rawText.slice(0, maxChars) : rawText,
      truncated,
      url: '',
    }
  }

  private async readWikiFull(token: string, maxChars: number): Promise<DocReadResult> {
    const node = await this.resolveWikiNode(token)
    if (node.obj_type === 'docx') return this.readDocxFull(node.obj_token, maxChars, 'wiki')
    if (node.obj_type === 'file') return this.readFile(node.obj_token, node.title)
    throw unsupportedError(`wiki 节点类型 ${node.obj_type} 暂无专用解析，可用 feishu_get 原生读取`)
  }

  private async resolveWikiNode(token: string): Promise<{ obj_token: string; obj_type: string; title: string }> {
    const data = await this.client.rawGet<{ node?: { obj_token?: string; obj_type?: string; title?: string } }>(
      `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}&obj_type=wiki`)
    return { obj_token: data.node?.obj_token ?? '', obj_type: data.node?.obj_type ?? '', title: data.node?.title ?? '' }
  }

  /** file 节点：只产 descriptor（file_token + 可选文件名），不在读时下载。size/MIME 由下载时响应头给。 */
  private readFile(fileToken: string, title = ''): DocReadResult {
    return {
      type: 'file', title, file_token: fileToken, url: '',
      ...(title ? { filename: title } : {}),
    }
  }

  private async readSheetsFull(spreadsheetToken: string, maxChars: number): Promise<DocReadResult> {
    const metaData = await this.client.rawGet<{ sheets?: Array<{ sheet_id?: string; title?: string }> }>(
      `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`)
    const sheets = (metaData.sheets ?? []).map(s => ({ sheet_id: s.sheet_id ?? '', title: s.title ?? '' }))
    const title = sheets[0]?.title ?? ''
    if (sheets.length === 0) {
      // url 由 RPC 调用方填充，reader 层不持有原始 URL
      return { type: 'sheets', title, text: '（表格为空）', truncated: false, url: '' }
    }
    const valuesData = await this.client.rawGet<{ valueRange?: { values?: unknown[][] } }>(
      `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(`${sheets[0].sheet_id}!A1:Z1000`)}?valueRenderOption=ToString`)
    const text = (valuesData.valueRange?.values ?? []).map(row => (row as unknown[]).join('\t')).join('\n')
    const truncated = text.length > maxChars
    // url 由 RPC 调用方填充，reader 层不持有原始 URL
    return {
      type: 'sheets',
      title,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      url: '',
    }
  }
}
