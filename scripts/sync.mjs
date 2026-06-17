#!/usr/bin/env node

// crabot sync —— 已退役（no-op）。
//
// 历史：sync 曾把 root 的 /etc/crabot/defaults/{provider,agent}.yaml 合并下发到员工
// <DATA_DIR>/admin/，但这两份文件从未被任何代码消费（孤儿），sync 实际什么也没生效。
// 唯一真实的 root→员工下发是供应商目录 vendor.yaml，现已改为 admin 在 system mode
// 直读 /etc/crabot/defaults/vendor.yaml（见 crabot-admin/src/vendor-registry.ts），无需 sync。
//
// 保留本命令仅为兼容旧习惯/脚本，不再做任何事。

import './_preflight.mjs'

console.log('[sync] crabot sync 已退役：root 下发的供应商目录由 admin 直读 /etc/crabot/defaults/vendor.yaml，无需 sync。')
console.log('[sync] 修改后让对应员工重启 crabot（crabot stop && crabot start）即可生效。')
process.exit(0)
