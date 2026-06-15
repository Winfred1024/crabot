#!/usr/bin/env node
/**
 * 一次性清理：移除测试套件污染 live 数据的残留（2026-06-11）。
 *
 * 背景：admin 测试经默认 19000 MM 解析到开发机 live agent，把"测试消息"写进了
 * 真实聊天库 + 创建了真实任务。复发已由 vitest.setup.ts 死端口隔离堵死（commit 179e21c），
 * 本脚本清理存量。
 *
 * 必须在服务停止时运行（admin 内存持有数据，热改会被下次落库覆盖）。
 * 跑前自动备份到 <file>.bak-<ts>。
 */
import fs from 'node:fs'
import path from 'node:path'

const DATA = path.resolve(process.argv[2] ?? './data/admin')
const ts = new Date().toISOString().replace(/[:.]/g, '-')

const isTestMessage = (m) => {
  const rid = String(m.request_id ?? '')
  const c = m.content
  const txt = (c && typeof c === 'object' ? (c.text ?? '') : String(c ?? ''))
  return (
    rid.startsWith('test-') ||
    txt.trim() === '测试消息' ||
    txt.trim() === '收到，测试消息。' ||
    txt.includes('<tool_call name=') ||
    txt.includes('已创建任务：测试消息')
  )
}

const isTestTask = (t) => {
  if (String(t.title ?? '').trim() === '测试消息') return true
  for (const m of t.messages ?? []) {
    if (String(m.content ?? '').trim() === '测试消息') return true
  }
  return false
}

function clean(file, predicate, label) {
  const full = path.join(DATA, file)
  const raw = JSON.parse(fs.readFileSync(full, 'utf-8'))
  const isArray = Array.isArray(raw)
  const entries = isArray ? raw : Object.values(raw)
  const bad = entries.filter(predicate)
  const keep = entries.filter((e) => !predicate(e))

  fs.writeFileSync(`${full}.bak-${ts}`, JSON.stringify(raw, null, 2))

  let out
  if (isArray) {
    out = keep
  } else {
    // 保持原 keyed 结构（按 id / message_id / 第一个看起来像 id 的字段）
    const keyField = entries[0]?.id !== undefined ? 'id' : (entries[0]?.message_id !== undefined ? 'message_id' : null)
    out = {}
    for (const e of keep) out[keyField ? e[keyField] : Object.keys(raw)[entries.indexOf(e)]] = e
  }
  // 原子写
  const tmp = `${full}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2))
  fs.renameSync(tmp, full)

  console.log(`[${label}] 总 ${entries.length} → 删 ${bad.length} → 留 ${keep.length}（备份 ${file}.bak-${ts}）`)
}

console.log(`数据目录: ${DATA}`)
clean('chat_messages.json', isTestMessage, 'chat_messages')
clean('tasks.json', isTestTask, 'tasks')
console.log('清理完成。')
