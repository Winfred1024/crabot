/**
 * Crab-Memory MCP Server — Agent 长期记忆能力
 *
 * 两组工具：
 * - 简化工具组（Worker 普通对话用）：store_memory / search_memory / set_scene_profile / get_memory_detail
 *   importance / brief 等字段自动推断，最少参数即可落盘
 * - 原生 RPC 工具组（反思 SKILL 用）：quick_capture / search_long_term / update_long_term /
 *   delete_memory / run_maintenance / get_memory_stats / get_evolution_mode / set_evolution_mode /
 *   get_scene_profile / list_recent / promote_to_rule
 *   字段精细可控，工具名与 Memory RPC 一一对应
 *
 * @see crabot-docs/protocols/protocol-memory.md
 */

import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import type { RpcClient } from 'crabot-shared'

// ============================================================================
// 依赖注入接口
// ============================================================================

export interface CrabMemoryDeps {
  rpcClient: RpcClient
  moduleId: string
  getMemoryPort: () => Promise<number>
}

/** 每次任务创建时传入的上下文，用于自动填充 source/visibility/scopes */
export interface MemoryTaskContext {
  /** Worker 调用时必传；Front 调用时可省（Front 不是 task 上下文） */
  taskId?: string
  channelId?: string
  sessionId?: string
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
  /** 记忆来源类型，默认 'conversation' */
  sourceType?: 'conversation' | 'reflection' | 'system'
  /** 场景推断所需：群聊 sessionType='group'；私聊 'private' 需 friendId */
  sessionType?: 'private' | 'group'
  senderFriendId?: string
}

function defaultSceneProfileLabel(
  scene: { type: 'group_session'; channel_id: string; session_id: string } | { type: 'friend'; friend_id: string },
): string {
  if (scene.type === 'friend') return `friend:${scene.friend_id}`
  return `group:${scene.channel_id}:${scene.session_id}`
}

/** brief 必须 ≤80 字符且非空，从 content 首行截取 */
function deriveBriefFromContent(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const trimmed = firstLine || content.trim()
  return trimmed.slice(0, 80) || 'untitled'
}

/** 1-10 importance → 4 维 importance_factors（0-1 区间） */
function importanceToFactors(importance: number | undefined): {
  proximity: number
  surprisal: number
  entity_priority: number
  unambiguity: number
} {
  const raw = typeof importance === 'number' ? importance : 5
  const clamped = Math.min(10, Math.max(1, raw))
  const normalized = clamped / 10
  return {
    proximity: 0.5,
    surprisal: normalized,
    entity_priority: 0.5,
    unambiguity: 0.5,
  }
}

export async function resolveSceneAnchorLabel(params: {
  rpcClient: RpcClient
  memoryPort: number
  moduleId: string
  scene: { type: 'group_session'; channel_id: string; session_id: string } | { type: 'friend'; friend_id: string }
}): Promise<string> {
  const result = await params.rpcClient.call<
    { scene: typeof params.scene },
    { profile: { label?: string | null } | null }
  >(
    params.memoryPort,
    'get_scene_profile',
    { scene: params.scene },
    params.moduleId,
  )

  const existingLabel = result?.profile?.label?.trim()
  return existingLabel || defaultSceneProfileLabel(params.scene)
}

// ============================================================================
// MCP Server 创建
// ============================================================================

export function createCrabMemoryServer(
  deps: CrabMemoryDeps,
  ctx: MemoryTaskContext,
): McpServer {
  const { rpcClient, moduleId, getMemoryPort } = deps

  const server = createMcpServer({ name: 'crab-memory', version: '1.0.0' })

  server.registerTool(
        'store_memory',
        {
          description: '将信息写入长期记忆 inbox。用户要求记住时必须使用；发现有价值的偏好、案例、模式等信息时也应主动使用。',
          inputSchema: {
            content: z.string().describe('要记住的完整信息（成为 body），应包含足够上下文'),
            brief: z.string().optional()
              .describe('召回标题（≤80 字符）。不传则自动从 content 首行截取'),
            type: z.enum(['fact', 'lesson', 'concept']).optional()
              .describe('记忆类型：fact=客观事实, lesson=经验教训, concept=概念定义（默认 fact）'),
            importance: z.number().min(1).max(10).optional()
              .describe('重要性 1-10，日常偏好 3-5，重要决策 6-8，关键信息 9-10（用于推断 importance_factors）'),
            tags: z.array(z.string()).optional()
              .describe('分类标签'),
          },
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            const brief = args.brief?.trim() || deriveBriefFromContent(args.content)
            const type = args.type ?? 'fact'
            const result = await rpcClient.call(
              memoryPort,
              'quick_capture',
              {
                type,
                brief,
                content: args.content,
                author: 'agent',
                source_ref: {
                  type: ctx.sourceType ?? 'conversation',
                  task_id: ctx.taskId,
                  channel_id: ctx.channelId,
                  session_id: ctx.sessionId,
                },
                entities: [],
                tags: args.tags ?? [],
                importance_factors: importanceToFactors(args.importance),
              },
              moduleId
            ) as { id?: string; status?: string }

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  action: result.status ?? 'ok',
                  memory_id: result.id,
                  brief,
                }),
              }],
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[${moduleId}] store_memory failed:`, message)
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: message,
                }),
              }],
            }
          }
        },
      ),
  server.registerTool(
        'search_memory',
        {
          description: '搜索记忆。short_term=跨 session 事件流水账（每条自带 channel/session/task/trace 锚点）；long_term=认知知识库（事实/经验/概念）。' +
            '【short_term 用途】未知 task_id/trace_id 时回溯历史事件的入口——任何需要回答"哪一次任务/事件 / 上一次怎么处理 / 之前为什么变成这样"的问题，先调本工具（level=short_term）拿锚点，再用 search_traces / get_task_details 取详情。',
          inputSchema: {
            query: z.string().describe('FTS5 全文检索查询（trigram tokenizer，CJK/英文混合都支持）；query 抽词后 <3 字符的 token 不命中（trigram 固有限制）'),
            level: z.enum(['short_term', 'long_term']).default('long_term')
              .describe('搜索范围：short_term=事件流水账（找历史 ID 的入口），long_term=认知知识库'),
            limit: z.number().min(1).max(20).default(5)
              .describe('返回数量上限'),
          },
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            if (args.level === 'short_term') {
              const result = await rpcClient.call(
                memoryPort, 'search_short_term',
                {
                  query: args.query, limit: args.limit,
                  min_visibility: ctx.visibility,
                  ...(ctx.scopes.length > 0 ? { accessible_scopes: ctx.scopes } : {}),
                },
                moduleId
              ) as { results: Array<{ id: string; content: string; event_time: string; topic?: string }> }
              return { content: [{ type: 'text' as const, text: JSON.stringify({ results: result.results }) }] }
            }
            const result = await rpcClient.call(
              memoryPort, 'search_long_term',
              {
                query: args.query, k: args.limit, include: 'brief',
                min_visibility: ctx.visibility,
                ...(ctx.scopes.length > 0 ? { accessible_scopes: ctx.scopes } : {}),
                ...(ctx.taskId ? { task_id: ctx.taskId } : {}),
              },
              moduleId
            ) as { results: Array<{ id: string; type: string; status: string; brief: string; tags?: string[] }> }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ results: result.results }) }],
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }] }
          }
        },
      ),
  server.registerTool(
        'get_memory_detail',
        {
          description: '获取某条长期记忆的详细内容。先用 search_memory 找到记忆 ID，再用此工具查看详情。',
          inputSchema: {
            memory_id: z.string().describe('记忆 ID'),
            include: z.enum(['brief', 'full']).default('full')
              .describe('详细程度：brief=仅返回标识与 brief, full=附带 body 与 frontmatter'),
          },
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            const result = await rpcClient.call(
              memoryPort, 'get_memory',
              { id: args.memory_id, include: args.include },
              moduleId
            ) as { id: string; type: string; status: string; brief: string; body?: string; frontmatter?: Record<string, unknown> }
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }] }
          }
        },
  )

  // ============================================================================
  // 反思级原生 RPC 工具组
  // ============================================================================
  // 这一组工具直接透传到 Memory 后端 RPC，工具名与 RPC 一一对应，
  // 供 daily-reflection / memory-curate 等内置 SKILL 在反思 / 整理流程中精细操作。
  // 与上面 4 个 Worker 简化工具的区别：参数完整、字段精细可控、不做隐式推断。
  // 详见 protocol-memory.md。

  // 透传 helper：统一错误返回格式
  const callRpc = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    try {
      const memoryPort = await getMemoryPort()
      const result = await rpcClient.call(memoryPort, method, params, moduleId)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${moduleId}] crab-memory ${method} failed:`, message)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
      }
    }
  }

  const sourceRefSchema = z.object({
    type: z.enum(['conversation', 'reflection', 'system']).describe('来源类型'),
    task_id: z.string().optional(),
    channel_id: z.string().optional(),
    session_id: z.string().optional(),
  })

  const importanceFactorsSchema = z.object({
    proximity: z.number().min(0).max(1),
    surprisal: z.number().min(0).max(1),
    entity_priority: z.number().min(0).max(1),
    unambiguity: z.number().min(0).max(1),
  })

  const sceneSchema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('group_session'),
      channel_id: z.string(),
      session_id: z.string(),
    }),
    z.object({
      type: z.literal('friend'),
      friend_id: z.string(),
    }),
    z.object({ type: z.literal('global') }),
  ])

  server.registerTool(
    'quick_capture',
    {
      description: '把一条候选记忆写入 inbox（待审）。反思流程提炼经验时使用，与 store_memory 相比字段更精细可控。',
      inputSchema: {
        type: z.enum(['fact', 'lesson', 'concept']).describe('记忆类型'),
        brief: z.string().describe('一行召回标题（≤80 字符），需含场景关键词'),
        content: z.string().describe('完整正文 markdown'),
        source_ref: sourceRefSchema.optional()
          .describe('来源指纹；不传默认 reflection'),
        entities: z.array(z.object({
          id: z.string(),
          type: z.string(),
          name: z.string().optional(),
        })).optional(),
        tags: z.array(z.string()).optional(),
        importance_factors: importanceFactorsSchema.optional()
          .describe('4 维重要性因子（每维 0-1）；不传默认全 0.5'),
        lesson_meta: z.object({
          scenario: z.string().optional(),
          outcome: z.enum(['success', 'failure']).optional(),
          source_cases: z.array(z.string()).optional(),
        }).optional()
          .describe('lesson 类型专属元数据'),
        source_trust: z.number().int().min(1).max(5).optional()
          .describe('来源信任度 1-5；默认 3'),
        content_confidence: z.number().int().min(1).max(5).optional()
          .describe('内容置信度 1-5；默认 3'),
        event_time: z.string().optional()
          .describe('ISO8601 事件时间；不传默认现在'),
      },
    },
    async (args) => callRpc('quick_capture', args as Record<string, unknown>),
  )

  server.registerTool(
    'search_long_term',
    {
      description: '在长期记忆中按语义/关键词搜索，支持按 type、status、tags 等过滤。反思流程使用此工具按 status: "inbox" 拉候选。',
      inputSchema: {
        query: z.string().describe('自然语言查询；用 "*" 或 "recent" 占位 + filters 时表示无主题约束'),
        k: z.number().int().min(1).max(50).default(10),
        filters: z.object({
          type: z.enum(['fact', 'lesson', 'concept']).optional(),
          status: z.enum(['inbox', 'confirmed', 'trash']).optional(),
          tags: z.array(z.string()).optional(),
        }).optional(),
        include: z.enum(['brief', 'full']).default('brief'),
        recent_entities: z.array(z.string()).optional(),
      },
    },
    async (args) => callRpc('search_long_term', args as Record<string, unknown>),
  )

  server.registerTool(
    'update_long_term',
    {
      description: '更新一条长期记忆的字段。支持的 patch 字段：brief / tags / entities / maturity / importance_factors / invalidated_by / lesson_meta / observation / body / content_confidence_increment / use_count_increment / observation_outcome。',
      inputSchema: {
        id: z.string().describe('记忆 ID'),
        patch: z.record(z.string(), z.unknown())
          .describe('字段差量。例如 { content_confidence_increment: 1 }、{ invalidated_by: "<新条 id>" }、{ maturity: "confirmed" }'),
      },
    },
    async (args) => callRpc('update_long_term', args as Record<string, unknown>),
  )

  server.registerTool(
    'delete_memory',
    {
      description: '把一条长期记忆软删除到 trash（30 天后由 maintenance 物理清理；期间可 restore_memory 恢复）。',
      inputSchema: {
        id: z.string().describe('记忆 ID'),
      },
    },
    async (args) => callRpc('delete_memory', args as Record<string, unknown>),
  )

  server.registerTool(
    'list_recent',
    {
      description: '列出最近 N 天写入的长期记忆（按 ingestion_time 倒序）。反思流程做"今日新增"扫描时使用。',
      inputSchema: {
        window_days: z.number().int().min(1).max(90).default(7)
          .describe('时间窗口（天数）'),
        type: z.enum(['fact', 'lesson', 'concept']).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async (args) => callRpc('list_recent', args as Record<string, unknown>),
  )

  server.registerTool(
    'run_maintenance',
    {
      description: '触发记忆维护任务。scope=all 会依次跑 observation_check（按 pass/fail 净值判定观察期到期项）/ stale_aging（180 天未访问的 fact 标 stale）/ trash_cleanup（30 天回收站）。每天凌晨 04:00 已有内置 schedule 自动跑一次，此处用于反思末尾兜底或手动触发。',
      inputSchema: {
        scope: z.enum(['all', 'observation_check', 'stale_aging', 'trash_cleanup']).default('all'),
        now_iso: z.string().optional().describe('覆盖当前时间（测试用）'),
      },
    },
    async (args) => callRpc('run_maintenance', args as Record<string, unknown>),
  )

  server.registerTool(
    'get_stats',
    {
      description: '获取记忆模块统计：短期 / 长期条目数、token 估算等。Evolution mode 自评判断时使用。',
      inputSchema: {},
    },
    async () => callRpc('get_stats', {}),
  )

  server.registerTool(
    'get_evolution_mode',
    {
      description: '查询当前演化模式：balanced / innovate / harden / repair-only。',
      inputSchema: {},
    },
    async () => callRpc('get_evolution_mode', {}),
  )

  server.registerTool(
    'set_evolution_mode',
    {
      description: '切换演化模式。balanced=默认；innovate=低错误率时偏向新知识；harden=大量 case 待整理时偏向抽象 rule；repair-only=高错误率时只修不增。',
      inputSchema: {
        mode: z.enum(['balanced', 'innovate', 'harden', 'repair-only']),
        reason: z.string().optional().describe('切换原因（写入审计）'),
      },
    },
    async (args) => callRpc('set_evolution_mode', args as Record<string, unknown>),
  )

  server.registerTool(
    'get_scene_profile',
    {
      description: '取场景画像（friend / group_session / global）的当前描述文本。',
      inputSchema: {
        scene: sceneSchema,
        only_public: z.boolean().optional(),
      },
    },
    async (args) => callRpc('get_scene_profile', args as Record<string, unknown>),
  )

  server.registerTool(
    'set_scene_profile',
    {
      description:
        '写入或覆盖当前场景画像（friend 私聊或 group session）。' +
        '【关键】这是覆盖式写入，不是 patch——当前场景画像已在你 prompt 顶部，覆盖前请基于现状合并。' +
        '【场景判定】scene/label 不传时自动从当前 ctx 推断；明确写其他场景或 global 画像才传 scene。' +
        '【边界】跨多个场景都适用的用户偏好不要写到本工具——走 store_memory。' +
        '操作类指令（"修改 X 配置 / 调整 Y schedule"）不要写到本工具——走对应 admin/CLI 操作。',
      inputSchema: {
        scene: sceneSchema.optional(),
        label: z.string().optional(),
        content: z.string().describe('场景画像正文（覆盖式写入）'),
        source_memory_ids: z.array(z.string()).optional()
          .describe('来源记忆 ID 列表（追溯用）'),
      },
    },
    async (args) => {
      try {
        let scene:
          | { type: 'friend'; friend_id: string }
          | { type: 'group_session'; channel_id: string; session_id: string }
          | { type: 'global' }
          | undefined = args.scene

        if (!scene) {
          // 从 ctx 推断场景
          if (ctx.sessionType === 'group' && ctx.channelId && ctx.sessionId) {
            scene = { type: 'group_session', channel_id: ctx.channelId, session_id: ctx.sessionId }
          } else if (ctx.sessionType === 'private' && ctx.senderFriendId) {
            scene = { type: 'friend', friend_id: ctx.senderFriendId }
          }
          if (!scene) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                success: false,
                error: '无法推断场景（缺少 friend_id 或 session_id），需显式传 scene',
              }) }],
            }
          }
        }

        let label = args.label
        if (!label) {
          if (scene.type === 'global') {
            label = 'global'
          } else {
            const memoryPort = await getMemoryPort()
            label = await resolveSceneAnchorLabel({ rpcClient, memoryPort, moduleId, scene })
          }
        }

        const now = new Date().toISOString()
        const memoryPort = await getMemoryPort()
        const result = await rpcClient.call<
          Record<string, unknown>,
          { profile: unknown }
        >(
          memoryPort,
          'upsert_scene_profile',
          {
            scene, label, content: args.content,
            ...(args.source_memory_ids ? { source_memory_ids: args.source_memory_ids } : {}),
            created_at: now, updated_at: now, last_declared_at: now,
          },
          moduleId,
        )

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, profile: result.profile }) }],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[${moduleId}] set_scene_profile failed:`, message)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }],
        }
      }
    },
  )

  server.registerTool(
    'delete_scene_profile',
    {
      description: '删除整条场景画像。仅在画像已被新证据完全推翻、且无替代时使用。',
      inputSchema: {
        scene: sceneSchema,
      },
    },
    async (args) => callRpc('delete_scene_profile', args as Record<string, unknown>),
  )

  server.registerTool(
    'promote_to_rule',
    {
      description: 'Case→Rule 自动晋升。在凑齐 ≥3 条同 scenario 的 case 后，把 LLM 抽象出的 rule 文本直接写入 confirmed/lesson/，maturity=rule，进 7 天观察期。无人工 confirm。',
      inputSchema: {
        source_cases: z.array(z.string()).min(3)
          .describe('≥3 条来源 case 的 id（spec §6.4 门槛）'),
        brief: z.string().describe('rule 召回标题（≤80 字符）'),
        content: z.string().describe('rule 完整正文：scenario / 适用条件 / 推荐做法 / 反例'),
        scenario: z.string().optional().describe('场景描述；不传则空'),
        source_trust: z.number().int().min(1).max(5).default(4),
        content_confidence: z.number().int().min(1).max(5).default(4),
        observation_window_days: z.number().int().min(1).max(90).default(7),
      },
    },
    async (args) => callRpc('promote_to_rule', args as Record<string, unknown>),
  )

  return server
}
