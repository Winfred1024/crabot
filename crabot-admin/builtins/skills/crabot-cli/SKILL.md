---
name: crabot-cli
description: 'Crabot 的自我感知（read）与自我管理（write）入口，覆盖运行时配置与资源 Provider/Agent/MCP/Skill/Channel/Schedule/Friend/Permission。能否运行某条命令取决于发起人的 effective permissions（friend ∪ session 模板的并集）。自我感知（read，敏感字段自动 mask）：当对话需要陈述 Crabot 自身的运行时事实——当前用什么、装了什么、谁在线、谁在跑、配置长什么样——以本工具实时查询为准，不能凭印象/训练知识作答。自我管理（write，按 cli_access[domain]=write 判定）：对上述资源做增删改启停切换撤销诊断（add/update/set/delete/restart/start/stop/toggle/trigger/pause/resume）。schedule add 在非 master 场景额外过 LLM 内容审核。'
version: "3.0.0"
---

# Crabot CLI 管理技能

## Overview

通过 `crabot` CLI 管理 Crabot 系统。CLI 默认输出 JSON，专为 LLM 友好设计。

## 调用方式

通过 Bash tool 执行 `crabot <command>`（默认 JSON 输出，无需加 `--json`）。环境变量 `CRABOT_ENDPOINT` 和 `CRABOT_TOKEN` 由运行时自动注入。

## 权限模型

每条 CLI 命令属于一个 domain（provider / agent / mcp / skill / schedule / channel / friend / permission / config / undo），每个 domain 在你当前的 effective permissions 里有一个 `cli_access` 值：

- `none` → 任何命令都被 hook block
- `read` → 只能跑 list / show / doctor 等只读命令
- `write` → 全部命令均可

effective permissions 是发起人 friend template 和当前 session template 的**并集**：master 朋友默认全 write；普通朋友默认全 none；群聊由群挂的 session template 决定（默认 `group_default` 也全 none，需要 master 在 Admin 把群升到 `group_scheduler` 才能让群友排定时任务）。命令字符串大小写敏感——`crabot Provider list` 会 fail-closed。

## 关键协议

### read 命令（cli_access[domain] >= read 才放行）

`list` / `show` / `config`（无 `--set`） / `doctor` 等只读命令的实际可见性由发起人当前 cli_access[domain] 决定。**敏感字段（apikey、password、secret、token 等）永远 mask 成 `sk-x****-xxxx` 形式**——任何场景下 LLM 都拿不到原文。

### write 命令（cli_access[domain] == write 才放行）

发起人当前 cli_access[domain] 不为 write 时，hook 直接返回 `PERMISSION_DENIED`。

写命令分两类响应路径：

#### A. 默认情况：直接执行 + 返回 undo

绝大多数写命令（add / update / set / restart / toggle / pause / resume 等）：

```json
{
  "ok": true,
  "action": "add",
  "result": { "id": "...", ... },
  "undo": {
    "id": "undo-...",
    "command": "crabot undo undo-...",
    "description": "delete provider openai (a3c1f9e2)",
    "expires_at": "2026-04-28T18:20:01Z"
  }
}
```

→ 操作完成。把 `undo.command` 简单告知 master（"已 X，如需撤销执行 Y"），**不需要** master 二次确认。

#### B. 必 confirm 类：返回 confirmation_required

仅删除类（provider/mcp/skill/schedule/friend/permission delete）和 `schedule trigger` 7 类命令：

```json
{
  "confirmation_required": true,
  "confirmation_token": "...",
  "expires_at": "2026-04-26T18:35:16Z",
  "preview": {
    "action": "delete",
    "side_effects": [...],
    "rollback_difficulty": "需重新粘贴 apikey 原文"
  },
  "command_to_confirm": "crabot ... --confirm <token>"
}
```

→ **必须停下**，把 `preview.side_effects` 和 `preview.rollback_difficulty` 翻译成自然语言告诉 master，明确询问是否继续。得到肯定答复后用 `command_to_confirm` 字段中的命令重新执行。**任何情况下都不要绕过这个流程。**

## schedule add 的内容审核

`schedule add` 是唯一一个会被 LLM 内容审核的写命令——它推迟到未来执行，命令字面合法不代表 worker 跑起来时不越权。审核标准：schedule 跑起来后所需的工具类别是否仍落在你（发起人）的 effective `tool_access` 范围内。

- 审核通过 → 命令正常执行，返回 undo
- 审核拒绝 → 返回 `PERMISSION_DENIED: 该请求未通过内容审核 — <reason>`，把 reason 自然化告诉请求人（不要泄露规则内部细节）
- master 全场景免审

## 重要约束

- **修改已安装的 skill 必须用 `crabot skill update <ref> --file <new-SKILL.md>`**——直接 Write/Edit `data/admin/skills/**` 下的文件会被 PreToolUse hook 拦截，且会绕过 admin 的 N=1 版本管理与 restore 能力。
- **不应主动 `crabot undo`**——除非 master 明确说"撤销刚才那个"。undo 是 master 的工具，不是 agent 自我修正的工具。
- **绝不尝试 `--reveal`**——查看 apikey 原文需走 Admin Web UI，agent 不应该有此能力。
- **错误响应是结构化 JSON**（在 stderr）：`{"error": {"code": "X", "message": "...", "details": {...}}}`。根据 `code` 决定下一步：
  - `NOT_FOUND` → 重新 list 一遍
  - `AMBIGUOUS_REFERENCE` → 看 `details.candidates`，向 master 确认指哪个
  - `CONFIRMATION_INVALID` → token 错或过期，重新发不带 --confirm 的命令拿新 preview
  - `UNDO_STALE` / `UNDO_EXPIRED` / `UNDO_EMPTY` → 告知 master 不能 undo
  - `PERMISSION_DENIED` → 当前发起人的权限范围不够（或被内容审核拦下），把 reason 翻译成自然语言告诉请求人

## 引用方式

所有需要 ID 参数的命令（`<ref>`）支持三种引用：

1. 完整 UUID：`a3c1f9e2-1111-...`
2. **name**：`openai`（推荐——LLM 友好）
3. **短前缀**（≥4 字符）：`a3c1`

## 常用操作

```bash
# 状态查看（cli_access[domain] >= read 即可）
crabot provider list
crabot agent list
crabot agent doctor                    # 综合诊断（连接性 + 模型配置）

# 切换模型（一条命令完成）
crabot agent set-model code-helper --slot fast --provider openai --model gpt-5
crabot config switch-default --provider openai --model gpt-4o

# 启用/禁用
crabot mcp toggle weather --on
crabot schedule pause daily-report
crabot schedule resume daily-report

# 撤销最近一次写操作（master 主动调用，agent 一般不调）
crabot undo
crabot undo list                       # 查看可撤销清单
```

## 详细命令参考

见 `references/command-ref.md`（由 `scripts/gen-skill-ref.mjs` 自动生成自 `crabot --schema`，与 CLI 实现保持同步）。
