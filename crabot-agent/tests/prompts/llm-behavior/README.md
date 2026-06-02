# LLM behavior harness

跑真 LLM 验证 prompt 改动后的实际行为（不只是 prompt 文本断言）。

## 默认 skip

这些测试 **默认 skip**——它们消耗 API token、依赖本机 `data/admin/model_providers.json` 配置，不该进 CI。

手动跑：

```bash
cd crabot-agent
CRABOT_LLM_BEHAVIOR_TEST=1 pnpm exec vitest run tests/prompts/llm-behavior/ --reporter=verbose
```

## 它做了什么

- 读 `data/admin/model_providers.json` + `global_model_config.json` 拿默认 provider（跟当前 agent 模块跑的同款）
- 用真实的 `assembleAgentPrompt` + `renderActiveTasksSection` 拼 prompt（**测的就是这套真实渲染**，不重写）
- 列出关键工具的 schema（search_memory / search_traces / get_task_details / send_message）
- 调一次真 LLM，dump:
  - prompt 全文（验证 SELF marker / 历史提示在场）
  - LLM 返回的 tool_calls（验证它真的按预期调工具）
  - assistant 文本
  - usage（token 消耗）

## 没做断言

测试只 dump 不 assert——人工判读。`Verdict` 段给个粗判，但不 fail。原因：LLM 行为会随模型版本漂移，硬断言会 flaky。每次跑看输出比较改前/改后行为更可靠。

## 加新 case

复制 `run-13-58-scene.test.ts` 改名 `run-XXX.test.ts`，改 `FIXTURE_ACTIVE_TASKS` / `USER_PROMPT` / 工具列表，跑。
