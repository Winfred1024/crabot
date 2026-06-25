/**
 * 守卫测试：防止"工具改名/删除后 subagent-tool-filter 名字集漂移导致工具被静默剔除"复发。
 *
 * 背景：subagent-tool-filter 按**工具名字符串**把工具分到 capability 组。一旦工具改名
 * （get_task_details → get_task_progress）、删除（search_traces）或大小写不一致（'glob' vs 'Glob'），
 * 名字集就静默失效，工具落入 'unknown' 被剔除，且无任何报错——本测试把这种漂移变成 CI 失败。
 *
 * 做法：实例化每个**真实 builtin 工具**读其 ToolDefinition.name，断言：
 *   1. classifyTool(真名) === 预期能力组（抓改名 / 大小写 / 删除）
 *   2. 对应名字集确实包含该真名（双向锁定）
 *   3. 三个名字集里没有"无对应真实工具"的陈旧条目（抓删除后忘清理）
 *
 * 新增受能力组管控的 builtin 工具时，把它加进下面的 EXPECTED 清单即可。
 */
import { describe, it, expect } from 'vitest'
import { classifyTool, _BUILTIN_NAME_SETS } from '../../src/agent/subagent-tool-filter.js'
import type { ToolGroup } from '../../src/agent/subagent-tool-filter.js'
import type { ToolDefinition } from '../../src/engine/types.js'

import { createReadTool } from '../../src/engine/tools/read-tool.js'
import { createWriteTool } from '../../src/engine/tools/write-tool.js'
import { createEditTool } from '../../src/engine/tools/edit-tool.js'
import { createGlobTool } from '../../src/engine/tools/glob-tool.js'
import { createGrepTool } from '../../src/engine/tools/grep-tool.js'
import { createBashTool } from '../../src/engine/tools/bash-tool.js'
import { createOutputTool } from '../../src/engine/tools/output-tool.js'
import { createKillTool } from '../../src/engine/tools/kill-tool.js'
import { createListEntitiesTool } from '../../src/engine/tools/list-entities-tool.js'
import { createFindTaskTool } from '../../src/agent/find-task-tool.js'
import { createGetTaskProgressTool } from '../../src/agent/get-task-details-tool.js'

const getCwd = () => '/tmp'
// 工厂构造时不调用 deps，仅捕获进闭包，故测试用空桩即可读 name。
const stub = {} as never

/** 每个受 capability 组管控的真实 builtin 工具 → 它应落入的能力组 */
const EXPECTED: ReadonlyArray<{ tool: ToolDefinition; group: ToolGroup }> = [
  { tool: createReadTool(getCwd), group: 'file_system' },
  { tool: createWriteTool(getCwd), group: 'file_system' },
  { tool: createEditTool(getCwd), group: 'file_system' },
  { tool: createGlobTool(getCwd), group: 'file_system' },
  { tool: createGrepTool(getCwd), group: 'file_system' },
  { tool: createBashTool(getCwd), group: 'shell' },
  { tool: createOutputTool(stub), group: 'shell' },
  { tool: createKillTool(stub), group: 'shell' },
  { tool: createListEntitiesTool(stub), group: 'shell' },
  { tool: createFindTaskTool(stub), group: 'task_intel' },
  { tool: createGetTaskProgressTool(stub), group: 'task_intel' },
]

describe('subagent-tool-filter 名字集与真实工具名一致性（防漂移守卫）', () => {
  it.each(EXPECTED.map((e) => [e.tool.name, e.group] as const))(
    '工具 "%s" 必须被分类为 %s（改名/删除/大小写漂移会在此失败）',
    (name, group) => {
      expect(classifyTool(name)).toBe(group)
      expect(_BUILTIN_NAME_SETS[group].has(name)).toBe(true)
    },
  )

  it('名字集里没有"无对应真实工具"的陈旧条目', () => {
    const realNames = new Set(EXPECTED.map((e) => e.tool.name))
    for (const [group, names] of Object.entries(_BUILTIN_NAME_SETS)) {
      for (const name of names) {
        expect(realNames.has(name), `名字集 ${group} 里的 "${name}" 没有对应的真实工具，可能是改名/删除后的残留`).toBe(true)
      }
    }
  })
})
