// Daemon control routes — /api/daemon
// Internal routes called by the Daemon to persist logs / update state.
// Also exposes health info for monitoring.
// Cron job management + Obsidian vault access.

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import { processManager } from '../daemon/process-manager.js'
import { heartbeatChecker } from '../daemon/heartbeat-checker.js'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

export const daemonRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/daemon/heartbeat/trigger ──────────────────────────
  // Manually trigger a heartbeat check for all agents (or one agent)
  app.post('/heartbeat/trigger', { preHandler: [app.authenticate] }, async (req) => {
    const { agentId } = req.body as { agentId?: string }
    heartbeatChecker.triggerNow(agentId).catch(() => {})
    return { ok: true, message: 'Heartbeat check triggered' }
  })

  // ── GET /api/daemon/health ────────────────────────────────────────
  app.get('/health', async () => {
    return {
      status:    'ok',
      timestamp: new Date().toISOString(),
      uptime:    process.uptime(),
    }
  })

  // ── POST /api/daemon/logs ─────────────────────────────────────────
  // Daemon calls this to persist a log entry to DB
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
  // Create a new agent run (including sub-agent runs)
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
  app.patch('/runs/:id', async (req) => {
    const { id } = req.params as { id: string }
    const { status, tokensUsed, contextSnapshot } = req.body as {
      status?: string; tokensUsed?: number; contextSnapshot?: Record<string, unknown>
    }

    const [run] = await query(
      `UPDATE agent_runs
       SET status = COALESCE($1, status),
           tokens_used = COALESCE($2, tokens_used),
           context_snapshot = COALESCE($3::jsonb, context_snapshot),
           ended_at = CASE WHEN $1 IN ('completed','handoff','failed') THEN NOW() ELSE ended_at END
       WHERE id = $4 RETURNING *`,
      [status ?? null, tokensUsed ?? null, contextSnapshot ? JSON.stringify(contextSnapshot) : null, id]
    )
    return { run }
  })

  // ── POST /api/daemon/doc-status ───────────────────────────────────
  // Agent updates a linked document's status (writing → unread)
  app.post('/doc-status', async (req) => {
    const { docPath, status } = req.body as { docPath: string; status: string }
    await query(
      `UPDATE task_documents SET status = $1 WHERE doc_path = $2`,
      [status, docPath]
    )
    return { ok: true }
  })

  // ── GET /api/daemon/cron ────────────────────────────────────────
  app.get('/cron', { preHandler: [app.authenticate] }, async () => {
    const jobs = await query(
      `SELECT cj.*, a.name AS agent_name
       FROM cron_jobs cj
       JOIN agents a ON a.id = cj.agent_id
       ORDER BY cj.created_at`
    )
    return { jobs }
  })

  // ── POST /api/daemon/cron ───────────────────────────────────────
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

  // ── PATCH /api/daemon/cron/:id ──────────────────────────────────
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

  // ── DELETE /api/daemon/cron/:id ─────────────────────────────────
  app.delete('/cron/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const [deleted] = await query('DELETE FROM cron_jobs WHERE id = $1 RETURNING id', [id])
    if (!deleted) return reply.code(404).send({ error: 'Cron job not found' })
    return { ok: true }
  })

  // ── POST /api/daemon/obsidian/sync ──────────────────────────────
  // Trigger manual git sync for Obsidian vault
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
  // Read an Obsidian markdown file (read-only)
  app.get('/obsidian/file', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: filePath } = req.query as { path: string }
    if (!filePath) return reply.code(400).send({ error: 'path query param required' })

    // Prevent path traversal
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

  // ── GET /api/daemon/obsidian/image ──────────────────────────────
  // Serve a binary image from the Obsidian vault
  app.get('/obsidian/image', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: filePath } = req.query as { path: string }
    if (!filePath) return reply.code(400).send({ error: 'path query param required' })

    const resolved = path.resolve(vaultRoot, filePath)
    if (!resolved.startsWith(path.resolve(vaultRoot))) {
      return reply.code(403).send({ error: 'Path traversal not allowed' })
    }

    const ext = path.extname(resolved).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif':  'image/gif',
      '.webp': 'image/webp',
      '.svg':  'image/svg+xml',
      '.bmp':  'image/bmp',
    }
    const contentType = mimeTypes[ext] ?? 'application/octet-stream'

    try {
      const data = fs.readFileSync(resolved)
      reply.header('Content-Type', contentType)
      reply.header('Cache-Control', 'public, max-age=3600')
      return reply.send(data)
    } catch {
      return reply.code(404).send({ error: 'Image not found' })
    }
  })

  // ── GET /api/daemon/obsidian/tree ───────────────────────────────
  // List directory tree from Obsidian vault
  app.get('/obsidian/tree', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: dirPath = '' } = req.query as { path?: string }
    const resolved = path.resolve(vaultRoot, dirPath)

    if (!resolved.startsWith(path.resolve(vaultRoot))) {
      return reply.code(403).send({ error: 'Path traversal not allowed' })
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const items = entries
        .filter(e => !e.name.startsWith('.'))  // skip .git, .obsidian
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
          path: path.join(dirPath, e.name),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      return { path: dirPath, items }
    } catch {
      return reply.code(404).send({ error: 'Directory not found' })
    }
  })
}
