---
name: memory-curate
description: "记忆整理：扫 inbox 候选，去重 + 多因子打分，高分高置信晋升 confirmed。仅当任务标题以'记忆整理'开头或 trigger=memory_curate 时使用，与 daily-reflection 互斥（daily-reflection 用于深度反思，会读 trace 并委派 sub-agent）。"
version: "2.0.0"
---

# 记忆整理 Skill

## Overview

每小时（默认）跑一次：扫近期 inbox 中的 fact/lesson 候选，做去重 + 多因子打分。
高分 + 高置信 → `update_long_term` 升级到 confirmed；
低分 / 模糊 → 留给 daily-reflection 深加工。
**这是机械整理，不是反思**：仅做去重 hash 比对、IDF / entity_priority / 高 proximity 阈值过滤，不调贵 LLM、不读 trace、不委派 sub-agent。

## 流程

### Step 1：拉 inbox 候选

```
mcp__crab-memory__search_long_term({
  query: "*",
  filters: { status: "inbox" },
  k: 50,
  include: "brief"
})
```

> 现实现需要查询字符串；可用 `"recent"` 占位 + filters 过滤。如不够，用 `mcp__crab-memory__list_recent({ window_days: 1 })` 拉最近 24 小时新增的全部条目。

### Step 2：去重

按 `(type, brief 前 40 字 hash)` 分组：
- 同组 ≥ 2 条且 author 一致 → 保留最新一条，其余 `delete_memory`（进 trash）
- 不同 author 同 hash → 不动，留 daily 处理

### Step 3：多因子打分

对每条 inbox 候选，计算分数：

```
score = 0.4 * importance_factors.proximity
      + 0.3 * importance_factors.surprisal
      + 0.2 * importance_factors.entity_priority
      + 0.1 * importance_factors.unambiguity
```

### Step 4：晋升决策（无 LLM，按 type 分流）

> 设计原则：默认门槛保持 spec §6.1 的严格水平，但给"特征强烈"的 fact 增加两条 OR 通道，避免高 importance / 项目实体类 fact 因为 confidence 默认 3 永远卡 inbox。lesson 单条不晋升，case→rule 是 daily-reflection 第九步职责。

**对 `type=fact` 或 `type=concept` 候选**，满足任一条件即晋升 confirmed：

| 通道 | 条件 |
|---|---|
| **A 默认门槛**（spec 原通道） | `score >= 0.75 AND content_confidence >= 4` |
| **B 高 importance 单独通道** | `surprisal >= 0.9 AND content_confidence >= 3` |
| **C 项目实体单独通道** | `entity_priority >= 0.7 AND len(tags) >= 2 AND content_confidence >= 3` |

晋升动作（设观察期）：

```
update_long_term({
  id,
  patch: {
    maturity: "confirmed",
    observation: { started_at: <现在>, window_days: 7, outcome: "pending" },
  },
})
```

工具层会在 maturity 升到 confirmed 且 status='inbox' 时自动把文件迁到 `confirmed/<type>/`（无须再 patch status）。

**对 `type=lesson` 候选**（maturity=case 的反思产物）：

| 条件 | 动作 |
|---|---|
| `score < 0.3` | `delete_memory({ id })`（明显噪音，进 trash） |
| 其他 | **保留在 inbox**，**不单条晋升**——case→rule 涌升由 daily-reflection 第九步按 ≥3 source_cases 门槛走 `promote_to_rule` 处理 |

> 为什么 lesson 不走单条晋升：spec §6.4 的 rule 是从 ≥3 同 scenario case 抽象出来的**新条目**（写到 `confirmed/lesson/<rule_uuid>.md`，原 case 留 inbox 作实证）。单条 case 直接改 maturity=rule 会产出无 source_cases 依据的低质量 rule。

**剩余动作（fact / concept / lesson 共用）**：

| 条件 | 动作 |
|---|---|
| `score < 0.3` | `delete_memory({ id })`（进 trash） |
| 其他 | 留给 daily-reflection |

### Step 5：报告

输出本次：处理候选数、晋升数、丢弃数、留待 daily 数。
**不汇报 master**（频率高、信号弱）。
