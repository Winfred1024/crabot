/**
 * 按 name 合并两组实体。
 *  - root 同名实体整条覆盖用户的
 *  - 用户独有实体保留
 *  - root 独有实体加入
 *  - 顺序：先 root 全部，再用户独有的追加
 */
export function mergeByName(rootList, userList, { key = 'name' } = {}) {
  const rootKeys = new Set(rootList.map(e => e[key]))
  const userOnly = userList.filter(e => !rootKeys.has(e[key]))
  return [...rootList, ...userOnly]
}

/**
 * 合并一份 "{ 容器键: 列表 }" 形态的 kind 文档（provider/agent/vendor）。
 *  - 容器键 = 值为数组的第一个顶层键（兼容 providers / model_slots / vendors）；
 *    都不是数组时退回第一个键。
 *  - 列表按 key 走 mergeByName（root 同 key 覆盖、用户独有保留、root 新增追加）。
 *  - 其余非数组顶层标量键（如 vendor 的 mode）透传：root 优先，否则取 user。
 */
export function mergeKindDoc(rootDoc, userDoc = {}, { key = 'name' } = {}) {
  const topKey =
    Object.keys(rootDoc).find(k => Array.isArray(rootDoc[k])) ?? Object.keys(rootDoc)[0]
  const rootList = rootDoc[topKey] ?? []
  const userList = (userDoc && userDoc[topKey]) ?? []
  const out = { [topKey]: mergeByName(rootList, userList, { key }) }
  // 标量透传：先放 user，再用 root 覆盖 → root 优先
  for (const doc of [userDoc ?? {}, rootDoc]) {
    for (const [k, val] of Object.entries(doc)) {
      if (k === topKey || Array.isArray(val)) continue
      out[k] = val
    }
  }
  return out
}
