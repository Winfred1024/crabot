# Crabot 项目进度

> 最后更新：2026-05-19 — Phase 5 阶段 2c：vision → research_collector + WORKFLOW 派发改 main 主动

## 最新里程碑（2026-05-19 — Phase 5 阶段 2c：research_collector 重构 + WORKFLOW 派发改造）

阶段 2b 落地后发现两个问题：① vision builtin 在多模态时代价值缩水（所有 vision-capable 模型已可直接读图）；② WORKFLOW [执行] 段预设 `[self]/[vision]/[code]` 派发标签把决策框死，自定义 subagent 没法自动接入。阶段 2c 一次性解决这两个：

- **vision → research_collector**：删 vision builtin，加 `research_collector`（model_role=vision 复用多模态能力 / max_turns=20 / `file_system: false` 干净边界——只调 mcp + crab-memory 不读写本地 / `allowed_mcp_server_ids: []` 默认空 → 用户启用时手动勾选 scrapling 等 web mcp / 5 段 prompt 强制 ≤2K tokens markdown summary 输出）
- **WORKFLOW 派发改造**：[规划] 段 todo content 不再标 `[self]/[vision]/[code]`；[执行] 段保留**唯一硬约束**（编码任务 code_planner → code_writer 串联）+ **main 自主决策**（看 `delegate_task` 工具 description 里的 `<available_subagents>` 选 when_to_use 最匹配的 subagent）+ **核心派发原则**（subagent 价值 = 消化大量 raw 输入并精炼输出，避免 main context 撑爆）。效果：用户自定义 subagent 自动出现在 `<available_subagents>` 段，main 看到就能用，无需改 prompt
- **新 lifecycle 操作 `pruneObsoleteBuiltins`**：admin 启动时把已经从 `getBuiltinSubAgents()` 列表中移除但 registry 还在的 builtin entry 删掉 + console.warn 告知"如曾通过 Admin UI 编辑过 prompt，自定义内容将丢失"。从 2b 升级 2c 时启动日志会看到 `[SubAgentManager] 删除已废弃的 builtin subagent: vision (id=builtin-vision)...`

spec：`crabot-docs/superpowers/specs/2026-05-19-subagent-phase2c-research-collector.md`
plan：`crabot-docs/superpowers/plans/2026-05-19-subagent-phase2c-research-collector.md`

主要改动（5 个代码 commit + 1 个协议文档 commit，TDD 全程）：

- `crabot-admin/src/builtin-subagents.ts` 删 5 个 VISION_* 常量 + 加 5 个 RESEARCH_COLLECTOR_*；entry 第 3 项整重写（`builtin-research-collector` / model_role=vision / file_system=false / allowed_mcp_server_ids=[]）
- `crabot-admin/src/subagent-manager.ts` `pruneObsoleteBuiltins(activeBuiltinIds)` 方法 + 5 个新单测（清理 / 保留自定义 / idempotent / 空 list / 多个废弃同清）
- `crabot-admin/src/index.ts` `initialize()` 在 `subAgentManager.initialize()` 后 `seedBuiltin()` 前接入 `pruneObsoleteBuiltins(getBuiltinSubAgents().map(s => s.id))`
- `crabot-admin/tests/builtin-seeding.test.ts` `vision` → `research_collector` 测试用例改写（验 model_role=vision + file_system=false + allowed_mcp_server_ids=[]）
- `crabot-agent/src/prompts/agent-sections.ts` `WORKFLOW_PRIVATE` [规划]/[执行] 段重写：删派发标签 / 加硬约束 + 例外条款 / 加 main 自主判断三层结构 / 加核心派发原则；snapshot 自动更新 12/12 PASS
- `crabot-docs/protocols/protocol-agent-v2.md` §11.8 表 vision → research_collector；§11.8.2 整段重写（删 `[self]/[vision]/[code]` 表 / 留硬约束 + main 自主决策 + 自定义自动可用说明）

启动验证（在 e2e 验收时观测到）：
- admin 启动日志含 `[SubAgentManager] 删除已废弃的 builtin subagent: vision (id=builtin-vision)...` + `[Admin] Seeded 3 builtin subagents`
- `cat data/admin/subagents.json` 看到 3 个 entry：code_planner / code_writer / research_collector（无 vision）
- `curl /api/subagents` 返回 3 个 entry，research_collector 的 model_role=vision、file_system=false
- `curl /get_config` agent 端拿到 3 个 subagent，model 已实时解析

待 master 跑端到端：
1. 发编码诉求消息 → trace 看 main 是否走硬约束（code_planner → code_writer 串联），不应自己用 Write 改用户代码
2. 发简单聊天消息 → trace 看 main 是否直接 send_message，不应误委派 research_collector
3. 配 vision-capable 全局默认 model（当前实例 `research_collector` model 解析时 fallback 到 cost_effective 的 `kimi-for-coding`，应配 vision role 让其用真正多模态模型）
4. 启用 scrapling 等 web mcp → 通过 admin UI 编辑 research_collector 的 `allowed_mcp_server_ids` 勾选

## 上一里程碑（2026-05-18 — Phase 5 阶段 2b：内置 subagent + plan-and-execute 落地）

阶段 2a 调研产物落地：admin 启动时 seed 3 个 builtin subagent（code_planner / code_writer / vision）+ 3 个 builtin skill（superpowers v5.0.7 MIT 的 writing-plans / systematic-debugging / verification-before-completion）+ main worker prompt 在 enabled subagents 含 code_planner 时自动注入 PLAN_AND_EXECUTE_GUIDE 引导段。

spec：`crabot-docs/superpowers/specs/2026-05-18-subagent-phase2b-builtin-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-18-subagent-phase2b-builtin.md`
research：`crabot-docs/superpowers/research/2026-05-18-coding-skill-survey.md`

主要改动（6 个代码 commit + 1 个协议文档 commit + 1 个 progress commit，TDD 全程）：

- `crabot-admin/builtin-skills/*.md` 3 个 SKILL.md snapshot（superpowers v5.0.7 MIT，加 attribution header；项目根级，dev/prod 通过 `join(__dirname, '..', 'builtin-skills')` 均可访问）
- `crabot-admin/src/builtin-skills.ts` getBuiltinSkills() + BUILTIN_SKILL_IDS
- `crabot-admin/src/builtin-subagents.ts` getBuiltinSubAgents() + BUILTIN_SUBAGENT_IDS + 完整 5 段 prompt 文本（来自调研报告）
- `crabot-admin/src/mcp-skill-manager.ts` SkillManager.seedBuiltinSkills（idempotent）
- `crabot-admin/src/index.ts` AdminModule.initialize 接入两个 seedBuiltin + 启动日志
- `crabot-agent/src/prompts/agent-sections.ts` PLAN_AND_EXECUTE_GUIDE 常量
- `crabot-agent/src/prompts/assemble-agent.ts` hasCodePlanner option + 条件注入
- `crabot-agent/src/agent/agent-handler.ts` buildSystemPrompt 计算 hasCodePlanner = subAgents 含 code_planner
- `crabot-docs/protocols/protocol-agent-v2.md` §11.8 内置 subagent + §11.8.1 内置 skill + §11.8.2 plan-and-execute 引导段 + §11.8.3 writer 上报格式

build + dist smoke test 已通过：dist/builtin-skills.js + dist/builtin-subagents.js 编译后可加载 3 个 skill + 3 个 subagent（writing-plans content 6284 字节）。13 个新增 admin 测试 + 4 个新增 agent 测试全绿。

待 master 跑端到端：
1. `./dev.sh stop && ./dev.sh` 重启
2. `curl http://localhost:3000/api/skills` 看 3 个 is_builtin=true 的 builtin skill（writing-plans / systematic-debugging / verification-before-completion）
3. `curl http://localhost:3000/api/subagents` 看 3 个 builtin subagent
4. 发"帮我加个 X 功能"类编码消息 → trace 看 worker 先调 code_planner（拿 PLAN_PATH）再调 code_writer（按 plan 实施）

## 上一里程碑（2026-05-18 — Phase 5 阶段 1：subagent 架构骨架完成）

把 subagent 体系从 hardcoded `SUBAGENT_DEFINITIONS` 升级为 admin-managed 资源；worker 工具表注入单一 `delegate_task` 工具；agent role 整顿为 3 个 ModelRole；不预填任何内置 subagent（阶段 2b 才 seed code_planner/code_writer/vision）。

分支：`feature/subagent-phase1`（4 个 repo：root / crabot-admin / crabot-agent / crabot-docs）。12 个代码 commit + 2 个 docs commit，TDD 全程。

spec：`crabot-docs/superpowers/specs/2026-05-17-subagent-customization-and-admin-ui-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-17-subagent-phase1-architecture.md`

**Admin 侧（Task 1-5）**：
- `crabot-admin/src/types.ts`：新增 `SubAgentRegistryEntry` / `SubAgentConfig` / `BuiltinCapabilities` / `ModelRole`；`AgentInstanceConfig` 加 `timeout_seconds` + `overdue_reminder_enabled`
- `crabot-admin/src/subagent-manager.ts`：`SubAgentManager` 类（CRUD + 原子写 + seed 内置 + validateModelSpec），12 个单测；新增 `resolveSubAgentModel`（specific 优先 / role 回退）
- `crabot-admin/src/index.ts`：`/api/subagents` 5 个 REST handler；mutating 触发 `triggerPushAfter`；`buildSubAgentConfigsForPush` 把 entry 转 SubAgentConfig（实时解析 LLMConnectionInfo），失败 skip + warn；`pushConfigToAgentModules` 把 subagents + timeout_seconds + overdue_reminder_enabled 加入 update_config payload
- `crabot-admin/src/agent-manager.ts`：`DEFAULT_IMPLEMENTATION.model_roles` 整顿为 `powerful` / `cost_effective` / `vision`；`migrateModelConfig` 启动 migration（default/worker/smart → powerful；triage/digest/fast → cost_effective；vision_expert → vision；coding_expert 丢弃），7 个单测

**Agent 侧（Task 6-12）**：
- `crabot-agent/src/types.ts`：新增 `SubAgentConfig` / `BuiltinCapabilities`；`AgentLayerConfig` 加 3 个新字段；`UpdateConfigParams` 同步
- `crabot-agent/src/agent/subagent-prompt-assembler.ts`：5 段拼装 + 头尾守则（不轮询 / 不持久化 / 不主动副作用 / 截断重读），6 个单测
- `crabot-agent/src/agent/subagent-tool-filter.ts`：`classifyTool`（9 group）+ `filterToolsForSubAgent`，24 个单测；`delegate_task` 永远从 subagent 工具集剔除（防嵌套）
- `crabot-agent/src/agent/delegate-task-tool.ts`：`buildDelegateTaskDescription`（`<available_subagents>` 装配）+ `createDelegateTaskTool`（单一工具入口 + dispatch by subagent_type），8 个单测
- `crabot-agent/src/agent/agent-handler.ts`：删 per-subagent 循环；注入单一 `delegate_task`；新增 `makeRunSubAgent`（filter → assemble → adapter → forkEngine + trace stitching + endTrace 双路径）
- `crabot-agent/src/unified-agent.ts`：buildSubAgentConfigs 改读 `config.subagents`；删 `buildSubAgentConfigs` / `resolveSubAgentSlot` 旧方法；`handleUpdateConfig` 加 subagents 变化检测（触发 worker 重建）+ timeout_seconds / overdue_reminder_enabled 软热更；新增 `resolveTimeoutSeconds` / `resolveOverdueReminder` 默认 30s/true，4 个 `handleTriggerMessage` 调用点接入
- `crabot-agent/src/agent/subagent-prompts.ts`：删 `SUBAGENT_DEFINITIONS` 常量 + `SubAgentDefinition` interface + `DELEGATE_TASK_SYSTEM_PROMPT`；保留 `formatSupplementForSubAgent`

**协议文档（Task 13）**：
- `crabot-docs/protocols/protocol-agent-v2.md`：新增 §11 "Subagent 配置"（7 子章节）；旧 §9 标注"已被 §11 替换"
- `crabot-docs/protocols/protocol-admin.md`：§3.19 加 Subagent 注册表 + ModelRole 重整两子章节

**端到端验证（待 master 自跑）**：

1. `./dev.sh stop && ./dev.sh` 重启加载新代码
2. `curl http://localhost:3000/api/subagents` → 期望返回 `[]`（阶段 1 不预填）
3. `curl -X POST http://localhost:3000/api/subagents -H 'Content-Type: application/json' -d '{...}'` 创建测试 subagent → 期望 201 + entry JSON
4. `node scripts/debug-agent.mjs traces` → 触发一条消息后看最新 trace，worker 工具表应有 `delegate_task` + description 含新 subagent
5. 检查 `data/admin/agent-instances/*.json`，原 model_config keys（如 `worker` / `triage`）应已迁移到 `powerful` / `cost_effective`
6. 删除测试 subagent + `./dev.sh stop`

阶段 2a / 2b / 3 留给后续 PR：
- 2a：coding skill 调研（hermes-agent superpowers + everything-claude-code）
- 2b：seed code_planner + code_writer + vision 内置 subagent，挂接 coding skill；main worker prompt 加 plan-and-execute 引导
- 3：Admin Web UI（SubagentList + SubagentEditor 6 tab）

## 上一里程碑（2026-05-08 — crab-messaging list_contacts/list_groups 路由修正 + 分页可见性）

修复 2026-05-08 早报 trace `f0f7d4bb` 暴露的"`list_groups` 必失败"bug：自 2026-04-04 commit `f48fbb9` 引入以来，`crab-messaging` MCP 的 `list_contacts` / `list_groups` 工具一直把 RPC 路由到 `adminPort.list_sessions`（admin 端从来没有这个 method），每次调用必返回 `Method "list_sessions" not found`，靠 LLM 改名重试到 `list_sessions` 兜底掩盖。

spec：`crabot-docs/superpowers/specs/2026-05-08-messaging-list-tools-alignment-design.md`
plan：`crabot-docs/superpowers/plans/2026-05-08-messaging-list-tools-alignment.md`

- **协议文档（crabot-docs 子 repo）**：`protocol-crab-messaging.md` §2.1 / §4 把笔误的 admin "list_contacts" 改回 `list_friends`（admin 管 Friend 表，channel 才有 Contact 概念）；§2.7 / §2.8 加错误码表。`protocol-channel.md` 新增 §3.13 list_contacts / §3.14 list_groups 接口定义（基于 PaginatedResult），§3.2 ChannelCapabilities 加 supports_list_contacts/groups 字段。`base-protocol.md` GlobalErrorCode 加 PERMISSION_DENIED。
- **crabot-shared**：`module-base.ts` 加 RpcError / RpcCallError / formatHandlerError，让 handler 抛 RpcError 时 code/details 透传到 response.error；让 RpcClient.call 收到 success=false 时 reject RpcCallError 携带原 code/details（之前只剩 message 的普通 Error）。`base-protocol.ts` GlobalErrorCode 加 PERMISSION_DENIED 常量避免下游用裸字符串。
- **crabot-channel-wechat**：types.ts 加 supports_list_contacts/groups（capability）+ 6 个 List* 协议类型。`wechat-client.ts` 加 listContacts() 调 `GET /api/v1/bot/contacts`（已有的 listGroups 复用）。`wechat-channel.ts` 注册 list_contacts / list_groups RPC handler，client 原生字段（username/nickname/chatroomName/name）映射到协议字段（platform_user_id/display_name/platform_session_id/group_name），分页 camelCase → snake_case 翻译。capability 上报 true。22 个测试。
- **crabot-channel-feishu**：同形扩展。`feishu-client.ts` 加 listContacts() 调 `contact.v3.user.list`；飞书错误码 99991672 / 99991663（通讯录读取权限缺失）翻译为 `RpcError('PERMISSION_DENIED', ..., { missing_scope: 'contact:user.base:readonly' })`，其他错误透传。`feishu-channel.ts` 注册 list_contacts / list_groups handler；handler 层 self-filter（飞书 contact API 不支持 keyword）+ case-insensitive；分页近似 has_more=true → total_pages=2（避免 N+1 误导下游）。86 个测试。
- **crabot-channel-telegram**：bot api 不支持列群/列联系人，capability 上报 false。crab-messaging 在路由前看 capability 直接返回 `CHANNEL_LIST_*_NOT_SUPPORTED` 错误码，agent 看到 hint 自然 fallback 到 list_sessions。
- **crabot-agent crab-messaging.ts**：抽出 `buildMessagingTools(deps, sandboxPathMappingsRef?)` 纯函数返回 8 个工具数组（lookup_friend / list_contacts / list_groups / list_sessions / send_private_message / send_message / get_history / get_message），让工具可单测。`createCrabMessagingServer` 改用循环 register。list_contacts / list_groups 改路由到 channelPort + 用新 list_contacts/list_groups RPC（不再调 admin.list_sessions）。三个 list 工具统一通过 `annotatePagination` 给返回叠加 has_more / is_truncated / default_page_size_applied / next_page 显式字段，避免 LLM 把单页结果当全集；通过 `translateChannelError` 把 RpcCallError 翻成结构化输出（`CHANNEL_LIST_*_NOT_SUPPORTED` 带 hint，`PERMISSION_DENIED` 透传 missing_scope）。新建 pagination-annotator / error-translator 两个独立模块。新增 6 个 crab-messaging-list 集成测试，全 agent 803 测试。
- **prompt-manager**：worker prompt 加"找群/找联系人优先顺序"段（lookup_friend → list_groups/list_contacts → list_sessions）+ 分页可见性提示（has_more=true 时不要把单页当全集）。
- **commits**：13 个 commit 全程 TDD（spec → plan → 4 个 phase 顺序推进 + 各 phase code review fix）。

**端到端验证（待 master 自跑）**：

1. `./dev.sh stop && ./dev.sh` 重启加载新代码
2. wechat：`@crabot 用 list_groups 在 wechat-棉花糖 上找包含 'Claude' 的群` → 看 trace 中只调一次 list_groups 直接命中、不再先失败再 fallback
3. wechat：`@crabot 用 list_contacts 在 wechat-棉花糖 列联系人` → 返回带 has_more / next_page / default_page_size_applied 的分页元信息
4. telegram：`@crabot 用 list_groups 在 telegram-fufu 找群` → 收到 `error_code: CHANNEL_LIST_GROUPS_NOT_SUPPORTED` + hint 引导改用 list_sessions
5. feishu：list_groups / list_contacts 看是否能正常返回；如果应用没拿通讯录 scope 应收到 `PERMISSION_DENIED` + missing_scope='contact:user.base:readonly'
6. 下一轮（2026-05-09 08:00）GitHub 早报调度：trace 应无 iter=fail+iter=retry 模式

## 上一里程碑（2026-05-07 — CLI 权限统一进 Friend + Session 模板）

把 crabot CLI 的权限闸从硬编码 `isMasterPrivate` 单 bit 升级为按发起人解析 effective permissions（friend ∪ session 并集）+ schedule add 内容 LLM 审核。master 在群聊享完整 CLI 权限；群友在被升级到 `group_scheduler` 模板的群里可创建受审核的简单定时任务。plan：`docs/superpowers/plans/2026-05-06-cli-permission-friend-session-union.md`。

- **types.ts（admin / agent / web）**：新增 `CliPerm`/`CliDomain`/`CLI_DOMAINS`/`CliAccessConfig`，扩 `PermissionTemplate`/`SessionPermissionConfig`/`FriendPermissionConfig`/`ResolvedPermissions` 各加 `cli_access` 字段。`crabot-shared` 是 `CliDomain` 的单一真相来源，admin/agent 各自重新定义 `CliPerm`/`CliAccessConfig` 但 union 字面量从 shared import 来防漂移。
- **PermissionTemplateManager**：5 个系统模板（master_private 全 write / group_default 全 none / minimal 全 none / standard 全 none / 新增 group_scheduler 仅 schedule=write 且 tool_access 含 messaging+memory+task）；normalize 自动给旧持久化数据补默认；resolvePermissions 合并 session.cli_access；旧 friendPermissionConfig 缺 cli_access 时由 normalizeFriendPermissionConfig 兜底全 'none'。
- **Admin RPC + REST**：新增 `resolve_principal_permissions`（friend ∪ session 并集；master 短路；都缺 → minimal 兜底）。helper 拆到 `permission-resolution.ts`：`unionCliPerm` rank 取大、`unionStorage` path 不一致时取受限侧（防提权）、`unionResolved` 单边返回也 deep clone（不暴露引用）。REST 路径 `POST /api/permissions/resolve-principal`。
- **Agent unified-agent**：原 `resolveSessionPermissions` / `resolveGroupPermissions` 双路径合并为 `resolvePrincipalPermissions(senderFriend?, sessionId, sessionType)` 调新 RPC；删除 4 个旧 method（净 -87/+38 行）。
- **crabot-shared cli-domains**：新增 `classifyCliSubcommand(subcommand) → {domain, kind} | null`（48 个映射含 provider test/refresh）+ `REQUIRES_CONTENT_REVIEW = new Set(['schedule add'])`。`CLI_WRITE_SUBCOMMANDS` 标 deprecated。
- **agent hook**：`block-cli-write` 升级为 `cli-permission-gate`（按 `cli_access[domain]` 判定 + schedule add LLM 审核）；worker-handler 无条件注册（不再分 master 私聊），把 `senderIsMaster` / `resolvedPermissions` / `contentReviewer` 通过 `EngineOptions → query-loop → HookExecutorContext` 透传到 hook 内部。`isMasterPrivate` 局部变量保留给 progress digest / bg entity persistence 独立语义。fail-closed 6 处：`--reveal` 永拦 / 未识别 subcommand / 缺 resolvedPermissions / cli_access 不够 / 缺 reviewer / reviewer deny。reviewer **抛错**也 fail-closed deny（hook 内显式 try/catch，防 hook-executor 把异常吞成 continue）。
- **cli-content-reviewer**：fast model 调 LLM judge schedule 描述工具是否落在 effective tool_access 范围内。fail-closed：throw / parse 失败 / 非法 verdict 全 deny。`parseVerdict` 用 bracket-balance 解析（避免 reason 字段含 `}` 提前截断）+ markdown 围栏剥离。复用 worker 自身 `sdkEnv` 的 adapter（schedule add 频率低，单独 review slot 留作 follow-up）。
- **Admin Web**：PermissionTemplate 编辑页加 cli_access 配置段（10 个 domain × none/read/write 下拉），types.ts + service 同步加 CliAccessConfig。
- **Prompt + Skill**：`crabot-cli` skill 重写到 v3.0.0；Worker prompt L264 / L401 去"仅 master 私聊"，引向"按发起人 cli_access"+ schedule 审核语义。
- **协议文档**：`crabot-docs/protocols/protocol-admin.md` §3.2 加 `cli_access` 字段 + §3.2.7 `resolve_principal_permissions` RPC 描述（**待 master 在 crabot-docs 仓库独立提交**——sibling repo 边界）。
- **测试**：crabot-shared 29/29 + crabot-admin 341/342（1 pre-existing model-provider flake）+ crabot-agent 776/776 + crabot-admin-web 145/145，4 个包 tsc 0 errors。新增覆盖：14 个 cli-permission-gate hook 单测（含 reviewer-throws fail-closed）+ 6 个 cli-content-reviewer 单测（含 bracket-balance 解析）+ 11 个 unionResolved/unionCliPerm/unionStorage 单测 + 12 个 PermissionTemplateManager.cli_access 单测 + 4 个 resolve_principal_permissions REST 集成 + 1 个 cli-domains shared 单测套（覆盖大小写敏感）。
- **端到端验证（待 master 自跑）**：4 条路径 — (a) master 群聊 `crabot mcp toggle` 全权 / (b) master 私聊回归 / (c) group_scheduler 模板群里普通群友 `@crabot 提醒张三 3 点开会` 通过审核 / (d) 同群普通群友 `@crabot 3 点跑 rm -rf` 被审核拒。

## 上一里程碑（2026-05-07 — 模块恢复 & Self-Healing）

补齐"模块意外退出后的自动/人工/agent 恢复"能力。spec/plan：`crabot-docs/superpowers/plans/2026-05-07-module-recovery-and-self-healing.md`。

- **MM 自动重启**：`ModuleDefinition.auto_restart` 字段实装；指数退避 1s/2s/4s/8s/10s + 5min 内 3 次窗口限流；超限置 status=error 并发 module.health_changed；admin/agent/memory 内置模块默认开启。
- **DiskWatcher**：MM 启动 60s 周期检查 dataDir 所在挂载点剩余空间，跌破 1GB 阈值发 system.disk_low 事件（注入式 statfsFn 便于单测，状态去抖避免重复广播）。修因 5/7 凌晨 agent 静默猝死的根因——磁盘满 ENOSPC + 没 fatal handler。
- **Admin 端口缓存失效**：onEvent 订阅 module_stopped / module_health_changed → 清 agentPort / memoryModules 相应缓存；新增 callAgentRpc helper 在 ECONNREFUSED 时清缓存重试一次；4 个 agent trace handler 切到 helper，把不可达错误返 503 而非 500（修因 5/7 admin 接口报 500 的根因）。
- **Admin REST + Web UI**：新增 `GET /api/modules`、`GET /api/modules/:id/log?tail=N`（读 data/logs/<id>.log）、`POST /api/modules/:id/restart`；admin web `/modules` 页加运行状态面板（5s 轮询 + 着色状态 + 查看日志弹窗 + 重启确认）。
- **Self-healing recovery 任务**：agent module_started(restart_count>0) 触发 admin runSelfHealingForAgentRestart：扫所有 status=executing 任务标 failed → 用 buildRecoveryTask 纯函数构造 recovery worker 任务（tags=['recovery'], priority=high, source.origin=system）→ handleCreateTask + saveData。防雪崩：跳过 tags 已含 'recovery' 的 in-flight，避免 recovery 任务自身崩了无限派生。
- **协议变更**：`protocol-module-manager.md` §6.0 加 auto_restart 字段定义 + §6.1 行为详细说明 + §4.3 system.disk_low 事件 schema + 内置模块示例 yaml；`protocol-admin.md` Task 类型尾追加 Recovery Task 约定（标识/来源/优先级/防雪崩/任务描述）。
- **测试**：crabot-core 69/69 + crabot-admin 316/317（pre-existing model-provider 失败跟本次无关）+ admin-web 145/145 + RestartPolicy/DiskWatcher/RecoveryHandler/agent-port-cache/module-rest-api 5 个新单测文件。
- **配套兜底（5/7 同期）**：crabot-agent main 入口加 process.on('uncaughtException'/'unhandledRejection') → 写 ${DATA_DIR}/fatal.log 后 exit(1)；MM 子进程 stdout/stderr 同步落到 ${DATA_DIR}/logs/<moduleId>.log（保留 console 转发用于 dev 体验）。

## 上一里程碑（2026-04-30 — 原生飞书 Channel）

新增 `crabot-channel-feishu` 模块，飞书接入脱离 OpenClaw shim，扫码 onboarding 完整 Web 流程。spec：`crabot-docs/superpowers/specs/2026-04-30-native-feishu-channel-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-30-native-feishu-channel.md`。

- **新增模块 `crabot-channel-feishu`**：基于 `@larksuiteoapi/node-sdk` v1.62.1 长连接事件订阅。结构 = wechat 模块的飞书翻译版（types / SessionManager / MessageStore / event-mapper / FeishuClient / WsSubscriber / FeishuChannel / main）。支持 text/image/file 收发 + mention/quote 特性 + 6 类 IM 事件（im.message.receive_v1 + bot/user 群成员变更 + chat.updated）。WSClient onReady/onError/onReconnecting 状态对接 health。
- **协议化扫码 onboarding**（`base-protocol.md` §10 + `crabot-module-spec.md` §3.2）：新增 `onboarding_methods` 字段，模块声明交互式配置入口；`crabot-shared` 导出 `Onboarder` 接口（begin/poll/finish/cancel），handler 文件 export `createOnboarder()`。**onboarder 由 channel 模块自带**（不在 admin 内嵌平台知识），admin 仅做 UI 编排。
- **channel-feishu/src/onboard.ts**：实现 `Onboarder`，飞书设备码 OAuth（`POST /oauth/v1/app/registration` init/begin/poll）。
- **Admin OnboardingManager**：启动时扫 builtin yaml.onboarding_methods，require(handler) 加载 onboarder 缓存；通用 REST 路由 `/api/channels/onboard/(begin|poll|finish|cancel)`，body 带 `implementation_id` + `method_id`；admin 在 finish 收到 onboarder 返回的 env 后调 `channelManager.createInstance`。SSE 走 `?token=` query string 鉴权。
- **Admin Web UI**：`/channels/new` 数据驱动 picker（按每个 implementation × onboarding_methods 渲卡片 + 各 implementation 独立"手动填写"卡），`/channels/new/:implId/:methodId` 通用 onboarding 页（按 `ui_mode = qrcode/redirect/pending` 切换 widget）。
- **BUILTIN_MODULE_PATHS** 增加 `'../crabot-channel-feishu'`，channel-host 保留过渡期。
- **测试**：channel-feishu 52/52（含 11 个 onboard tests）+ admin 301/301 + admin-web 145/145，0 tsc 错误。

## 上一里程碑（2026-04-29 — Time Awareness）

让 Agent 拥有持续的时间感知能力。spec：`crabot-docs/superpowers/specs/2026-04-29-time-awareness-design.md`。

- **新增 `crabot-agent/src/utils/time.ts`**：`resolveTimezone`（含 IANA 校验 + env / Asia/Shanghai 三级 fallback）、`formatNow`（完整：日期+周+时分秒+offset+IANA）、`formatToolTimestamp`（紧凑：HH:MM:SS / 跨日 MM-DD HH:MM:SS）、`formatChannelMessageTime`（同日 HH:MM / 跨日 MM-DD HH:MM / 跨年 YYYY-MM-DD HH:MM）、`formatTaskCreatedAt`。
- **AgentInstanceConfig 加 `timezone?: string`**：admin types + agent-manager updateConfig 透传 + handleGetAgentConfig 通过 `...config` spread 自动透传给 Agent；web AgentInstanceConfig 镜像类型同步；Admin Web AgentConfig 页面加 timezone input（留空使用 Asia/Shanghai 默认）。
- **Tool result 时间戳前缀**：`tool-orchestration.ts:executeSingleTool` 所有返回路径（成功/Tool not found/Permission denied/Hook block/Tool execution error）统一在 content 前 prepend `[HH:MM:SS]\n`；`front-loop.ts` tool_result push 等价处理；`ToolCallContext` + `EngineOptions` 加 `timezone` 字段透传。
- **User message 顶部当前时间**：`buildUserMessage`（front-handler）和 `buildTaskMessage`（worker-handler）顶部拼 `当前时间: 2026-04-29 周三 18:30:00 +08:00 (Asia/Shanghai)`，作为日期/时区基准。
- **Channel 消息渲染统一**：抽 `prompt-manager.ts:formatChannelMessageLine`，Front recent_messages、Worker recent_messages、Worker trigger_messages 全部切到统一函数（之前 trigger 带 ISO、recent 不带的不一致已修复）。
- **任务字段调整**：Front handler 任务级别"执行已 X 秒"改"创建于 HH:MM"（绝对时间、cache 友好）；保留"第 N 轮"和工具级别"已 X 秒"。
- **System prompt 时间约定**：`FRONT_RULES_SHARED` 和 `WORKER_RULES` 各加"## 时间感知"段，约 80 tokens，被 cache，说明 user message / tool_result / 历史消息 / 任务字段的时间格式语义。
- **测试**：crabot-agent 573/573 + crabot-admin 298/298 + crabot-admin-web tsc 0 errors。手动验证：buildUserMessage 输出含 "[11:57] / [04-28 11:27]" 跨日切换；executeToolBatches 输出含 `[HH:MM:SS]\n<output>` 头部；invalid timezone 自动 fallback Asia/Shanghai。
- **已否决方案**：ephemeral marker（不写回历史无锚点）、每工具自己加（30+ 工具维护成本）、完整格式（p99 增量 1568 tokens 偏大）、按工具选择性（复杂度收益比不划算）、Hermes 式 system prompt 一次性注入（长任务跨小时失准）。

## 上一里程碑（2026-04-28 — Simplify Agent MCP/Skill Config）

砍掉 Agent 实例配置里的 `mcp_server_ids` / `skill_ids` 维度——这一层从来没被 Admin Web UI 暴露过（AgentConfig.tsx 是 unified 单页，没 instance/role 选择入口），数据模型表达 per-instance 灵活性但 UI 没对应入口暴露，是虚假能力。改成全局启用层：MCP/Skill 在各自管理页 enable/disable，所有 agent 实例共用。spec：`crabot-docs/superpowers/specs/2026-04-27-simplify-agent-mcp-skill-config-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-27-simplify-agent-mcp-skill-config.md`。

- **types.ts**：`AgentInstanceConfig.mcp_server_ids/skill_ids` + `UpdateAgentConfigParams.mcp_server_ids/skill_ids` 标 `@deprecated`，软迁移保留兼容期，运行时忽略。
- **handleGetAgentConfig**：返回的 `mcp_servers` / `skills` 改为 `manager.list().filter(s => s.enabled)`（单一真相），不再做"用户绑定 + 内置"两路合并。
- **9 个 mcp/skill REST handler 加 push trigger**：`triggerPushAfter(reason)` 私有 helper + fire-and-forget，每次 mcp/skill 注册/更新/启用/禁用/删除/导入后通过 `pushConfigToAgentModules` 推到运行中的 Agent。新增 4 mcp + 5 skill push trigger 单元测试。
- **AgentConfig.tsx**：移除 MCP/Skill 勾选 section，改为 read-only 列表 + react-router Link 跳转到 `/mcp-servers` 和 `/skills` 管理页；`mcp_server_ids` / `skill_ids` 从 `AgentUnifiedConfig` interface 移除。新增 5 个组件渲染测试。
- **Skills 管理页补 toggle UI**：之前只有 MCP 管理页有启用/禁用按钮，Skills 没有；加 `handleToggle` + `StatusBadge` 启用/禁用 pill + toggle button（仿 MCPServerList pattern）。复用现成 `<StatusBadge status="active|inactive">` 替换内联 rgba。
- **测试**：admin 全套 + admin-web 145/145 + tsc 0 errors，e2e 手动验证通过。

## 上一里程碑（2026-04-25 — Phase A 自学习反馈信号闭环）

修复长期记忆 v2 Observation 观察期 pass/fail 信号链路。设计核心：Front Handler 在 reply / create_task / supplement_task 工具上携带 `user_attitude` 字段（4 档 strong_pass/pass/fail/strong_fail）；代码层根据工具语义自动锚定 task_id（reply/create_task→prev finished task 同 channel/sender 30 分钟内；supplement_task→payload task_id）；调 memory.report_task_feedback 累加 observation_pass_count / observation_fail_count；maintenance.observation_check 按净值判定 pass/fail/extend。spec：`crabot-docs/superpowers/specs/2026-04-25-self-learning-feedback-signal-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-25-self-learning-feedback-signal.md`。

- **memory 侧 5 个 task**：lesson_task_usage 表 + observation_pass_count/fail_count 列；SqliteIndex 三个新方法（record/find/bump）；search_long_term 接 task_id 写表；report_task_feedback RPC + 三处分发表同步注册；maintenance.observation_check 按净值（pass-fail）判定。同步修了 stale_check_count >= 3 分支对 lesson/concept 写非法 maturity="stable" 的 pre-existing bug（按 type 分支：fact→stale / lesson→retired / concept→observation_stale tag）。
- **agent 侧 6 个 task**：types.ts 加 UserAttitude / UserAttitudeNegOnly 类型；front-tools.ts 给 3 个决策工具加 schema 字段；front-loop parseDecisionTool 解析 + 验证 enum；MemoryWriter.reportTaskFeedback fire-and-forget RPC；DecisionDispatcher dispatch 加 reportFeedbackIfPresent + findPrevFinishedTaskId 锚定钩子，删除旧 24h 时间窗 fail 路径；prompt-manager FRONT_RULES_SHARED 加 4 档判定引导（情绪用于判别不用于升级，fail 例子用"算了，就这样吧"避免"嗯，好吧"中性误判）。
- **协议文档**：protocol-agent-v2.md §5.4 加 user_attitude 字段表（含锚定对象映射 + 跳过条件）。同步发现 protocol-admin.md §3.22 误把 Front 决策工具列在 admin 协议里（架构分层错误），已拆分到 protocol-agent-v2.md §5.4 新增"Front Agent 决策工具实现"专节。
- **闭环真正收尾（Task 14）**：plan 当时把"Worker 召回时传 task_id"标了 Out of Scope，实际上不补这一环 lesson_task_usage 表永远不会被写入、整个反馈链路空跑。补 5 处：AssembleParams 加 task_id / FetchLongTermMemoryParams 加 taskId / assembleWorkerContext 透传 / fetchLongTermMemory 加守卫式 spread / decision-dispatcher.ts 创建 task 后传 task.id / mcp/crab-memory.ts MCP search_long_term 调 ctx.taskId。Front 端 tool-executor.ts 不动（Front 没 task_id）。
- **稳定 RPC ordering（I-1 fix）**：`find_lessons_used_in_task` SELECT 加 `ORDER BY lesson_id ASC`，避免 RPC report_task_feedback 返回值依赖 SQLite 隐式行序。
- **测试**：agent 477/477 pass + memory 233/233 pass（含 e2e dispatcher → memory RPC 链路 + 新增 context-assembler task_id 透传 2 测试），tsc 0 errors。
- **已知 follow-up**（不阻塞）：vote count 在 rollback/pass 后是否 reset（spec 未明示）；evolution mode 自动判定（spec §6.2 follow-up）；spec 文本说"maturity stable"应改为按 type 列举合法字面量；test fixture 重复（多个测试构造相同 store/idx/rpc 可提取）。

## 同期解决的前置 in-progress（2026-04-25）

- **N7 版本历史端到端**（spec §9.2）：数据/RPC/分发表/静态锁四层串通——store 旁路 `<id>.versions/v<n>.md`、`get_entry_version` RPC、move/purge 跟随 versions 目录迁移与清理；`tests/long_term_v2/test_rpc_spec_alignment.py` 静态扫 `module.py` 源码 `self._lt_v2_rpc.<name>` 引用集与 `LongTermV2Rpc` 公开方法集做差分，把"加了 RPC 忘了在分发表登记"这类盲区永久关掉。
- **N1-N10 测试覆盖第二轮**：spec §6/§7/§9/§10 细节口子 N1–N10 全部 ✅。修改既有 5 测试（test_maintenance/evolution/chain_of_note/rpc/rpc_update_phase3）+ 新增 6 测试文件（rule_promotion_e2e / pe_concurrent_write / pe_gated_recall_e2e / pe_gated_write_e2e / trash_cleanup_timezone / version_history_e2e）。同步 evolution.py spec §6.4 ≥3 case 晋升门槛硬约束。
- **Front prompt 防 XML mimicry**：原 worker capabilities 注入展开具体 tool 名（screenshot / mouse_click / git_status 等），某些模型（MiniMax-M2.5）看到后直接吐 `<invoke name="X">…</invoke>` 形式 XML 文本污染 reply。改为只列 category 名 + 加"工具调用硬性规则"段明示 Front 唯一可调用工具是 4 个决策工具。

## 上一里程碑（2026-04-24）

- **Memory v2 Phase 5 Admin UI 完成**：Admin Web 长期记忆管理页重做——一级 Tab（全部记忆/观察期）+ 类型/状态 Chips + 搜索 keyword/semantic + 批量操作 + 手动维护下拉 + 观察期面板替代 Proposals 审核（全自动路径）+ 详情 6 段 + 版本历史只读对比；MemoryEntriesPage 彻底清理；路由迁到 `/memory/long-term|short-term|scenes`。spec：`crabot-docs/superpowers/specs/2026-04-24-long-term-memory-admin-ui-design.md`，plan：`crabot-docs/superpowers/plans/2026-04-24-memory-v2-phase5-admin-ui.md`。24 task 全部完成，admin web 132 tests pass，tsc 无错。
- **Memory v2 全部 4 期落地**（2026-04-23）：Phase 1（数据模型 / 文件存储 / SQLite 索引 / v1→v2 迁移）+ Phase 2（6 步 hybrid 召回 + Eval harness）+ Phase 3（PE-Gated Write / Observation / Case→Rule / Frozen Snapshot / Evolution Mode）+ Phase 4（Admin UI 重做 + v1 路径清理 + 协议对齐）。Phase 4 共 22 task，1051 tests pass，验收记录见 `/tmp/memory-v2-acceptance.md`。

## 当前进行中：Agent Engine V2

**目标**：自研执行引擎，支持多 LLM 格式，内置工具，MCP 工具服务器  
**计划文档**：`crabot-agent/docs/plans/2026-04-03-engine-v2.md`  
**分支**：`feat/engine-v2`

### Phase 1 — 引擎核心 ✅ (2026-04-03)
10 个 engine 文件 ~1843 LOC, SDK 已移除, 93 tests

### Phase 2 — 多 LLM 格式 ✅ (2026-04-04)
OpenAI adapter, createAdapter factory, Front handler 迁移

### Phase 3 — 高级能力 ✅ (2026-04-04)
LLM auto-compact, sub-agent, permission system. 累计 200 tests

### Phase 4 — 核心内置工具 ✅ (2026-04-04)
Bash/Read/Write/Edit/Glob/Grep 6 个工具 + Worker 集成. 累计 203+49=252 tests
- [x] Task 17: Bash Tool (7 tests)
- [x] Task 18: Read Tool (8 tests)
- [x] Task 19: Write Tool (7 tests)
- [x] Task 20: Edit Tool (8 tests)
- [x] Task 21: Glob Tool (8 tests)
- [x] Task 22: Grep Tool (11 tests)
- [x] Task 23: Built-in Tools Index + Worker Integration (7 tests)

### Phase 5 — MCP 工具服务器 ✅ (2026-04-04)
Computer Use (12 tests), LSP (7 tests), Git (10 tests). 累计 285 tests
- [x] Task 24: Computer Use MCP (screenshot/mouse/keyboard)
- [x] Task 25: LSP MCP (TypeScript diagnostics, hover/definition stubs)
- [x] Task 26: Git MCP (status/diff/log/commit/branch/stash)

### Phase 6 — Admin 工具注册集成 ✅ (2026-04-04)
Built-in tool config, Skill tool, E2E integration. **全部 311 tests pass**
- [x] Task 27: Admin Built-in Tool Configuration (11 tests)
- [x] Task 28: Skill Execution Tool (5 tests)
- [x] Task 29: End-to-End Integration Test (10 tests)

### LSP 真实协议实现 ✅ (2026-04-04)
- [x] Task 30: LSP Client (JSON-RPC over stdio, 14 tests)
- [x] Task 31: LSP Server Manager (routing + file sync, 17 tests)
- [x] Task 32: LSP MCP Server rewrite (9 operations, 25 tests)

### 协议对齐 + 决策类型简化 ✅ (2026-04-04)
- [x] Task 33: Protocol docs alignment (7 处协议修改)
- [x] Task 34: Remove forward_to_worker → 4 种决策类型 (direct_reply, create_task, supplement_task, silent)
- [x] Task 35: Type alignment (ShortTermMemory, LongTerm, TaskSummary, Features, friend_id)
- [x] Task 36: Rename list_friends → list_contacts, add list_groups

### MCP 基础设施重构 ✅ (2026-04-04)
- [x] Task 37: crabot-mcp-tools 独立包 (Computer Use/LSP/Git stdio 入口)
- [x] Task 38: Admin MCP 注册表扩展 (stdio/streamable-http/sse + 内置注册)
- [x] Task 39: Agent McpConnector (多传输连接 + 工具转换)
- [x] Task 40: Skill 工具修复 (skillsDir 传递)

### Engine V2 重构完成 ✅
**总计**: 40+ Tasks, 298 tests (agent 298 + mcp-tools 2)
已合并到 main

---

## 已完成：去 LiteLLM 化 + ChatGPT 订阅 OAuth ✅ (~2026-04)

Agent V2 引擎直连 Provider 原生 API，LiteLLM 中间层完全移除（包括 dev.sh）。`createAdapter` 工厂按 `format` 路由到 Anthropic / OpenAI / Gemini / openai-responses。ChatGPT OAuth PKCE 落地，`buildConnectionInfo` 内部检测 token 过期并自动刷新。详见 [memory: project_remove_litellm.md](crabot-docs/memory)。

---

## 后续规划：权限系统打通

协议层完整定义，后端基础设施已有，但 Admin UI 和 Agent 工具权限未打通。

### 第一期 ✅ — 让当前能跑通（master 自用）
- [x] Worker 用 `bypass` 模式，所有工具可用
- [x] engine permission-checker 基础设施（allowList/denyList/bypass/callback）
- [x] deriveMemoryPermissions 已实现（master 无限制 / normal 按 session scope 过滤）
- [x] `ToolPermissionConfig.checkPermission` 回调接口支持路径级细粒度控制

### 第二期 — Admin UI 权限管理（让 master 能配置）
- [ ] 权限模板管理页面（CRUD 自定义模板，系统预设: master_private/group_default/minimal/standard）
- [ ] Friend 详情页增加权限模板选择器（permission_template_id）
- [ ] Session 配置页面（查看/编辑 permissions、memory_scopes、workspace_path）
- [ ] 内置工具管理页面（启用/禁用/权限级别覆盖，对应 BuiltinToolConfig）

### 第三期 — Agent 侧权限打通（让配置真正生效）
- [ ] 新增 `deriveToolPermissions(sessionPerms)` → `ToolPermissionConfig`
- [ ] Session.permissions.desktop → 控制 computer-use 工具
- [ ] Session.permissions.storage → 控制 Read/Write/Edit/Glob/Grep 路径
- [ ] Session.permissions.network → 控制 fetch/Bash 网络访问
- [ ] workspace_path → Worker task 沙箱根目录
- [ ] Worker 从硬编码 `bypass` 改为 `deriveToolPermissions` 动态计算

---

## 系统架构

```
Module Manager (port 19000)
├── Admin (RPC 19001, Web 3000)
│   ├── Friend / Permission 管理
│   ├── LLM Provider 管理（buildConnectionInfo 解析为 Provider 原生连接信息）
│   ├── MCP Server + Skill 注册表管理（全局管理 + Agent 配置引用）
│   ├── Agent 配置管理（含 MCP Server/Skill 关联）
│   ├── Web 管理界面 + Master Chat (WebSocket)
│   ├── 消息鉴权网关（channel.message_received → channel.message_authorized）
│   └── PTY 会话管理 + Web 终端 (/ws/pty/*)
├── Agent (port 由 MM 分配)
│   ├── Front Handler（快速分诊，默认 10 轮，3 次重试）
│   └── Worker Handler（深度执行）
├── Memory (Python, port 19002)
│   └── 短期/长期记忆（LanceDB 向量检索）
└── Channel(s)
    ├── 微信 / Telegram 原生模块
    └── OpenClaw Host Shim（crabot-channel-host/，跑 OpenClaw 生态插件）
```

## 端口分配

| 服务 | 端口 |
|------|------|
| Module Manager | 19000 |
| Admin RPC | 19001 |
| Admin Web | 3000 |
| Memory | 19002 |
| OpenClaw Host | 19003 |
| Agent | 19005+ |
| Vite Dev | 5173 |

---

## 已完成

- [x] Module Manager — 生命周期、端口分配、事件总线
- [x] Admin 模块 — Friend 管理、Task/Schedule、LLM Provider、Agent 配置、Master Chat、PTY 终端
- [x] Agent 模块 — 编排层 + Front/Worker Handler，多格式 LLM 适配器（Anthropic/OpenAI/Gemini/openai-responses）
- [x] Memory 模块 — 短期记忆读写、向量检索、管理界面
- [x] Channel 飞书 — 完整 protocol-channel.md 实现
- [x] Channel OpenClaw Shim — 插件兼容层，jiti 加载 TS 插件
- [x] 消息鉴权网关重构 — Channel 只发布原始消息，Admin 做 Friend 解析和鉴权，Agent 订阅 channel.message_authorized
- [x] MCP Server + Skill 系统 Phase 1 — 全局注册表（protocol-admin.md §3.16/3.17 扩充），Admin 后端 Manager（MCPServerManager/SkillManager/EssentialToolsManager），Admin 前端 CRUD 页面，Agent 配置 ID 引用解析
- [x] Agent Loop 可观测性 — 通用 Trace 规范（protocol-agent-v2.md §8），Ring Buffer TraceStore，前后端可视化 Trace/Span 树
- [x] Front Handler 工具调用改进 — 保留默认工具集，maxTurns 1→3，结果路由（JSON 决策/纯文本/工具失败自动升级），简单任务直接执行、复杂任务创建 task 派 Worker
- [x] Agent 模块 Skills/MCP/聊天历史/crab-messaging 修复 — Skills UI 简化，消息预加载量优化（Front 10 条 / Worker 20 条），crab-messaging MCP Server 5 工具实现，对齐 protocol-crab-messaging.md，路径安全验证，TypeScript 编译零错误
- [x] 记忆管理界面重构 — `/memory/entries` 条目页模式拆分（browse/search/context）、长期记忆 browse API、SceneProfile 详情强化（描述非空校验 + 来源记忆链接）、SceneProfile 治理视图、记忆→画像反向链接、`/memory` 路由精简为直接跳转条目页；前端/后端定向测试与浏览器自测已通过
- [x] McpServer Protocol reuse bug 修复 — Claude Agent SDK 在 Front Handler 重试或并发消息时抛出 "Already connected to a transport" 错误；根因是 `createCrabMessagingServer()` 在 `initializeAgentLayer()` 中只调用一次，所有 `runSdk()` 共享同一个 McpServer 实例，SDK 的 `Protocol.connect()` 不允许重复连接；修复方案：将传入的 `SdkMcpServerConfig` 对象改为工厂函数 `() => Record<string, SdkMcpServerConfig>`，每次 `runSdk()` 调用时创建新的 McpServer 实例；涉及文件：`unified-agent.ts`、`front-handler.ts`、`worker-handler.ts`，TypeScript 编译零错误
- [x] SwitchMap 私聊消息合并 — 同 session 新消息到达时，被中断的消息 A 与新消息 B 合并为 `[A, B]` 一起传给 LLM（协议 §5.1）；`SwitchMapHandler` 新增 `pendingBatches` 追踪批次；`unified-agent.ts` 三处调用点（`processDirectMessage`/`handleProcessMessage`/`processAdminChatMessage`）均更新；dispatch 前增加 abort 检查防止并发双发 reply
- [x] 群聊 Debounce 消息合并 + 群聊行为改进 — 群聊已通过 DebounceHandler 合并批次传给 Front Agent；新增 `SilentDecision` 类型；Front Agent 群聊默认静默，仅 @提及或明确提问时回复；提示词外部化到 `prompts.md`（根目录），修改后重启生效
- [x] Front/Worker Handler 系统性修复 — 修复 `maxTurns` 硬编码为 3 的 bug（现在正确读取 `maxIterations` 配置）；Front 默认轮数 3→10；Worker 默认无限制轮数（不传 `maxTurns`）；提示词明确区分"已预注入的上下文"与"需工具查询的更多历史"；`prompts-worker.md` 外部化到根目录
- [x] supplement_task 纠偏机制 — Front Agent 识别用户对活跃任务的纠偏/补充消息，通过 interrupt() + streamInput() 直接注入运行中的 Worker，支持 confidence high/low 路由
- [x] Worker 进度报告改进 — 基于实际工具调用的自然进度报告，避免 generic "执行中"；content-type 判断；进度与最终结果去重
- [x] 群聊决策质量优化 — buildUserMessage 群聊 prompt 改进（参与者列表、Crabot 身份标识、sender role 标注、silent 引导）；system prompt 群聊规则强化（"你是旁听者"）；context-assembler session type 修复
- [x] Agent Trace 可观测性增强 — full LLM input/output 记录到 trace span；群聊消息批次快照；Trace 磁盘持久化（daily JSONL）
- [x] Admin guest authorization 修复 — 群聊 guest 鉴权路径缺失 return 导致消息重复处理
- [x] Channel Host 主动推送 — 通过插件 outbound adapter 主动发送消息（不依赖入站消息的 pendingDispatch），支持跨渠道发送场景
- [x] 微信 @Crabot 检测 — 通过 at_string 检测群聊 @提及，缓存群昵称
- [x] crab_display_name 管线 — Admin → Agent 传递 Crabot 在 channel 上的显示名
- [x] PromptManager 统一提示词管理 — 提示词分三层（personality / rules / additions），`data/agent/prompts/` 目录统一管理，Handler 不再自行加载提示词文件
- [x] 端到端集成测试 — 飞书/OpenClaw → Agent → 回复完整链路，验证群聊静默、私聊合并等新行为

---

## 待实现

### 🟡 中优先级

| 功能 | 说明 |
|------|------|
| AgentConfig `extra` 字段 | 支持热更新扩展配置，Admin UI key-value 编辑器 |
| 短期记忆压缩 | 保留窗口 + 语义无损压缩 |
| 长期记忆去重/合并 | CREATE/UPDATE/MERGE/SKIP 决策 |
| 混合检索 | 语义 + BM25 + 元数据多路召回 |
| MemoryBrowser 测试 OOM | `crabot-admin/web/src/pages/Memory/MemoryBrowser.test.tsx` 在当前 Vitest 环境下触发 worker out of memory，需后续拆分或瘦身测试 |
| Permission Template CRUD | 权限模板管理 |

### 🟢 低优先级

| 功能 | 说明 |
|------|------|
| Worker 多实现 | worker-code (claude-agent-sdk), worker-general (pydantic-ai) |
| Agent 自我进化 | 代码生成、自动测试 |
| Channel 微信 / Slack | 更多平台适配 |

---

## 运行命令

```bash
./dev.sh          # 构建 TS + 启动所有服务 + Vite HMR (5173)
./dev.sh stop     # 停止所有进程
./dev.sh build    # 只构建不启动
./dev.sh vite     # 只启动 Vite
```
