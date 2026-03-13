/**
 * Agent 路由 — /api/agents
 *
 * 文件位置: backend-src/src/routes/agents.ts
 * 核心功能:
 *   GET    /              — 列出 server 中的所有 Agent
 *   POST   /              — 创建新 Agent
 *   GET    /:id           — 获取 Agent 详情
 *   PATCH  /:id/activity  — 更新 Agent 活动状态
 *   POST   /:id/start     — 启动 Agent（调用 ProcessManager）
 *   POST   /:id/stop      — 停止 Agent
 *   POST   /:id/heartbeat — Agent 心跳上报（Agent 进程自身调用）
 *   GET    /:id/logs      — 获取 Agent 日志（分页）
 *
 * 与 Daemon 的关系:
 *   start/stop 操作通过 processManager 管理子进程
 *   heartbeat 同时更新 DB 和 processManager 的内存状态
 */

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import { processManager } from '../daemon/process-manager.js'
import type { AgentConfig } from '../daemon/process-manager.js'

export const agentRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/agents ───────────────────────────────────────────────
  /**
   * 列出当前用户所在 server 的所有 Agent
   * 通过 server_members JOIN 确保权限隔离
   * @param serverId 可选，指定 server 过滤
   */
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const { serverId } = req.query as { serverId?: string }
    const caller = req.user as { sub: string }

    const agents = await query(
      `SELECT a.id, a.name, a.description, a.model_provider, a.model_id,
              a.runtime, a.status, a.activity, a.activity_detail,
              a.last_heartbeat_at, a.workspace_path, a.created_at
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE ($2::uuid IS NULL OR a.server_id = $2::uuid)
       ORDER BY a.name`,
      [caller.sub, serverId ?? null]
    )
    return agents
  })

  // ── POST /api/agents ──────────────────────────────────────────────
  /**
   * 创建新 Agent
   * 默认使用 Claude Sonnet 模型和 claude runtime
   * Agent 创建后处于 offline 状态，需手动调用 start 启动
   */
  app.post('/', { preHandler: [app.authenticate] }, async (req) => {
    const { serverId, name, description, modelId, modelProvider, runtime, workspacePath } =
      req.body as {
        serverId: string; name: string; description?: string;
        modelId?: string; modelProvider?: string;
        runtime?: string; workspacePath?: string;
      }

    const [agent] = await query(
      `INSERT INTO agents
         (server_id, name, description, model_id, model_provider, runtime, workspace_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        serverId, name, description ?? null,
        modelId ?? 'claude-sonnet-4-6',     // 默认模型
        modelProvider ?? 'anthropic',        // 默认提供商
        runtime ?? 'claude',                 // 默认运行时
        workspacePath ?? null,
      ]
    )
    return { agent }
  })

  // ── GET /api/agents/:id ───────────────────────────────────────────
  /** 获取单个 Agent 的完整信息 */
  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await queryOne('SELECT * FROM agents WHERE id = $1', [id])
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    return agent
  })

  // ── PATCH /api/agents/:id/activity ───────────────────────────────
  /**
   * 更新 Agent 活动状态
   * Agent 进程在执行不同任务时调用此接口更新状态
   * 前端据此显示 Agent 当前在做什么（如 "正在编码"、"正在分析" 等）
   */
  app.patch('/:id/activity', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const { activity, activityDetail } = req.body as {
      activity: string; activityDetail?: string
    }

    const [agent] = await query(
      `UPDATE agents SET activity = $1, activity_detail = $2 WHERE id = $3 RETURNING id, activity, activity_detail`,
      [activity, activityDetail ?? null, id]
    )
    return { agent }
  })

  // ── POST /api/agents/:id/start ────────────────────────────────────
  /**
   * 启动 Agent 进程
   * 流程:
   *   1. 从 DB 读取 Agent 配置
   *   2. 生成临时 API Key（格式: agent_{id}_{timestamp}）
   *   3. 构建 AgentConfig 并调用 processManager.spawn()
   *   4. 更新 DB 状态为 'starting'
   *
   * 前置条件: 需要配置 SLOCK_SERVER_URL 环境变量
   */
  app.post('/:id/start', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await queryOne<{
      id: string; name: string; runtime: string; model_id: string;
      machine_id: string | null; workspace_path: string | null;
    }>('SELECT * FROM agents WHERE id = $1', [id])

    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    if (!process.env.SLOCK_SERVER_URL) {
      return reply.code(500).send({ error: 'SLOCK_SERVER_URL not configured' })
    }

    // 为本次 Agent 会话生成临时 API Key
    const apiKey = `agent_${id}_${Date.now()}`

    const config: AgentConfig = {
      id:            agent.id,
      name:          agent.name,
      machineId:     agent.machine_id ?? 'local',
      serverUrl:     process.env.SLOCK_SERVER_URL,
      apiKey,
      workspacePath: agent.workspace_path ?? process.cwd(),
      runtime:       agent.runtime,
      modelId:       agent.model_id,
    }

    await processManager.spawn(config)
    await query(`UPDATE agents SET status = 'starting' WHERE id = $1`, [id])
    return { ok: true, message: `Agent ${agent.name} starting` }
  })

  // ── POST /api/agents/:id/stop ─────────────────────────────────────
  /** 停止 Agent 进程，更新 DB 状态为 offline */
  app.post('/:id/stop', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    await processManager.stop(id)
    await query(`UPDATE agents SET status = 'offline', activity = NULL WHERE id = $1`, [id])
    return { ok: true }
  })

  // ── POST /api/agents/:id/heartbeat ────────────────────────────────
  /**
   * Agent 心跳上报
   * 由 Agent 子进程每 30 秒调用一次
   * 注意: 此接口无 authenticate 中间件，因为 Agent 使用自己的认证方式
   *
   * 功能:
   *   1. 更新 processManager 内存中的心跳时间
   *   2. 更新 DB 中的 last_heartbeat_at 和状态
   *   3. 可选: 上报 token 用量（用于 handoff 阈值监控）
   */
  app.post('/:id/heartbeat', async (req) => {
    const { id } = req.params as { id: string }
    const { tokenUsage } = req.body as { tokenUsage?: number }

    processManager.updateHeartbeat(id)
    await query(
      `UPDATE agents SET last_heartbeat_at = NOW(), status = 'online' WHERE id = $1`,
      [id]
    )

    // 如果上报了 token 用量，更新最新的 running 状态的 run 记录
    if (tokenUsage !== undefined) {
      await query(
        `UPDATE agent_runs SET tokens_used = $1
         WHERE agent_id = $2 AND status = 'running'
         ORDER BY started_at DESC LIMIT 1`,
        [tokenUsage, id]
      )
    }

    return { ok: true }
  })

  // ── GET /api/agents/:id/logs ──────────────────────────────────────
  /**
   * 获取 Agent 日志（支持向前分页）
   * @param limit  每页条数，默认 100，最大 500
   * @param before 时间游标，返回 created_at < before 的日志
   * @returns { logs: LogEntry[] } 按时间正序排列
   */
  app.get('/:id/logs', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const { limit = '100', before } = req.query as { limit?: string; before?: string }

    const lim = Math.min(Number(limit), 500)
    let rows

    if (before) {
      rows = await query(
        `SELECT * FROM agent_logs WHERE agent_id = $1 AND created_at < $2
         ORDER BY created_at DESC LIMIT $3`,
        [id, before, lim]
      )
    } else {
      rows = await query(
        `SELECT * FROM agent_logs WHERE agent_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [id, lim]
      )
    }

    return { logs: rows.reverse() }
  })
}
