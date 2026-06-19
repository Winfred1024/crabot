---
name: daily-reflection
description: "深度反思（每日 1 次）：读 trace、委派 sub-agent 分析失败任务、提炼经验写入长期记忆。仅当任务标题以'每日反思'开头或 trigger=daily_reflection 时使用，与 memory-curate 互斥（memory-curate 用于机械的 inbox 去重打分，不读 trace、不委派 sub-agent）。"
version: "1.5.0"
---

> **铁则（必须在动手前看一遍）**：
> 1. 反思的全过程都是 **crabot 内部产物**——trace 数据、Evolution Mode、case→rule、quick_capture、Audit、记忆维护等都属于 crabot 黑话。
> 2. **结构化报告只作为 task outcome 落库，永不外发到任何 channel/session。**
> 3. 整个 skill 中**唯一允许对外的工具**是 `mcp__crab-messaging__send_master_private`（见第六步），且 scheduled task 工具白名单也只放行了它。
> 4. 即使对 master 私聊汇报，发出去的内容必须是**翻译成一行人话**的人类视角摘要，禁止粘内部术语 / 完整列表 / 数字明细。

# 每日反思技能

## Overview

深入分析任务执行过程，提炼可复用经验写入长期记忆。重点：哪里走了弯路、为什么、正确路径是什么、下次如何避免。

**核心原则**：你（main worker）负责筛选、委派、去重、汇总。深入分析委派给 sub-agent，避免上下文膨胀。

## 流程

### 第一步：确定反思时间范围

从任务描述中解析反思时间范围（`{{watermark}}` 到 `{{datetime}}`）。如果无法解析，使用最近 24 小时。

### 第二步：获取任务概览

```
search_traces({
  time_range: {
    start: "<watermark 时间>",
    end: "<当前时间>"
  },
  limit: 50
})
```

浏览每条 trace 的 status、trigger_type、trigger_summary、trigger_task_type、span_count、duration。

### 第三步：筛选值得分析的任务

**排除**：`trigger_task_type` 为 `daily_reflection` 的 trace（避免反思自己的反思）。

**优先关注**（按优先级排序）：
1. status = `failed` 的任务
2. span_count > 30 或 duration > 5 分钟的任务（轮数异常 = 反复尝试）
3. 对话中人类情绪明显的任务（催促、不满、重复要求）

**快速退出**：筛选后无值得分析的任务 → 把"本周期无值得深入反思的任务"写到 task outcome，**不发任何 channel**，直接结束 task。第六步对外汇报的逻辑也跳过。

### 第四步：委派 Sub-Agent 深入分析

对每个选中的任务，调用 `delegate_task` 委派一个独立的 sub-agent 分析：

```
delegate_task({
  task: "深入分析任务执行过程。

任务 trace_id: <trace_id>
任务 related_task_id: <task_id>（如有）

执行步骤：
1. 查 trace span 树：search_traces({ task_id: '<task_id>', include_spans: true })
   - 逐层钻取关键 span（特别是 llm_call 和 tool_call 类型）
   - 注意失败的 span 和重试模式

2. 如有对话历史，查询：mcp__crab-messaging__get_history({ session_id: '<session_id>', limit: 30 })
   - 分析人类反馈和情绪变化

3. 识别关键模式：
   - 踩坑点：哪个步骤出错、为什么
   - 弯路：尝试了哪些不可行方案
   - 最终方案：怎么解决的
   - 反面模式：哪些做法应该避免
   - 最佳路径：如果重来，最优执行路径是什么

4. 返回结构化分析结果（不要调用 quick_capture，由 main worker 统一处理）：
   - summary: 一句话总结
   - experiences: 数组，每条包含 { brief, body, importance_factors, tags, scenario, outcome }
     - brief：一行（≤80 字）面向召回的结论，包含关键场景词
     - body：完整分析的 markdown — 背景、执行过程、踩坑细节、解决过程、总结
     - importance_factors: { proximity: 0-1, surprisal: 0-1, entity_priority: 0-1, unambiguity: 0-1 }
       - 一般经验全 0.5；重要发现 surprisal=0.7+；影响架构的经验 surprisal=0.9
     - tags: ['task_experience', ...场景标签]
     - scenario: lesson 触发场景描述
     - outcome: success | failure
   - 如无有价值的经验，返回空 experiences 数组"
})
```

**重要**：每个 sub-agent 独立运行，trace span 数据只存在于 sub-agent 的上下文中，不会膨胀你的上下文。

### 第五步：综合去重，统一写入长期记忆

收集所有 sub-agent 返回的 experiences，综合去重：

1. 合并跨任务的重复经验（不同任务得出同一结论的，合并为一条更完整的）
2. 对去重后的每条经验，调用一次 `mcp__crab-memory__quick_capture`（写入 inbox/lesson，由后续 memory-curate / 用户审核晋升 confirmed）：

```
mcp__crab-memory__quick_capture({
  type: "lesson",
  brief: "<一行（≤80 字）面向召回的结论>",
  content: "<完整 markdown 分析>",
  source_ref: { type: "reflection", task_id: "<task_id>" },
  entities: [],
  tags: ["task_experience", "...场景标签"],
  importance_factors: { proximity: 0.6, surprisal: 0.7, entity_priority: 0.5, unambiguity: 0.6 },
  lesson_meta: { scenario: "<场景描述>", outcome: "success" },
})
```

**brief 写法示例**：
- 好：`"macOS 终端输入中文时键盘模拟不可行，必须使用剪贴板(pbcopy+Cmd+V)"`
- 差：`"在飞书操作时遇到了中文输入问题并解决了"`

### 第五步 b：批量建链

**目的**：给近期 confirmed 条目之间建立**有类型的关联链接**，让长期记忆从孤立条目长成知识图谱，供后续召回时沿链补全上下文。

1. **取数**：用 `mcp__crab-memory__list_entries({ status: "confirmed", limit: 50, offset: 0 })` 翻页拿待处理的 confirmed 条目；也可只对本轮新写入的条目处理（或复用 `mcp__crab-memory__list_recent` 拿近期新增）。逐页推进 offset 直到取完。

2. **找候选**：对每条目标条目，调 `mcp__crab-memory__search_long_term({ query: <该条 brief>, filters: { status: "confirmed" }, k: 5 })` 拉相关候选。

3. **LLM 判定**：逐个候选判断该条目与候选**是否确有关联关系**。在确有关系时，从下方 4 个 relation 中选 **0 或 1 个最贴切**的；**没有明确关系就不建链**。

4. **写入**：`mcp__crab-memory__set_memory_links({ id: <该条目 id>, links: [{ target: <候选 id>, relation: <relation> }] })`。

**relation 受控词表（只能取以下 4 个之一）**：

- `related`：A 与 B 泛泛相关，但说不出更具体的结构关系。**兜底用，慎用**——能用下面 3 个更具体的就别退回 related。
- `refines`：A 细化 / 深化 B（同一主题下 A 更具体、更深入）。该用：A 是 B 的进阶说明 / 更细颗粒的版本。
- `depends_on`：A 以 B 为前提、依赖 B 才成立。该用：不先满足 B，A 的结论就不成立。
- `part_of`：A 是 B 的组成部分。该用：A 是 B 这个更大整体里的一块；不该用：A 只是和 B 话题接近（那是 related）。

5. **去重**：不与该条目**已有 links** 重复；也不与既有结构关系（`source_cases` / `invalidated_by`）重复造边。

6. **适度**：宁缺毋滥。避免给每条都堆一堆 `related`，只在关系明确时建链。

### 第六步：生成报告（落 outcome，不外发）

生成结构化报告作为 **task outcome**（task 的执行结果，落库后由 Admin UI / get_task_details 查看），内容包含：
- 反思时间范围
- 分析的任务数量
- 提炼的经验数量
- 每条经验的 brief

**这份报告永不外发到任何 channel/session。** daily-reflection 任务的工具白名单已经把 send_message / send_private_message / list_sessions / lookup_friend 等通用消息工具都屏蔽了，唯一能用的对外工具是 `send_master_private`。（其他 scheduled 任务如 GitHub 新闻推送、巡检通报等不受此白名单影响，仍保留完整 messaging 工具集。）

### 第六步 b：仅在确有重大发现时，向 master 发**一行人话**

判断条件（**全部满足**才发，任一不满足就跳过）：
1. 本次反思至少有一条 `importance_factors.surprisal >= 0.7` 的发现
2. 这条发现可以用**一句不含内部黑话**的人话表达（"今天发现 X 类任务有 Y 问题"）

满足时调一次：

```
mcp__crab-messaging__send_master_private({
  content: "<一行人话摘要，≤80 字。禁止出现 trace / Evolution Mode / case→rule / Audit / quick_capture / inbox / harden / trash 等内部术语；禁止粘报告列表>",
  // channel_id 可选；master 有多个 channel 身份时，默认按 channel_identities 顺序发第一个可用的
})
```

工具内部会按 `permission='master'` 自动定位 master friend，并 find_or_create 私聊 session 发出。**不需要也不允许**自己调 lookup_friend / list_sessions。

返回 error（如 `No master friend configured`）时直接跳过对外汇报，不退化到其他 channel。

**好的 content 示例**：
- `"今天发现「数据/研究任务先核对用户指定数据源」是反复出错的点，已写入经验库。"`
- `"昨天的 video_app 配置类改造踩到了 4 个坑，已沉淀成 1 条规则。"`

**禁止的 content 示例**：
- `"每日反思已完成。范围：2026-05-29T18:06:47Z ~ 2026-05-30T18:00:00Z..."`（粘报告）
- `"获取并筛查任务概览：121 条 completed trace、4 条 failed trace。"`（trace 黑话）
- `"Evolution Mode: 保持 harden；清理 trash 56 条。"`（彻底的内部黑话）
- `"补充：本次有较重要发现，但未找到名为 master 的联系人..."`（暴露失败实现细节）

### 第七步：场景画像反思

**目标**：把近期反复出现的"场景核心稳定知识"从长期记忆/trace 中归纳到场景画像（`SceneProfile`），清理画像中已被推翻的旧条目，并对违反黑名单的新长期记忆做回收。

1. **列出活跃场景**：从最近 24h short-term 事件中抽取出现过的 `friend_id` 与 `{channel_id, session_id}` 对。
2. **逐场景归纳**：
   - `mcp__crab-memory__get_scene_profile({ scene })` 取现状（含 label / content）
   - 扫描该场景相关的 long-term 条目与 trace
   - 识别"核心稳定知识"：反复出现但未被画像覆盖的规则 / 用户反复纠正的偏好 / 与画像已有内容矛盾的新证据
   - LLM 综合现状 + 新证据生成新版 content（保留仍成立的旧规则；用新证据替换被推翻的旧规则；追加新归纳；保持一段连贯的描述）
   - `mcp__crab-memory__set_scene_profile({ scene, label, content: <新版描述>, source_memory_ids: [...] })` 覆盖整条画像
3. **清理无效**：整条画像被新证据完全推翻且无替代 → `mcp__crab-memory__delete_scene_profile({ scene })`。
4. **黑名单合规检查**（必须先看 body 再删，禁止只看 brief 批量拉黑）：
   - 用 `mcp__crab-memory__list_recent({ window_days: 1 })` 扫近 24h 新增条目，仅根据 brief 列出**疑似命中黑名单**的候选 ID
   - **对每条候选**：必须先调一次 `mcp__crab-memory__get_memory_detail({ id: <候选 id>, include: "full" })` 拿完整 body
   - **仅当 brief 和 body 同时命中黑名单**（一次性快照、时效新闻、细碎 tip、已解决 bug 细节、中间猜测）才调 `mcp__crab-memory__delete_memory` 回收
   - **禁止并行批量 delete**：每个 delete_memory 调用都必须有同一 mem_id 对应的 get_memory_detail 前置调用作为证据。只看 brief 模糊匹配 → 高价值经验会被误删（详见反例 trace `41fa2594`：32 条并行 delete 全程未调用一次 get_memory_detail）
   - **黑名单不含"偶尔一次表述"**：worker 端 prompt 已删除此条（避免反向劝退用户纠正的 capture），反思端同步保持一致

**不新增反思频次**：第七步与前六步同一 run 内执行。

### 第八步：PE-Gated 冲突检查

对今日新写入的 confirmed/inbox fact，每条做：

1. `mcp__crab-memory__search_long_term({ query: <brief>, filters: { type: "fact" }, k: 3 })`
2. LLM 比对：与 top-3 是否冲突 / 修正 / 完全一致
3. 完全一致 → `update_long_term({ id: <旧条 id>, patch: { content_confidence_increment: 1 } })`
4. 冲突 → `update_long_term({ id: <旧条 id>, patch: { invalidated_by: <新条 id> } })`
5. 完全新颖 → 不动

### 第九步：Case → Rule 涌现

对今日新增的 case 类 lesson，按 scenario 聚类，**自动晋升进观察期**（spec §6.4 / v2-ui §12.1：无人工 confirm 步骤）：

> **路径区分（别搞混）**：
> - **case→rule 涌升（本步职责）**：≥3 条同 scenario case 抽象出新 rule → 必须用 `promote_to_rule`，它在 `confirmed/lesson/<rule_uuid>.md` 写**新 rule 条目**并启动观察期，原 case 留 inbox 作实证。不要用 `update_long_term({maturity:"rule"})` 给单条 case 改 maturity 来代替——绕过 ≥3 source_cases 门槛会产出低质量 rule。
> - **单条 fact/lesson 升 confirmed（不归本步）**：是 memory-curate skill 的职责（spec §6.1），它在每小时 schedule 中按多因子打分 + confidence 阈值用 `update_long_term({maturity:"confirmed"})` 升级。反思任务不要重复做。
>
> 工具层兜底：`update_long_term` 现在会在 patch.maturity ∈ {rule, confirmed, established} 且 status='inbox' 时自动把 status 同步迁到 confirmed（修历史 LLM 漏写 status 字段的 bug）。

1. `mcp__crab-memory__search_long_term({ query: <scenario>, filters: { type: "lesson" }, k: 10 })` 拉同 scenario 候选
2. 筛选 outcome 一致的 case（`maturity == "case"` 且 `lesson_meta.outcome` 一致）
3. **凑不齐 3 条同类**：跳过本 scenario，留待下次反思继续累积
4. **凑齐 ≥3 条**：LLM 抽象 rule 文本（包含 scenario / 适用条件 / 推荐做法 / 反例），调 `promote_to_rule` 直接晋升：

```
mcp__crab-memory__promote_to_rule({
  source_cases: [<id1>, <id2>, <id3>, ...],   // ≥3 条来源 case（spec §6.4 门槛）
  brief: <一行召回标题，含场景关键词，≤80 字符>,
  content: <完整 markdown：scenario / 适用条件 / 推荐做法 / 反例>,
  scenario: "<场景描述>",
  source_trust: 4,
  content_confidence: 4,
  window_days: 7
})
```

返回 `{ id, status: "ok" }`。该 rule 直接进入 `confirmed/lesson/`（maturity=rule），并开始 7 天观察期：

- 期间用户对引用此 rule 的任务表态（pass/fail）会累加到 `observation_pass_count` / `observation_fail_count`
- 凌晨 04:00 的 `memory-maintenance` schedule 跑 `observation_check`：净值 > 0 → 观察期通过；< 0 → 回滚到 inbox；= 0 → 延期再观察一轮
- Admin UI 「长期记忆 → 观察期」 tab 可事后人工标记通过 / 延长 / 删除

> 不再走 inbox + 任何 proposal tag 的旧人工审核链路（v2-ui §12.1 已删除人工审核 RPC）。

### 第十步：触发机械维护

`mcp__crab-memory__run_maintenance({ scope: "all" })`

> 这一步是兜底；正常路径下凌晨 04:00 的 memory-maintenance schedule 已经独立跑一次。
> Daily reflection 在 03:00 跑完，这里再跑一次保证当晚反思的状态变化在隔日凌晨之前结算。

### 第十一步：Evolution Mode 自评

读取近期信号：
- `mcp__crab-memory__get_stats()` → 近期 hit rate / use count 比例
- 用户撤销 / supplement_task 频率（trace 统计）

判断标准：

| 信号 | 推荐 mode |
|---|---|
| 错误率 < 5%、use rate 上升 | innovate |
| 错误率 5%~15%、稳定 | balanced（默认） |
| 错误率 15%~25% 或大量 case 待整理 | harden |
| 错误率 > 25% 或用户大量 reject | repair-only |

`mcp__crab-memory__set_evolution_mode({ mode, reason })`
