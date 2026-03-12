// Agents routes — /api/agents
// GET    /              list agents in server
// POST   /              create agent
// GET    /:id           get agent detail
// PATCH  /:id/activity  update activity status
// POST   /:id/start     start agent (calls daemon)
// POST   /:id/stop      stop agent
// POST   /:id/heartbeat agent heartbeat ping
// GET    /:id/logs      get agent logs (paginated)
// GET    /servers        list servers for current user

import type { FastifyPluginAsync } from 'fastify'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { query, queryOne } from '../db/client.js'
import { processManager, SUPPORTED_RUNTIMES } from '../daemon/process-manager.js'
import type { AgentConfig, RuntimeId } from '../daemon/process-manager.js'
import { initAgentWorkspace } from '../daemon/workspace-init.js'
import { llmClient } from '../daemon/llm-client.js'

export const agentRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/agents ───────────────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const { serverId } = req.query as { serverId?: string }
    const caller = req.user as { sub: string }

    const agents = await query(
      `SELECT a.id, a.name, a.description, a.model_provider, a.model_id,
              a.runtime, a.status, a.activity, a.activity_detail,
              a.last_heartbeat_at, a.workspace_path, a.created_at,
              a.role, a.parent_agent_id
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE ($2::uuid IS NULL OR a.server_id = $2::uuid)
       ORDER BY a.name`,
      [caller.sub, serverId ?? null]
    )
    return agents
  })

  // ── POST /api/agents ──────────────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    let { serverId, machineId, name, description, role, modelId, modelProvider, runtime, workspacePath, systemPrompt } =
      req.body as {
        serverId?: string; machineId?: string; name: string; description?: string;
        role?: string; modelId?: string; modelProvider?: string;
        runtime?: string; workspacePath?: string; systemPrompt?: string;
      }

    if (!name?.trim()) return reply.code(400).send({ error: 'name required' })

    // Validate runtime
    const resolvedRuntime = (runtime ?? 'claude') as RuntimeId
    if (!SUPPORTED_RUNTIMES.includes(resolvedRuntime)) {
      return reply.code(400).send({ error: `Unsupported runtime: ${runtime}. Supported: ${SUPPORTED_RUNTIMES.join(', ')}` })
    }

    // Auto-resolve serverId from user's primary server if not provided
    if (!serverId) {
      const server = await queryOne<{ id: string }>(
        `SELECT s.id FROM servers s
         JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
         LIMIT 1`,
        [caller.sub]
      )
      if (!server) return reply.code(400).send({ error: 'No server found for user' })
      serverId = server.id
    }

    // Auto-assign workspace path if not provided
    // Default: <project>/shrimps/<name>  (i.e. backend-src/../shrimps/)
    const agentsBaseDir = process.env.AGENTS_WORKSPACE_DIR ?? join(process.cwd(), '..', 'shrimps')
    const resolvedWorkspace = workspacePath?.trim()
      || join(agentsBaseDir, name.trim().toLowerCase().replace(/\s+/g, '-'))

    const [agent] = await query(
      `INSERT INTO agents
         (server_id, machine_id, name, description, model_id, model_provider, runtime, workspace_path, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        serverId, machineId ?? null, name.trim(), description ?? null,
        modelId ?? 'claude-sonnet-4-6',
        modelProvider ?? 'anthropic',
        runtime ?? 'claude',
        resolvedWorkspace,
        role ?? 'general',
      ]
    )

    // Add agent to server's #all channel
    const allChannel = await queryOne<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND name = 'all' LIMIT 1`,
      [serverId]
    )
    if (allChannel) {
      await query(
        `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [allChannel.id, agent.id]
      )
    }

    // Initialize workspace with MEMORY.md, CLAUDE.md, HEARTBEAT.md
    const serverUrl = process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 3001}`
    initAgentWorkspace(resolvedWorkspace, {
      agentId:      agent.id,
      agentName:    agent.name,
      description:  agent.description ?? null,
      role:         (role as any) ?? 'general',
      modelId:      agent.model_id,
      serverUrl,
      channelName:  '#all',
      teamContext:  '红虾俱乐部 (Red Shrimp Lab) — multi-agent collaboration system. Team includes human users and AI agents communicating via mcp__chat tools.',
      customPrompt: systemPrompt ?? undefined,
    }).catch(err => console.error(`[workspace] Init failed for ${agent.name}:`, err.message))

    return { agent }
  })

  // ── GET /api/agents/:id ───────────────────────────────────────────
  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await queryOne('SELECT * FROM agents WHERE id = $1', [id])
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    return agent
  })

  // ── PATCH /api/agents/:id/activity ───────────────────────────────
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
  app.post('/:id/start', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await queryOne<{
      id: string; name: string; runtime: string; model_id: string;
      machine_id: string | null; workspace_path: string | null;
    }>('SELECT * FROM agents WHERE id = $1', [id])

    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    // Use SERVER_URL if set, fall back to local server URL
    const serverUrl = process.env.SERVER_URL
      ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 3001}`

    // Generate a temp API key for this agent session
    const apiKey = `agent_${id}_${Date.now()}`

    const config: AgentConfig = {
      id:            agent.id,
      name:          agent.name,
      machineId:     agent.machine_id ?? 'local',
      serverUrl,
      apiKey,
      workspacePath: agent.workspace_path ?? process.cwd(),
      runtime:       agent.runtime,
      modelId:       agent.model_id,
    }

    await processManager.spawn(config)
    return { ok: true, message: `Agent ${agent.name} starting` }
  })

  // ── POST /api/agents/:id/stop ─────────────────────────────────────
  app.post('/:id/stop', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    await processManager.stop(id)
    await query(`UPDATE agents SET status = 'offline', activity = NULL WHERE id = $1`, [id])
    return { ok: true }
  })

  // ── POST /api/agents/:id/heartbeat ────────────────────────────────
  // Called by the Agent process itself every 30s
  app.post('/:id/heartbeat', async (req) => {
    const { id } = req.params as { id: string }
    const { tokenUsage } = req.body as { tokenUsage?: number }

    processManager.updateHeartbeat(id)
    await query(
      `UPDATE agents SET last_heartbeat_at = NOW() WHERE id = $1`,
      [id]
    )

    // Track token usage for handoff threshold monitoring
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
  // ── POST /api/agents/:id/reset-context ───────────────────────────
  // Summarize current context into MEMORY.md, then stop the agent so it
  // restarts fresh with the condensed memory on next start.
  app.post('/:id/reset-context', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await queryOne<{
      id: string; name: string; workspace_path: string | null; model_id: string;
    }>('SELECT id, name, workspace_path, model_id FROM agents WHERE id = $1', [id])
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const workspacePath = agent.workspace_path ?? ''
    const memoryPath = join(workspacePath, 'MEMORY.md')

    // Read existing MEMORY.md
    let currentMemory = ''
    try { currentMemory = await readFile(memoryPath, 'utf-8') } catch { /* no file yet */ }

    // Read recent logs for context
    const logs = await query(
      `SELECT level, content FROM agent_logs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 80`,
      [id]
    )
    const logText = (logs as any[]).reverse()
      .map((l: any) => `[${l.level}] ${l.content}`)
      .join('\n')

    // Ask LLM to write a condensed MEMORY.md
    const resp = await llmClient.complete({
      model: agent.model_id,
      prompt: `You are compacting the memory of AI shrimp "${agent.name}".

Current MEMORY.md:
\`\`\`
${currentMemory || '(empty)'}
\`\`\`

Recent activity logs (newest at bottom):
\`\`\`
${logText || '(none)'}
\`\`\`

Write an updated MEMORY.md that:
1. Preserves the Identity section exactly
2. Summarizes key findings, decisions, and completed work from the logs
3. Notes any in-progress tasks or important state
4. Stays under 150 lines

Output only the raw Markdown content for MEMORY.md, nothing else.`,
    })

    // Write compacted memory
    await writeFile(memoryPath, resp.text, 'utf-8')

    // Log the compaction event
    await query(
      `INSERT INTO agent_logs (agent_id, level, content) VALUES ($1, 'info', $2)`,
      [id, `[compact] Context summarized (${resp.tokensUsed} tokens used). MEMORY.md updated. Restart to apply.`]
    )

    // Stop the agent process (it will reload from fresh MEMORY.md on next start)
    try { await processManager.stop(id) } catch { /* already stopped */ }
    await query(`UPDATE agents SET status = 'offline', activity = NULL WHERE id = $1`, [id])

    return { ok: true, tokensUsed: resp.tokensUsed }
  })

  // ── DELETE /api/agents/:id ────────────────────────────────────────
  app.delete('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    // Verify ownership (agent must belong to caller's server)
    const rows = await query(
      `SELECT a.id, a.workspace_path, a.status FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE a.id = $2`,
      [caller.sub, id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'not found' })

    const agent = rows[0] as { id: string; workspace_path: string | null; status: string }

    // Stop if running
    try { await processManager.stop(id) } catch { /* already stopped */ }

    // Delete DB records (logs and runs cascade via FK)
    await query(`DELETE FROM agent_logs WHERE agent_id = $1`, [id])
    await query(`DELETE FROM agent_runs WHERE agent_id = $1`, [id])
    await query(`DELETE FROM agents WHERE id = $1`, [id])

    return { ok: true }
  })

  // ── GET /api/agents/:id/logs ──────────────────────────────────────
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
