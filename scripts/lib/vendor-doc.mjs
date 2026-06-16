/**
 * vendor.yaml 文档的纯数据变换。全部 immutable（返回新 doc，不改入参）。
 * 真正的供应商目录校验在 crabot-admin/src/vendor-registry.ts 兜底；
 * 这里只做 CLI 向导用得到的轻量约束。
 */

// 四种格式都可自定义；受限的是 auth_type=oauth（固定流程），由 admin 侧 vendor-registry 兜底拒绝。
const VALID_FORMATS = ['openai', 'anthropic', 'gemini', 'openai-responses']

/** 追加一个 vendor；id 重复抛错。 */
export function addVendor(doc, entry) {
  const vendors = doc.vendors ?? []
  if (vendors.some(v => v.id === entry.id)) {
    throw new Error(`vendor id 已存在: ${entry.id}`)
  }
  return { ...doc, vendors: [...vendors, entry] }
}

/** 按 id 删除 vendor；不存在则无副作用。 */
export function removeVendor(doc, id) {
  const vendors = doc.vendors ?? []
  return { ...doc, vendors: vendors.filter(v => v.id !== id) }
}

/** 设置顶层 mode；非法值抛错。 */
export function setMode(doc, mode) {
  if (mode !== 'merge' && mode !== 'replace') {
    throw new Error(`非法 mode: ${mode}（仅支持 merge | replace）`)
  }
  return { ...doc, mode }
}

/** 校验单条 vendor，返回错误信息数组（空 = 合法）。 */
export function validateEntry(entry) {
  const errors = []
  if (!entry.id) errors.push('id 不能为空')
  if (!entry.name) errors.push('name 不能为空')
  if (!entry.endpoint) errors.push('endpoint 不能为空')
  if (!VALID_FORMATS.includes(entry.format)) {
    errors.push(`format 非法（仅支持 ${VALID_FORMATS.join(' / ')}）`)
  }
  return errors
}
