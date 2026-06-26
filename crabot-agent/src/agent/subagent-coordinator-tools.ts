/**
 * 异步 subagent 协调工具：list_active_subagents / get_subagent_output / stop_subagent
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-26-async-subagent-design.md §3.5
 *
 * 这三个工具仅供 master 在 waiting 状态后重入 worker loop 时使用：
 * - list_active_subagents：了解哪些 async 子 agent 还在跑
 * - get_subagent_output：读取已完成 subagent 的 result file
 * - stop_subagent：提前 kill 某个 in-flight subagent
 *
 * 注意：prompt 明确禁止用 list / get_subagent_output 轮询进度；
 * 通知靠 sub_agent_notification 事件驱动。
 */

import * as fs from 'node:fs'
import type { ToolDefinition, ToolCallResult } from '../engine/types.js'
import type { BgEntityRegistry } from '../engine/bg-entities/registry.js'

export interface SubagentCoordinatorDeps {
  readonly taskId: string
  readonly bgRegistry: BgEntityRegistry
  readonly killBgEntity: (entity_id: string) => Promise<{ ok: boolean; message?: string }>
}

export function createSubagentCoordinatorTools(deps: SubagentCoordinatorDeps): ToolDefinition[] {
  return [
    createListActiveSubagentsTool(deps),
    createGetSubagentOutputTool(deps),
    createStopSubagentTool(deps),
  ]
}

function createListActiveSubagentsTool(deps: SubagentCoordinatorDeps): ToolDefinition {
  return {
    name: 'list_active_subagents',
    description: [
      '列出本任务当前仍在运行的异步 subagent。',
      '**不要用此工具轮询进度**——subagent 完成时系统会自动推送 <sub_agent_notification>。',
      '仅在用户主动询问进度、或你需要决定是否 stop 某个 subagent 时才调用。',
    ].join('\n'),
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    call: async (): Promise<ToolCallResult> => {
      const records = await deps.bgRegistry.list({
        spawned_by_task_id: deps.taskId,
        type: 'agent',
      })
      if (records.length === 0) {
        return { output: '(no active subagents for this task)', isError: false }
      }
      const lines = records.map((r) => {
        const agent = r as import('../engine/bg-entities/types.js').BgAgentRegistryRecord
        return `[${agent.entity_id}] status=${agent.status} spawned=${agent.spawned_at} desc="${agent.task_description.slice(0, 100)}"`
      })
      return { output: lines.join('\n'), isError: false }
    },
  }
}

function createGetSubagentOutputTool(deps: SubagentCoordinatorDeps): ToolDefinition {
  return {
    name: 'get_subagent_output',
    description: [
      '读取某个 subagent 的 output（result file）。',
      '**不要用此工具轮询进度**——subagent 完成时系统会自动推送 <sub_agent_notification>。',
      '仅在已收到 sub_agent_notification 后、需要读取完整输出时使用。',
    ].join('\n'),
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'subagent entity_id（来自 sub_agent_notification 或 list_active_subagents）' },
      },
      required: ['agent_id'],
    },
    call: async (input: Record<string, unknown>): Promise<ToolCallResult> => {
      const agentId = String(input.agent_id ?? '')
      const rec = await deps.bgRegistry.get(agentId)
      if (!rec) return { output: `Agent ${agentId} not found`, isError: true }
      if (rec.type !== 'agent') return { output: `${agentId} is not an agent`, isError: true }

      const agent = rec as import('../engine/bg-entities/types.js').BgAgentRegistryRecord
      // 失败的 subagent 通常没有 result_file（或为空）：把失败原因回传给父 agent，
      // 让它决定如何处理（接口类失败通常应通知人类），而不是吞成 "(empty output)"。
      if (agent.status === 'failed' && agent.error) {
        return { output: `Agent ${agentId} failed: ${agent.error}`, isError: true }
      }
      if (!agent.result_file) {
        return {
          output: `Agent ${agentId} status=${agent.status}; result file not yet available`,
          isError: false,
        }
      }
      try {
        const content = fs.readFileSync(agent.result_file, 'utf-8')
        return { output: content || '(empty output)', isError: false }
      } catch (err) {
        return { output: `Failed to read result file: ${err}`, isError: true }
      }
    },
  }
}

function createStopSubagentTool(deps: SubagentCoordinatorDeps): ToolDefinition {
  return {
    name: 'stop_subagent',
    description: '强制终止某个 in-flight 异步 subagent。用于用户要求改变方向、需要重新规划时。',
    isReadOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'subagent entity_id' },
      },
      required: ['agent_id'],
    },
    call: async (input: Record<string, unknown>): Promise<ToolCallResult> => {
      const agentId = String(input.agent_id ?? '')
      const result = await deps.killBgEntity(agentId)
      if (result.ok) {
        return { output: `Subagent ${agentId} stopped`, isError: false }
      }
      return { output: `Failed to stop ${agentId}: ${result.message}`, isError: true }
    },
  }
}
