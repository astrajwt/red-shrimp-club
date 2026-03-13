/**
 * Daemon 内部 API 路由 — /api/daemon
 *
 * 文件位置: backend-src/src/routes/daemon.ts
 * 核心功能:
 *   健康检查:     GET  /health           — 服务状态和运行时间
 *   日志持久化:   POST /logs             — Agent 日志写入 DB
 *   运行记录:     POST /runs             — 创建 agent_runs 记录
 *                 PATCH /runs/:id        — 更新 run 状态/token 用量
 *   文档状态:     POST /doc-status       — 更新关联文档状态
 *   Agent 记忆:   POST /memory/:agentId  — 写入 Agent 的 MEMORY.md
 *                 GET  /memory/:agentId  — 读取 Agent 的 MEMORY.md
 *   Cron 管理:    GET/POST/PATCH/DELETE /cron — 定时任务 CRUD
 *   Obsidian:     POST /obsidian/sync    — 手动触发 git 同步
 *                 GET  /obsidian/file    — 读取 vault 中的 markdown 文件
 *                 GET  /obsidian/tree    — 列出 vault 目录树
 *
 * 安全说明:
 *   - /logs, /runs, /doc-status, /memory 为 Daemon 内部调用，无 authenticate 中间件
 *   - /cron, /obsidian 为前端调用，需要 authenticate
 *   - Obsidian 文件访问有路径遍历防护 (path.resolve 校验)
 */

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import { processManager } from '../daemon/process-manager.js'
import { MemoryWriter } from '../daemon/logger.js'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

/** Agent 记忆文件管理器实例 */
const memoryWriter = new MemoryWriter()

export const daemonRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/daemon/health ────────────────────────────────────────
  /** 健康检查端点，返回服务状态和运行时间 */
  app.get('/health', async () => {
    return {
      status:    'ok',
      timestamp: new Date().toISOString(),
      uptime:    process.uptime(),
    }
  })

  // ── POST /api/daemon/logs ─────────────────────────────────────────
  /** Daemon 内部调用: 将 Agent 日志条目持久化到 DB agent_logs 表 */
  app.post('/logs', async (req) => {
    const { agentId, runId, level, content } = req.body as {
      agentId: string; runId?: string; level: string; content: string
    }
    await query(
      `INSERT INTO agent_logs (agent_id, run_id, level, content) VALUES ($1, $2, $3, $4)`,
      [agentId, runId ?? null, level, content]
    )
    return { ok: true }
  })

  // ── POST /api/daemon/runs ─────────────────────────────────────────
  /**
   * 创建新的 agent_runs 记录
   * 支持创建根 run 和子 run（通过 parentRunId 建立父子关系）
   * @param tokensLimit 默认 200000 token
   */
  app.post('/runs', async (req) => {
    const { agentId, parentRunId, taskId, tokensLimit } = req.body as {
      agentId: string; parentRunId?: string; taskId?: string; tokensLimit?: number
    }
    const [run] = await query(
      `INSERT INTO agent_runs (agent_id, parent_run_id, task_id, tokens_limit)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [agentId, parentRunId ?? null, taskId ?? null, tokensLimit ?? 200000]
    )
    return { run }
  })

  // ── PATCH /api/daemon/runs/:id ────────────────────────────────────
  /**
   * 更新 run 记录
   * 使用 COALESCE 实现部分更新（只更新传入的字段）
   * 当状态变为终态 (completed/handoff/failed) 时自动设置 ended_at
   */
  app.patch('/runs/:id', async (req) => {
    const { id } = req.params as { id: string }
    const { status, tokensUsed } = req.body as {
      status?: string; tokensUsed?: number
    }

    const [run] = await query(
      `UPDATE agent_runs
       SET status = COALESCE($1, status),
           tokens_used = COALESCE($2, tokens_used),
           ended_at = CASE WHEN $1 IN ('completed','handoff','failed') THEN NOW() ELSE ended_at END
       WHERE id = $3 RETURNING *`,
      [status ?? null, tokensUsed ?? null, id]
    )
    return { run }
  })

  // ── POST /api/daemon/doc-status ───────────────────────────────────
  /**
   * Agent 更新关联文档的状态
   * 典型场景: Agent 写完文档后将状态从 'writing' 改为 'unread'
   */
  app.post('/doc-status', async (req) => {
    const { docPath, status } = req.body as { docPath: string; status: string }
    await query(
      `UPDATE task_documents SET status = $1 WHERE doc_path = $2`,
      [status, docPath]
    )
    return { ok: true }
  })

  // ── POST /api/daemon/memory/:agentId ─────────────────────────────
  /**
   * Agent 写入/更新自己的 MEMORY.md
   * 文件路径: ~/JwtVault/agent-memory/{agentName}/MEMORY.md
   */
  app.post('/memory/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string }
    const { content } = req.body as { content: string }
    const agent = await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [agentId])
    if (!agent) return { error: 'Agent not found' }

    const filePath = memoryWriter.writeMemory(agent.name, content)
    return { ok: true, path: filePath }
  })

  // ── GET /api/daemon/memory/:agentId ──────────────────────────────
  /** 读取 Agent 的 MEMORY.md 内容 */
  app.get('/memory/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string }
    const agent = await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [agentId])
    if (!agent) return { error: 'Agent not found' }

    const content = memoryWriter.readMemory(agent.name)
    return { content }
  })

  // ── Cron 定时任务 CRUD ────────────────────────────────────────

  /** 列出所有 cron 定时任务 */
  app.get('/cron', { preHandler: [app.authenticate] }, async () => {
    const jobs = await query(
      `SELECT cj.*, a.name AS agent_name
       FROM cron_jobs cj
       JOIN agents a ON a.id = cj.agent_id
       ORDER BY cj.created_at`
    )
    return { jobs }
  })

  /**
   * 创建新的 cron 定时任务
   * @param cronExpr      cron 表达式 (如 "0 9 * * *")
   * @param prompt        发送给 LLM 的提示词
   * @param channelId     可选: LLM 回复发送到的频道
   * @param modelOverride 可选: 覆盖默认模型
   */
  app.post('/cron', { preHandler: [app.authenticate] }, async (req) => {
    const { agentId, cronExpr, prompt, channelId, modelOverride } = req.body as {
      agentId: string; cronExpr: string; prompt: string;
      channelId?: string; modelOverride?: string
    }
    const [job] = await query(
      `INSERT INTO cron_jobs (agent_id, cron_expr, prompt, channel_id, model_override)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [agentId, cronExpr, prompt, channelId ?? null, modelOverride ?? null]
    )
    return { job }
  })

  /** 更新 cron 任务（部分更新，使用 COALESCE） */
  app.patch('/cron/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { enabled, cronExpr, prompt } = req.body as {
      enabled?: boolean; cronExpr?: string; prompt?: string
    }
    const existing = await queryOne('SELECT 1 FROM cron_jobs WHERE id = $1', [id])
    if (!existing) return reply.code(404).send({ error: 'Cron job not found' })

    const [job] = await query(
      `UPDATE cron_jobs
       SET enabled   = COALESCE($1, enabled),
           cron_expr = COALESCE($2, cron_expr),
           prompt    = COALESCE($3, prompt)
       WHERE id = $4 RETURNING *`,
      [enabled ?? null, cronExpr ?? null, prompt ?? null, id]
    )
    return { job }
  })

  /** 删除 cron 任务 */
  app.delete('/cron/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const [deleted] = await query('DELETE FROM cron_jobs WHERE id = $1 RETURNING id', [id])
    if (!deleted) return reply.code(404).send({ error: 'Cron job not found' })
    return { ok: true }
  })

  // ── Obsidian Vault 操作 ──────────────────────────────────────

  /**
   * 手动触发 Obsidian vault 的 git 同步
   * 执行: git add -A → git commit → git push
   * 30 秒超时保护
   */
  app.post('/obsidian/sync', { preHandler: [app.authenticate] }, async (_req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    try {
      execSync('git add -A && git diff --cached --quiet || git commit -m "manual sync" && git push', {
        cwd: vaultRoot,
        timeout: 30_000,
        stdio: 'pipe',
      })
      return { ok: true, message: 'Obsidian vault synced' }
    } catch (err: any) {
      return reply.code(500).send({ error: 'Sync failed', detail: err.stderr?.toString() })
    }
  })

  // ── GET /api/daemon/obsidian/file ───────────────────────────────
  /**
   * 读取 Obsidian vault 中的 markdown 文件（只读）
   * 安全: 使用 path.resolve 校验防止路径遍历攻击
   * @param path 相对于 vault 根目录的文件路径
   */
  app.get('/obsidian/file', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: filePath } = req.query as { path: string }
    if (!filePath) return reply.code(400).send({ error: 'path query param required' })

    // 路径遍历防护: 确保解析后的路径仍在 vault 根目录内
    const resolved = path.resolve(vaultRoot, filePath)
    if (!resolved.startsWith(path.resolve(vaultRoot))) {
      return reply.code(403).send({ error: 'Path traversal not allowed' })
    }

    try {
      const content = fs.readFileSync(resolved, 'utf-8')
      return { path: filePath, content }
    } catch {
      return reply.code(404).send({ error: 'File not found' })
    }
  })

  // ── GET /api/daemon/obsidian/tree ───────────────────────────────
  /**
   * 列出 Obsidian vault 的目录树
   * 过滤隐藏文件（.git, .obsidian 等）
   * 排序: 目录在前，文件在后，同类按名称排序
   * @param path 相对于 vault 根目录的子目录路径，默认为根目录
   */
  app.get('/obsidian/tree', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: dirPath = '' } = req.query as { path?: string }
    const resolved = path.resolve(vaultRoot, dirPath)

    // 路径遍历防护
    if (!resolved.startsWith(path.resolve(vaultRoot))) {
      return reply.code(403).send({ error: 'Path traversal not allowed' })
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const items = entries
        .filter(e => !e.name.startsWith('.'))  // 跳过 .git, .obsidian 等隐藏目录
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
          path: path.join(dirPath, e.name),
        }))
        .sort((a, b) => {
          // 目录排在文件前面
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      return { path: dirPath, items }
    } catch {
      return reply.code(404).send({ error: 'Directory not found' })
    }
  })
}
