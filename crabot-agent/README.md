# Crabot Unified Agent Module

合并 Flow + Agent 的统一智能体模块，提供消息编排和智能体执行能力。

## 架构

```text
crabot-agent/
├── src/
│   ├── core/                          # 基础协议和工具
│   │   ├── base-protocol.ts           # 基础协议类型
│   │   ├── module-base.ts             # 模块基类
│   │   └── rpc-client.ts              # RPC 客户端
│   │
│   ├── orchestration/                 # 编排层 (原 Flow)
│   │   ├── session-manager.ts         # 会话状态管理
│   │   ├── switchmap-handler.ts       # switchMap 消息合并
│   │   ├── permission-checker.ts      # 权限决策树
│   │   ├── worker-selector.ts         # Worker 负载均衡
│   │   ├── context-assembler.ts       # 上下文组装器
│   │   └── decision-dispatcher.ts     # 决策分发器
│   │
│   ├── agent/                         # 智能体层 (原 Agent)
│   │   ├── llm-client.ts              # LLM 客户端
│   │   ├── tool-registry.ts           # 工具注册表
│   │   ├── agent-loop.ts              # Agent Loop 引擎
│   │   ├── front-handler.ts           # Front Agent 处理器
│   │   └── worker-handler.ts          # Worker Agent 处理器
│   │
│   ├── unified-agent.ts               # 主类 (整合编排 + 智能体)
│   ├── types.ts                       # 类型定义
│   ├── config.ts                      # 配置管理
│   └── main.ts                        # 入口
│
└── tests/                             # 测试
    ├── orchestration/                 # 编排层测试
    ├── agent/                         # 智能体层测试
    └── integration/                   # 集成测试
```

## 特性

### 编排层 (原 Flow)
- 消息路由和流程编排
- 权限检查 (私聊/群聊/未知发信人)
- switchMap 消息合并
- 上下文组装 (并行获取数据)
- Worker 负载均衡
- 决策分发

### 智能体层 (原 Agent)
- Front Agent: 快速分诊 (2-3 轮迭代)
- Worker Agent: 任务执行 (无限迭代)
- 多模型支持
- 工具注册和执行
- MCP 集成

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build

# 运行测试
npm test

# 测试覆盖率
npm run test:coverage
```

## 配置

参考 `config.example.yaml` 进行配置。

主要配置项：
- `orchestration`: 编排层配置
- `agent_config`: 智能体层配置

## Feature flags

### `CRABOT_USE_UNIFIED_LOOP`（Phase 3c+）

环境变量，控制是否启用统一 agent loop（合并 Front + Worker 的新架构）。

- `CRABOT_USE_UNIFIED_LOOP=true` → 私聊路径走 `WorkerHandler.handleTriggerMessage`（exit tools + overdue + send_message 检测）
- 未设置或其他值 → 走原 `FrontHandler.handleMessage` → `decisionDispatcher` 路径（默认）

**当前限制（Phase 3c）：**
- 仅切换私聊路径；群聊仍走旧路径（Phase 3e 切换）
- handleTriggerMessage 已接入 messaging tools 与 exit tools；**复杂任务所需的 bash / file / lsp / skill / sub-agent 等工具尚未接入**，复杂任务在 ON 模式下会失败（Phase 3d 接入完整工具集）
- 启用后可端到端测试：简单 reply / supplement_task / 超期辅助提醒三条主路径

本地测试：

```bash
CRABOT_USE_UNIFIED_LOOP=true ./dev.sh
```

## 协议版本

- v0.2.0: 合并 Flow + Agent
- 兼容 protocol-agent.md v0.1.0 接口签名

## License

Apache-2.0
