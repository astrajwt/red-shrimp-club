// Channels routes — /api/channels
// GET  /           list channels in server
// POST /           create channel
// GET  /dm         list DM channels
// POST /dm         open a DM
// GET  /unread     unread counts per channel
// POST /:id/join   join a channel
// GET  /:id/members  list members

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'

export const channelRoutes: FastifyPluginAsync = async (app) => {
  await query(`
    ALTER TABLE channels
      ADD COLUMN IF NOT EXISTS task_id UUID REFERENCES tasks(id) ON DELETE SET NULL
  `).catch(() => {})
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS channels_task_id_unique
      ON channels(task_id) WHERE task_id IS NOT NULL
  `).catch(() => {})

  // ── GET /api/channels ─────────────────────────────────────────────
  // Returns public channels in the user's primary server (or specified server)
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { serverId } = req.query as { serverId?: string }

    // Default to user's primary (owned) server
    let targetServerId = serverId ?? null
    if (!targetServerId) {
      const primary = await queryOne<{ server_id: string }>(
        `SELECT server_id FROM server_members WHERE user_id = $1 ORDER BY role = 'owner' DESC, joined_at ASC LIMIT 1`,
        [caller.sub]
      )
      targetServerId = primary?.server_id ?? null
    }

    const rows = await query(
      `SELECT c.id, c.name, c.description, c.type, c.server_id,
              (cm.user_id IS NOT NULL OR cm.agent_id IS NOT NULL) AS joined
       FROM channels c
       JOIN servers s ON s.id = c.server_id
       JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
       LEFT JOIN channel_members cm
         ON cm.channel_id = c.id AND (cm.user_id = $1 OR cm.agent_id = $1)
       WHERE c.type = 'channel'
         AND ($2::uuid IS NULL OR c.server_id = $2::uuid)
       ORDER BY CASE WHEN c.name = 'all' THEN 0 ELSE 1 END, c.name`,
      [caller.sub, targetServerId]
    )
    return rows
  })

  // ── POST /api/channels ───────────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { serverId, name, description } = req.body as {
      serverId: string; name: string; description?: string
    }

    // Only server members can create channels
    const member = await queryOne(
      'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
      [serverId, caller.sub]
    )
    if (!member) return reply.code(403).send({ error: 'Not a server member' })

    const [channel] = await query(
      `INSERT INTO channels (server_id, name, description) VALUES ($1, $2, $3) RETURNING *`,
      [serverId, name.toLowerCase().replace(/\s+/g, '-'), description]
    )
    return channel
  })

  // ── GET /api/channels/dm ─────────────────────────────────────────
  app.get('/dm', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const dms = await query(
      `SELECT c.id, c.name, c.type,
              -- Get the other participant's name as channel display name
              COALESCE(u.name, a.name) AS display_name,
              true AS joined
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
       JOIN channel_members cm2 ON cm2.channel_id = c.id AND (cm2.user_id != $1 OR cm2.agent_id IS NOT NULL)
       LEFT JOIN users u  ON u.id  = cm2.user_id
       LEFT JOIN agents a ON a.id  = cm2.agent_id
       WHERE c.type = 'dm'`,
      [caller.sub]
    )
    return dms
  })

  // ── POST /api/channels/dm ────────────────────────────────────────
  app.post('/dm', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { agentId, userId } = req.body as { agentId?: string; userId?: string }

    const targetId   = agentId ?? userId
    const targetType = agentId ? 'agent' : 'user'
    if (!targetId) throw new Error('agentId or userId required')

    // Check if DM already exists
    const existing = await queryOne<{ id: string }>(
      `SELECT c.id FROM channels c
       JOIN channel_members cm1 ON cm1.channel_id = c.id AND cm1.user_id = $1
       JOIN channel_members cm2 ON cm2.channel_id = c.id
         AND ($3 = 'agent' AND cm2.agent_id = $2 OR $3 = 'user' AND cm2.user_id = $2)
       WHERE c.type = 'dm'
       LIMIT 1`,
      [caller.sub, targetId, targetType]
    )
    if (existing) return existing

    // Create new DM channel
    const name = `dm-${Date.now()}`
    const [channel] = await query(
      `INSERT INTO channels (server_id, name, type)
       SELECT sm.server_id, $1, 'dm' FROM server_members sm WHERE sm.user_id = $2 LIMIT 1
       RETURNING *`,
      [name, caller.sub]
    )

    // Add both participants
    await query(
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
      [channel.id, caller.sub]
    )
    if (targetType === 'agent') {
      await query(
        `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2)`,
        [channel.id, targetId]
      )
    } else {
      await query(
        `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
        [channel.id, targetId]
      )
    }

    return channel
  })

  // ── GET /api/channels/unread ─────────────────────────────────────
  app.get('/unread', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const rows = await query<{ channel_id: string; unread: string }>(
      `SELECT c.id AS channel_id,
              GREATEST(0, COALESCE(cs.last_seq, 0) - COALESCE(cr.last_read_seq, 0)) AS unread
       FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
       LEFT JOIN channel_sequences cs ON cs.channel_id = c.id
       LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = $1`,
      [caller.sub]
    )
    // Return as { channelId: count } map
    return Object.fromEntries(rows.map(r => [r.channel_id, Number(r.unread)]))
  })

  // ── POST /api/channels/:id/join ───────────────────────────────────
  app.post('/:id/join', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    await query(
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, caller.sub]
    )
    return { ok: true }
  })

  // ── POST /api/channels/:id/invite ────────────────────────────────
  // Invite a Shrimp (agent) or user to a channel
  app.post('/:id/invite', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { agentId, userId } = req.body as { agentId?: string; userId?: string }

    if (!agentId && !userId) return reply.code(400).send({ error: 'agentId or userId required' })

    if (agentId) {
      await query(
        `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, agentId]
      )
    } else {
      await query(
        `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [id, userId]
      )
    }
    return { ok: true }
  })

  // ── GET /api/channels/:id/members ──────────────────────────────
  app.get('/:id/members', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const members = await query(
      `SELECT cm.channel_id,
              COALESCE(u.id, a.id) AS member_id,
              COALESCE(u.name, a.name) AS name,
              CASE WHEN u.id IS NOT NULL THEN 'human' ELSE 'agent' END AS type,
              cm.joined_at
       FROM channel_members cm
       LEFT JOIN users u ON u.id = cm.user_id
       LEFT JOIN agents a ON a.id = cm.agent_id
       WHERE cm.channel_id = $1
       ORDER BY cm.joined_at`,
      [id]
    )
    return members
  })

  // ── POST /api/channels/:id/read ───────────────────────────────────
  // Mark channel as read up to a given seq
  app.post('/:id/read', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { seq } = req.body as { seq: number }

    await query(
      `INSERT INTO channel_reads (user_id, channel_id, last_read_seq) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_seq = GREATEST(channel_reads.last_read_seq, $3)`,
      [caller.sub, id, seq]
    )
    return { ok: true }
  })
}
