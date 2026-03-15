// Bulletins routes — /api/bulletins
// GET    /              list bulletins (supports ?category=&limit=&before=)
// POST   /              create bulletin
// PATCH  /:id           update bulletin (pin/unpin, edit)
// DELETE /:id           delete bulletin

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'

export const bulletinRoutes: FastifyPluginAsync = async (app) => {

  // ── List bulletins ──────────────────────────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    const { category, limit = '50', before, server_id } = req.query as Record<string, string>

    const serverId = server_id || await getUserServerId(caller.sub)
    if (!serverId) return reply.code(400).send({ error: 'No server found' })

    const conditions = ['b.server_id = $1']
    const params: any[] = [serverId]
    let idx = 2

    if (category) {
      conditions.push(`b.category = $${idx}`)
      params.push(category)
      idx++
    }
    if (before) {
      conditions.push(`b.created_at < $${idx}`)
      params.push(before)
      idx++
    }

    const rows = await query(
      `SELECT b.*
       FROM bulletins b
       WHERE ${conditions.join(' AND ')}
       ORDER BY b.pinned DESC, b.created_at DESC
       LIMIT $${idx}`,
      [...params, Math.min(parseInt(limit) || 50, 100)]
    )

    return { bulletins: rows }
  })

  // ── Create bulletin ─────────────────────────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    const {
      category, title, content, priority,
      linked_file, linked_task_id, linked_url,
      metadata, pinned, server_id,
    } = req.body as any

    if (!category || !title) {
      return reply.code(400).send({ error: 'category and title are required' })
    }

    const serverId = server_id || await getUserServerId(caller.sub)
    if (!serverId) return reply.code(400).send({ error: 'No server found' })

    // Resolve author info
    const user = await queryOne<{ name: string }>('SELECT name FROM users WHERE id = $1', [caller.sub])
    const agent = !user
      ? await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [caller.sub])
      : null
    const authorType = user ? 'human' : 'agent'
    const authorName = (user ?? agent)?.name ?? 'unknown'

    const [bulletin] = await query(
      `INSERT INTO bulletins
         (server_id, category, title, content, author_id, author_type, author_name,
          priority, linked_file, linked_task_id, linked_url, metadata, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        serverId, category, title.trim(), content ?? null,
        caller.sub, authorType, authorName,
        priority ?? 'normal',
        linked_file ?? null, linked_task_id ?? null, linked_url ?? null,
        metadata ? JSON.stringify(metadata) : '{}',
        pinned ?? false,
      ]
    )

    return { bulletin }
  })

  // ── Update bulletin ─────────────────────────────────────────────────────────
  app.patch('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    const { id } = req.params as { id: string }
    const updates = req.body as Record<string, any>

    const allowed = ['title', 'content', 'category', 'priority', 'linked_file', 'linked_url', 'linked_task_id', 'metadata', 'pinned']
    const sets: string[] = []
    const params: any[] = []
    let idx = 1

    for (const key of allowed) {
      if (key in updates) {
        sets.push(`${key} = $${idx}`)
        params.push(key === 'metadata' ? JSON.stringify(updates[key]) : updates[key])
        idx++
      }
    }

    if (sets.length === 0) return reply.code(400).send({ error: 'No valid fields to update' })

    sets.push(`updated_at = NOW()`)
    params.push(id)

    const [updated] = await query(
      `UPDATE bulletins SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    )

    if (!updated) return reply.code(404).send({ error: 'Bulletin not found' })
    return { bulletin: updated }
  })

  // ── Delete bulletin ─────────────────────────────────────────────────────────
  app.delete('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    const { id } = req.params as { id: string }
    const [deleted] = await query(
      'DELETE FROM bulletins WHERE id = $1 RETURNING id',
      [id]
    )

    if (!deleted) return reply.code(404).send({ error: 'Bulletin not found' })
    return { ok: true }
  })

  // ── Dashboard summary (for homepage) ────────────────────────────────────────
  app.get('/dashboard', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    const { server_id } = req.query as Record<string, string>
    const serverId = server_id || await getUserServerId(caller.sub)
    if (!serverId) return reply.code(400).send({ error: 'No server found' })

    // Get leader agents (coordinator, tech-lead, ops) with their sub-agents
    const leaders = await query(
      `SELECT a.id, a.name, a.role, a.status, a.last_heartbeat_at,
              a.parent_agent_id, a.description
       FROM agents a
       WHERE a.server_id = $1
       ORDER BY
         CASE a.role
           WHEN 'coordinator' THEN 0
           WHEN 'tech-lead' THEN 1
           WHEN 'ops' THEN 2
           ELSE 3
         END,
         a.created_at`,
      [serverId]
    )

    // Get active tasks with assignees
    const activeTasks = await query(
      `SELECT t.id, t.title, t.status, t.number as display_number,
              t.claimed_by_id as assigned_agent_id, t.claimed_by_name as agent_name,
              t.created_at, t.created_at as updated_at
       FROM tasks t
       WHERE t.channel_id IN (
         SELECT id FROM channels WHERE server_id = $1
       )
       AND t.status IN ('open', 'in_progress', 'reviewing')
       ORDER BY
         CASE t.status
           WHEN 'in_progress' THEN 0
           WHEN 'reviewing' THEN 1
           WHEN 'open' THEN 2
           ELSE 3
         END,
         t.created_at DESC
       LIMIT 20`,
      [serverId]
    )

    // Get recent activity (last 10 log entries)
    const recentActivity = await query(
      `SELECT al.agent_id, a.name as agent_name, al.level, al.content, al.created_at
       FROM agent_logs al
       JOIN agents a ON al.agent_id = a.id
       WHERE a.server_id = $1
         AND al.level = 'INFO'
         AND al.content NOT LIKE '%heartbeat%'
       ORDER BY al.created_at DESC
       LIMIT 10`,
      [serverId]
    )

    // Get bookmarks
    const bookmarks = await query(
      `SELECT * FROM bulletins
       WHERE server_id = $1 AND category = 'bookmark'
       ORDER BY pinned DESC, created_at ASC`,
      [serverId]
    )

    // Get sticky notes (human-created)
    const stickies = await query(
      `SELECT * FROM bulletins
       WHERE server_id = $1 AND category = 'sticky'
       ORDER BY pinned DESC, created_at DESC`,
      [serverId]
    )

    return { leaders, activeTasks, recentActivity, bookmarks, stickies }
  })
}

async function getUserServerId(userId: string): Promise<string | null> {
  // Find user's primary server (owner first, then earliest joined)
  const row = await queryOne<{ server_id: string }>(
    `SELECT server_id FROM server_members
     WHERE user_id = $1
     ORDER BY role = 'owner' DESC, joined_at ASC
     LIMIT 1`,
    [userId]
  )
  if (row) return row.server_id
  // Fallback to any server
  const fallback = await queryOne<{ id: string }>('SELECT id FROM servers LIMIT 1')
  return fallback?.id ?? null
}

async function getDefaultServerId(): Promise<string | null> {
  const row = await queryOne<{ id: string }>('SELECT id FROM servers LIMIT 1')
  return row?.id ?? null
}
