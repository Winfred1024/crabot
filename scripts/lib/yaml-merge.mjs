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
