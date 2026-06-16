import { buildScopeGrantUrl } from './onboard.js'

type Brand = 'feishu' | 'lark'

export interface FeishuRemediation {
  message: string
  grant_url: string
  steps: string[]
  alternatives: string[]
}

const WRITE_SCOPE_BY_PREFIX: Array<[string, string]> = [
  ['/open-apis/docx/', 'docx:document'],
  ['/open-apis/sheets/', 'sheets:spreadsheet'],
  ['/open-apis/drive/', 'drive:drive'],
  ['/open-apis/wiki/', 'wiki:wiki'],
  ['/open-apis/bitable/', 'bitable:app'],
]

/** 按 path 前缀映射飞书写 scope；未命中返回 undefined。 */
export function writeScopeForPath(path: string): string | undefined {
  return WRITE_SCOPE_BY_PREFIX.find(([p]) => path.startsWith(p))?.[1]
}

/** 把「飞书权限不足」翻译成人类可读、可操作的引导。agent 可直接转述。 */
export function buildFeishuRemediation(opts: {
  appId: string
  domain: Brand
  missingScope: string
  intent?: 'read' | 'write'
}): FeishuRemediation {
  const grant_url = buildScopeGrantUrl(opts.appId, opts.domain, [opts.missingScope])
  const isWrite = opts.intent === 'write'
  return {
    message: isWrite
      ? `我没有修改这个内容所需的飞书权限（缺 ${opts.missingScope}）。点下面的链接给应用开通就能解决。`
      : `我没有读取这个内容所需的飞书权限（缺 ${opts.missingScope}）。点下面的链接给应用开通就能解决。`,
    grant_url,
    steps: [
      '点授权链接，在飞书开发者后台批准该权限',
      '批准后进入「应用发布 → 版本管理与发布」创建版本并提交，权限才生效',
      '确保把本应用（或应用所在群）加为该文档/文件夹/知识空间的协作者',
    ],
    alternatives: isWrite
      ? ['或让有这个文档权限的人在飞书里直接改']
      : ['或把这个「文件」转成飞书在线 docx 文档后再发链接', '或直接把正文/关键内容贴到群里'],
  }
}
