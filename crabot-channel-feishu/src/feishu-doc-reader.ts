import type { FeishuClient } from './feishu-client.js'
import type { FeishuDocRef } from './feishu-url.js'

export interface DocReadResult {
  type: 'docx' | 'wiki' | 'sheets'
  title: string
  text: string
  truncated: boolean
  url: string
}

export interface DocMetaResult {
  type: 'docx' | 'wiki' | 'sheets'
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
      default: throw unsupportedError(`本期不支持读取此类型飞书文档（kind=${ref.kind}）`)
    }
  }

  async readMeta(ref: FeishuDocRef): Promise<DocMetaResult> {
    switch (ref.kind) {
      case 'docx': {
        const { title } = await this.client.getDocxMeta(ref.token)
        return { type: 'docx', title }
      }
      case 'wiki': {
        const node = await this.client.getWikiNode(ref.token)
        if (node.obj_type !== 'docx') return { type: 'wiki', title: '' }
        const { title } = await this.client.getDocxMeta(node.obj_token)
        return { type: 'wiki', title }
      }
      case 'sheets': {
        const { title } = await this.client.getSheetMeta(ref.token)
        return { type: 'sheets', title }
      }
      default: throw unsupportedError(`本期不支持读取此类型飞书文档（kind=${ref.kind}）`)
    }
  }

  private async readDocxFull(
    documentId: string,
    maxChars: number,
    resultType: 'docx' | 'wiki',
  ): Promise<DocReadResult> {
    const [rawText, meta] = await Promise.all([
      this.client.getDocxRawContent(documentId),
      this.client.getDocxMeta(documentId),
    ])
    const truncated = rawText.length > maxChars
    // url 由 RPC 调用方填充，reader 层不持有原始 URL
    return {
      type: resultType,
      title: meta.title,
      text: truncated ? rawText.slice(0, maxChars) : rawText,
      truncated,
      url: '',
    }
  }

  private async readWikiFull(token: string, maxChars: number): Promise<DocReadResult> {
    const node = await this.client.getWikiNode(token)
    if (node.obj_type !== 'docx') {
      throw unsupportedError(`本期 wiki 节点只支持读取 docx 类型，当前节点类型为 ${node.obj_type}`)
    }
    return this.readDocxFull(node.obj_token, maxChars, 'wiki')
  }

  private async readSheetsFull(spreadsheetToken: string, maxChars: number): Promise<DocReadResult> {
    const meta = await this.client.getSheetMeta(spreadsheetToken)
    if (meta.sheets.length === 0) {
      // url 由 RPC 调用方填充，reader 层不持有原始 URL
      return { type: 'sheets', title: meta.title, text: '（表格为空）', truncated: false, url: '' }
    }
    const firstSheet = meta.sheets[0]
    const values = await this.client.getSheetValues(spreadsheetToken, `${firstSheet.sheet_id}!A1:Z1000`)
    const text = values.map(row => (row as unknown[]).join('\t')).join('\n')
    const truncated = text.length > maxChars
    // url 由 RPC 调用方填充，reader 层不持有原始 URL
    return {
      type: 'sheets',
      title: meta.title,
      text: truncated ? text.slice(0, maxChars) : text,
      truncated,
      url: '',
    }
  }
}
