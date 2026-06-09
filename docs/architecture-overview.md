# Crabot 系统设计图

> 整理时间：2026-05-06
> 信息源：当前代码仓库（crabot-core / crabot-admin / crabot-agent / crabot-memory / crabot-channel-* / crabot-shared / crabot-mcp-tools）+ `crabot-docs/` 协议文档
> 注意：`crabot-docs/architecture/overview.md` 写于 2026-03-05，含 LiteLLM、Flow 模块等已移除内容，请以本文为准。

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           外部系统 / 用户                                 │
│   人类用户   飞书 / 微信 / Telegram   ChatGPT / Claude / Gemini / OpenAI │
└─────┬───────────────────┬───────────────────────────────┬────────────────┘
      │ Web UI            │ IM / 长连接                   │ HTTPS 原生 API
      │ (3000 / 5173)     │ (WSClient / WebHook / Bot)   │
      ▼                   ▼                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          业务层（可热插拔）                                │
│                                                                           │
│  ┌───────────────────────────┐  ┌────────────────────────────────────┐   │
│  │  crabot-channel-*         │  │  crabot-agent (UnifiedAgent)       │   │
│  │  • feishu (原生)          │  │  Front (分诊) ↔ Worker (执行)       │   │
│  │  • wechat (原生)          │◀─▶│  Engine V2 + LLM Adapter          │   │
│  │  • telegram (原生)        │  │  内置工具 / MCP / Skill / Sub-agent │   │
│  │  • host (OpenClaw shim)   │  └─────────┬──────────────────────────┘   │
│  └───────────────────────────┘            │                              │
│                                            │ JSON-RPC                     │
│  ┌───────────────────────────┐             ▼                              │
│  │  crabot-memory (Python)   │   ┌────────────────────────────────────┐  │
│  │  Short-term + Long-term v2│◀─▶│  crabot-mcp-tools                  │  │
│  │  LanceDB + SQLite + MD    │   │  computer-use / lsp / git (stdio)  │  │
│  └───────────────────────────┘   └────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                      ▲
                                      │ JSON-RPC (HTTP)
                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       管理层 (crabot-admin, Node)                         │
│                                                                           │
│   Web UI (React/Vite) ──▶ REST/SSE/WS ──▶ AdminModule                    │
│                                          │                                │
│   ┌─────────────────────┬────────────────┼──────────────────────────┐    │
│   │ ChannelManager      │ AgentManager   │ ModelProviderManager     │    │
│   │ ChatManager         │ ScheduleEngine │ MemoryV2RestProxy        │    │
│   │ MCPSkillManager     │ TaskManager    │ OnboardingManager (OAuth)│    │
│   │ PermissionTemplates │ DialogObjects  │ RuntimeManager / PTY     │    │
│   └─────────────────────┴────────────────┴──────────────────────────┘    │
│   持久化：data/admin/*.sqlite + data/admin/*-configs/*.json               │
└──────────────────────────────────────────────────────────────────────────┘
                                      ▲
                                      │ 注册 / 健康 / 事件总线
                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                  核心层 (crabot-core, Module Manager)                     │
│   • 进程生命周期 (spawn / health / restart)                              │
│   • 端口分配 (19000-19999, 支持 CRABOT_PORT_OFFSET)                      │
│   • 服务发现 (/resolve)  + 事件总线 (publish / fan-out)                   │
│   • 不可热更新；启动时必须存在                                            │
└──────────────────────────────────────────────────────────────────────────┘
                                      ▲
                                      │ 共享类型 + RpcClient + ModuleBase
                                      ▼
                        ┌───────────────────────────────┐
                        │ crabot-shared (file: 引用)     │
                        │ base-protocol / module-base   │
                        │ proxy-manager / onboarder     │
                        └───────────────────────────────┘
```

> LLM Gateway 层已废弃：Agent 直连 Provider 原生 API（Anthropic / OpenAI / Gemini OpenAI 兼容端点 / OpenAI Responses + OAuth），由 `engine/llm-adapter.ts` 按 `format` 路由。

---

## 2. 模块清单与端口

| 模块 | 仓库 | 语言 | 端口（offset 0） | 可热插拔 | 可自我更新 |
|------|------|------|------------------|----------|------------|
| Module Manager | `crabot-core` | TS | 19000 | ❌ | ❌ |
| Admin (RPC) | `crabot-admin` | TS | 19001 | ⚠️ | ✅ |
| Admin (Web) | `crabot-admin/web` | React | 3000（dev: Vite 5173） | — | — |
| Memory | `crabot-memory` | Python | 19002 | ✅ | ✅ |
| Agent | `crabot-agent` | TS | 19003+ | ✅ | ✅ |
| Channel-Feishu | `crabot-channel-feishu` | TS | 19003+ | ✅ | ✅ |
| Channel-WeChat | `crabot-channel-wechat` | TS | 19003+ | ✅ | ✅ |
| Channel-Telegram | `crabot-channel-telegram` | TS | 19003+ | ✅ | ✅ |
| MCP-Tools | `crabot-mcp-tools` | TS | stdio（无端口） | — | — |
| Shared | `crabot-shared` | TS | —（库） | — | — |

多实例：`CRABOT_PORT_OFFSET=100` 时整段 +100，数据目录变为 `data-100/`。

---

## 3. crabot-agent 内部分层

```
                ┌────────────────────────────────────────┐
                │             UnifiedAgent               │
                │  (orchestration + agent 的合体入口)     │
                └─────────────────┬──────────────────────┘
                                  │
   ┌──────────────────────────────┼──────────────────────────────┐
   │                              │                              │
   ▼                              ▼                              ▼
┌──────────┐         ┌──────────────────────┐       ┌────────────────────┐
│Orchestra-│         │ Front Handler        │       │ Worker Handler     │
│tion 层    │         │ (分诊，5 轮上限)      │       │ (任务执行)          │
│          │         │                      │       │                    │
│Session   │         │ 4 个决策工具：        │       │ • Engine V2 query  │
│Switchmap │ ──────▶ │ • reply              │ ────▶│   loop             │
│Permission│         │ • create_task         │       │ • Mutable TodoStore│
│WorkerSel │         │ • supplement_task     │       │ • Internal tools   │
│Context-  │         │ • stay_silent         │       │   bash/read/write/ │
│Assembler │         │                      │       │   edit/glob/grep   │
│Decision- │         │ 携带 user_attitude    │       │ • MCP Connector    │
│Dispatcher│         │ → memory 反馈         │       │   stdio/http/sse   │
│Memory-   │         └──────────────────────┘       │ • Skill 工具        │
│Writer    │                  │                      │ • Sub-agent        │
│Attention-│                  │                      │ • bg-entities      │
│Scheduler │                  │                      │   shell / agent    │
│SceneProf │                  │                      └────────────────────┘
└──────────┘                  │                                 │
      │                       │                                 │
      │     ┌─────────────────┴─────────────────┐               │
      │     │           Engine                  │               │
      │     │                                   │               │
      │     │  llm-adapter.createAdapter()      │ ◀─────────────┘
      │     │   ├── anthropic    → @anthropic   │
      │     │   ├── openai       → openai (chat)│
      │     │   ├── gemini       → openai 兼容  │
      │     │   └── openai-resp  → Responses API│
      │     │                       (OAuth)     │
      │     │                                   │
      │     │  query-loop / stream-processor    │
      │     │  context-manager / progress-digest│
      │     │  retry-utils / byte-cap (10MB)    │
      │     │  permission-checker / tools/      │
      │     └───────────────────────────────────┘
      │
      ▼
   data/agent/   trace store / bg-entities registry / state.json
```

关键约束：
- Front 是「分诊 / triage」不是「调查」，工具上限 5 轮，复杂查询走 worker。
- Front 只能调 4 个决策工具中的一个，schedule 创建走 worker → `crabot schedule add` CLI。
- Worker 用自维护的 mutable TodoStore，`onAfterCompaction` 注入 active todo。

---

## 4. crabot-memory 内部结构

```
                        ┌──────────────────────────────┐
                        │          Memory Module         │
                        │  Python + FastAPI + JSON-RPC   │
                        └──────────────┬─────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
          ┌────────────────────┐              ┌──────────────────────┐
          │   Short-term       │              │   Long-term v2       │
          │   (core/short_term)│              │   (long_term_v2/)    │
          │                    │              │                      │
          │ • SQLite           │              │ • Markdown files     │
          │ • Recent messages  │              │ • SQLite index       │
          │ • Per-channel state│              │ • LanceDB vectors    │
          └────────────────────┘              │ • Bi-temporal        │
                                              │ • PE-Gated Write     │
                    ┌──────────────────┐      │ • Observation 期      │
                    │ Storage layer    │      │ • Case → Rule 晋升    │
                    │ scene_profile    │      │ • Frozen Snapshot    │
                    │ short_term_store │      │ • Evolution Mode     │
                    │ sqlite_store     │      │ • Chain-of-Note      │
                    └──────────────────┘      │ • RRF + Reranker     │
                                              │ • lesson_task_usage  │
                                              │   (反馈信号闭环)      │
                                              └──────────────────────┘
```

调用方：Agent（assemble context / write_memory / report_task_feedback）、Admin Web（管理页 v2 REST 代理）。

---

## 5. 配置 / 数据流

### 5.1 配置层级（配置存引用，不存快照）

```
全局默认（Admin Settings）
   ↓
Agent 实例 model slot 配置
   ↓
buildConnectionInfo(provider_id, model_id)   ← 唯一解析入口
   ↓                                          ← OAuth token 自动刷新
{endpoint, apikey, model_id, format, account_id?}
   ↓
Agent.createAdapter()
```

写入：Admin Web → REST → Admin 持久化 → `pushConfigToAgentModules()` 推到运行中的 Agent。
读取：Agent 启动 / 收到 push → `get_agent_config` RPC → handleGetAgentConfig 实时解析。

### 5.2 用户消息处理流程

```
外部用户消息
    ▼
┌──────────────┐
│ Channel 模块  │  原生 SDK 或 OpenClaw shim 接收
└──────┬───────┘
       │ publish: channel.message_authorized
       ▼
┌──────────────────────────────────┐
│ Agent (UnifiedAgent)              │
│  AttentionScheduler 缓冲           │
│   ↓                                │
│  Front Handler                     │
│   ├─ reply                         │
│   ├─ create_task → Worker          │
│   ├─ supplement_task → Worker      │
│   └─ stay_silent                   │
│  user_attitude → MemoryWriter      │
└──────┬───────────────────┬─────────┘
       │ 回复               │ 任务执行
       ▼                   ▼
   Channel.send       Worker (Engine V2 query loop)
                          ├─ 内置工具 / MCP / Skill / Sub-agent
                          ├─ Memory 召回（带 task_id 写 lesson_task_usage）
                          └─ 通过 crab-messaging MCP 回 Channel
```

---

## 6. 通信机制

| 机制 | 协议 | 用途 |
|------|------|------|
| 模块间 RPC | HTTP + JSON-RPC（路径 = method 名） | Agent ↔ Admin / Memory / Channel |
| 事件总线 | MM `/publish_event` + 订阅者 `/on_event` | channel.message_authorized 等 |
| Web UI ↔ Admin | REST + SSE（onboarding）+ WS（traces） | 用户操作 |
| Agent ↔ LLM | 各 Provider 原生 SDK（HTTPS） | createAdapter 路由 |
| Agent ↔ MCP Tool | stdio / streamable-http / sse | computer-use / lsp / git / 用户配置的 server |
| 子模块加载 | `crabot-shared` file: 引用 | base-protocol / ModuleBase |

---

## 7. 数据存储

```
data/                              （DATA_DIR，可被 CRABOT_PORT_OFFSET 改成 data-100/）
├── admin/
│   ├── *.sqlite                   friends / tasks / schedules / permissions
│   ├── channel-configs/<id>.json  channel 实例 env（含原生 SDK 凭证）
│   ├── mcp-servers/*.json         全局启用层 MCP 配置
│   ├── skills/*.json + *.md       全局 skill 配置 + 内容
│   ├── oauth/                     ChatGPT / 飞书 OAuth refresh token
│   └── ...
├── agent/
│   ├── trace-store/               trace + span 树
│   ├── bg-entities/               persistent shell / agent registry
│   └── state.json
├── memory/
│   ├── long_term/<entry>.md       + .versions/v<n>.md
│   ├── lancedb/                   向量索引
│   └── short_term.sqlite
└── module-manager/                端口分配表 / registry
```

---

## 8. Channel 实现矩阵（别搞混）

| Channel | implementation_id | 路径 | 凭证来源 |
|---------|-------------------|------|----------|
| 飞书 (原生) | `channel-feishu` | `crabot-channel-feishu` + `@larksuiteoapi/node-sdk` | 设备码 OAuth → channel-configs/*.json |
| 微信 (原生) | `channel-wechat` | `crabot-channel-wechat` + wechat-connector REST | channel-configs/*.json (URL + API key) |
| Telegram (原生) | `channel-telegram` | `crabot-channel-telegram` | channel-configs/*.json |

所有 channel 走原生模块路径。

---

## 9. 启动与运行时拓扑

```
./dev.sh
  └─ crabot-core (Module Manager :19000)
      ├─ spawn  crabot-admin       (RPC :19001  + Web :3000 静态 / 5173 Vite HMR)
      ├─ spawn  crabot-memory      (:19002)  via `python -m src.main`
      ├─ spawn  crabot-agent       (:19003+) UnifiedAgent
      └─ spawn  crabot-channel-*   (:19003+) 按 Admin 配置的实例数
          ↑
          └─ MM 通过 env 注入 Crabot_PORT / Crabot_MODULE_ID / DATA_DIR / CRABOT_ADMIN_ENDPOINT
```

`launcher.sh` 只用于生产；开发用 `./dev.sh`，停 `./dev.sh stop`。

---

## 10. 设计原则

1. **Admin Web 是唯一配置入口**。配置存引用（provider_id + model_id），不存快照，由 `ModelProviderManager.buildConnectionInfo()` 实时解析。
2. **Agent 直连 Provider 原生 API**，由 `engine/llm-adapter.ts` 按 `format` 路由。LiteLLM 已下线。
3. **文档驱动**：协议文档（`crabot-docs/protocols/*.md`）是唯一真相来源，代码对齐文档。
4. **环境无关配置**：禁止硬编码绝对路径，统一用 `DATA_DIR` / 相对路径。
5. **Channel 优先原生模块**：OpenClaw shim 仅过渡期保留。
6. **Front 是分诊不是调查**：Front 5 轮硬上限，复杂工作交 Worker。
7. **事后可挽回 > 事前 confirm**：写入类工具默认 rollback（undo log）。
8. **多实例隔离**：`CRABOT_PORT_OFFSET` 切片端口与数据目录。

---

## 11. 参考文档

- 协议规范：`crabot-docs/protocols/`（base / agent-v2 / admin / channel / memory / module-manager）
- 设计记录：`crabot-docs/design-records/`、`crabot-docs/superpowers/specs/`
- 调试手册：`docs/agent-debugging.md`
- 项目进度：`PROGRESS.md`
- 全局协调指引：根目录 `CLAUDE.md`
