// Internal agent routes — /internal/agent/:agentId/*
// Used by chat-bridge.js (MCP server) to let shrimps send/receive messages
// These routes do NOT require JWT — they use agent ID directly (trusted internal)

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import { broadcastMessage } from '../socket/index.js'

export const internalRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /internal/agent/:agentId/send ──────────────────────────
  app.post('/:agentId/send', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, dm_to, content } = req.body as {
      channel?: string; dm_to?: string; content: string
    }

    const agent = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM agents WHERE id = $1', [agentId]
    )
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    let channelId: string | undefined

    if (dm_to) {
      // Find or create DM with the target — scoped to this agent's server
      const target = await queryOne<{ id: string; type: string }>(
        `SELECT u.id, 'user' AS type FROM users u
         JOIN server_members sm ON sm.user_id = u.id
         JOIN agents a ON a.server_id = sm.server_id AND a.id = $2
         WHERE LOWER(u.name) = LOWER($1)
         UNION ALL
         SELECT a2.id, 'agent' AS type FROM agents a2
         JOIN agents a ON a.server_id = a2.server_id AND a.id = $2
         WHERE LOWER(a2.name) = LOWER($1) AND a2.id != $2
         LIMIT 1`,
        [dm_to, agentId]
      )
      if (!target) return reply.code(404).send({ error: `User/agent "${dm_to}" not found` })

      // Check existing DM
      const existingDm = await queryOne<{ id: string }>(
        `SELECT c.id FROM channels c
         JOIN channel_members cm1 ON cm1.channel_id = c.id AND cm1.agent_id = $1
         JOIN channel_members cm2 ON cm2.channel_id = c.id
           AND (cm2.user_id = $2 OR cm2.agent_id = $2)
         WHERE c.type = 'dm' LIMIT 1`,
        [agentId, target.id]
      )
      if (existingDm) {
        channelId = existingDm.id
      } else {
        // Create DM channel
        const [ch] = await query(
          `INSERT INTO channels (server_id, name, type)
           SELECT a.server_id, $1, 'dm' FROM agents a WHERE a.id = $2 LIMIT 1
           RETURNING *`,
          [`dm-${Date.now()}`, agentId]
        )
        channelId = ch.id
        await query('INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channelId, agentId])
        if (target.type === 'user') {
          await query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channelId, target.id])
        } else {
          await query('INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channelId, target.id])
        }
      }
    } else if (channel) {
      // Resolve channel name (e.g. "#all" → channel ID) within this agent's server
      const chName = channel.replace(/^#/, '')
      const ch = await queryOne<{ id: string }>(
        `SELECT c.id FROM channels c
         JOIN agents a ON a.server_id = c.server_id
         WHERE a.id = $1 AND c.name = $2 LIMIT 1`,
        [agentId, chName]
      )
      if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })
      channelId = ch.id

      // Auto-join if not already a member
      await query(
        'INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [channelId, agentId]
      )
    } else {
      return reply.code(400).send({ error: 'channel or dm_to required' })
    }

    // Send message
    const seqRow = await queryOne<{ last_seq: string }>(
      `INSERT INTO channel_sequences (channel_id, last_seq) VALUES ($1, 1)
       ON CONFLICT (channel_id) DO UPDATE SET last_seq = channel_sequences.last_seq + 1
       RETURNING last_seq`,
      [channelId]
    )
    const seq = Number(seqRow?.last_seq ?? 1)

    const [msg] = await query(
      `INSERT INTO messages (channel_id, sender_id, sender_type, sender_name, content, seq, attachments, mentions)
       VALUES ($1, $2, 'agent', $3, $4, $5, '[]', '[]') RETURNING *`,
      [channelId, agentId, agent.name, content.trim(), seq]
    )

    broadcastMessage(channelId!, msg)

    // Update agent heartbeat
    await query("UPDATE agents SET last_heartbeat_at = NOW() WHERE id = $1", [agentId])

    return { ok: true, messageId: msg.id }
  })

  // ── GET /internal/agent/:agentId/receive ────────────────────────
  app.get('/:agentId/receive', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { block, timeout } = req.query as { block?: string; timeout?: string }

    const agent = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM agents WHERE id = $1', [agentId]
    )
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    // Update heartbeat
    await query("UPDATE agents SET last_heartbeat_at = NOW() WHERE id = $1", [agentId])

    // Get channels this agent belongs to
    const channels = await query<{ channel_id: string }>(
      'SELECT channel_id FROM channel_members WHERE agent_id = $1', [agentId]
    )
    if (channels.length === 0) {
      // Auto-join this agent's server's #all channel
      const allCh = await queryOne<{ id: string }>(
        `SELECT c.id FROM channels c
         JOIN agents a ON a.server_id = c.server_id
         WHERE a.id = $1 AND c.name = 'all' LIMIT 1`,
        [agentId]
      )
      if (allCh) {
        await query('INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [allCh.id, agentId])
        channels.push({ channel_id: allCh.id })
      }
    }

    const channelIds = channels.map(c => c.channel_id)
    if (channelIds.length === 0) return { messages: [] }

    // Get last read position for each channel (agents use their own table, not channel_reads)
    const readPositions = await query<{ channel_id: string; last_read_seq: string }>(
      `SELECT channel_id, last_read_seq FROM agent_channel_reads WHERE agent_id = $1 AND channel_id = ANY($2)`,
      [agentId, channelIds]
    )
    const readMap = Object.fromEntries(readPositions.map(r => [r.channel_id, Number(r.last_read_seq)]))

    // Get unread messages
    let allMsgs: any[] = []
    for (const chId of channelIds) {
      const lastRead = readMap[chId] ?? 0
      const msgs = await query(
        `SELECT m.id, m.channel_id, m.sender_id, m.sender_type, m.sender_name, m.content, m.seq, m.created_at,
                c.name AS channel_name, c.type AS channel_type
         FROM messages m JOIN channels c ON c.id = m.channel_id
         WHERE m.channel_id = $1 AND m.seq > $2 AND m.sender_id != $3
         ORDER BY m.seq LIMIT 50`,
        [chId, lastRead, agentId]
      )
      allMsgs.push(...msgs)
    }

    // If blocking and no messages, poll
    if (block === 'true' && allMsgs.length === 0) {
      const timeoutMs = Math.min(Number(timeout) || 59000, 59000)
      const pollInterval = 2000
      const deadline = Date.now() + timeoutMs

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval))

        // Re-check for new messages
        allMsgs = []
        for (const chId of channelIds) {
          const lastRead = readMap[chId] ?? 0
          const msgs = await query(
            `SELECT m.id, m.channel_id, m.sender_id, m.sender_type, m.sender_name, m.content, m.seq, m.created_at,
                    c.name AS channel_name, c.type AS channel_type
             FROM messages m JOIN channels c ON c.id = m.channel_id
             WHERE m.channel_id = $1 AND m.seq > $2 AND m.sender_id != $3
             ORDER BY m.seq LIMIT 50`,
            [chId, lastRead, agentId]
          )
          allMsgs.push(...msgs)
        }
        if (allMsgs.length > 0) break

        // Update heartbeat during long poll
        await query("UPDATE agents SET last_heartbeat_at = NOW() WHERE id = $1", [agentId])
      }
    }

    // Update agent read positions in dedicated table
    for (const msg of allMsgs) {
      await query(
        `INSERT INTO agent_channel_reads (agent_id, channel_id, last_read_seq) VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, channel_id) DO UPDATE SET last_read_seq = GREATEST(agent_channel_reads.last_read_seq, $3)`,
        [agentId, msg.channel_id, msg.seq]
      )
    }

    // Format for chat-bridge
    const formatted = allMsgs.map(m => ({
      channel_name: m.channel_name,
      channel_type: m.channel_type,
      sender_name: m.sender_name,
      sender_type: m.sender_type,
      content: m.content,
      timestamp: m.created_at,
      // Tell the agent exactly how to reply
      reply_to: m.channel_type === 'dm'
        ? { dm_to: m.sender_name }
        : { channel: `#${m.channel_name}` },
    }))

    return { messages: formatted }
  })

  // ── GET /internal/agent/:agentId/server ─────────────────────────
  app.get('/:agentId/server', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }

    const channels = await query(
      `SELECT c.id, c.name, c.description, c.type,
              EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.agent_id = $1) AS joined
       FROM channels c
       JOIN agents a ON a.server_id = c.server_id AND a.id = $1
       WHERE c.type = 'channel' ORDER BY c.name`,
      [agentId]
    )

    const agents = await query(
      `SELECT a2.id, a2.name, a2.status FROM agents a2
       JOIN agents a ON a.server_id = a2.server_id AND a.id = $1
       WHERE a2.id != $1 ORDER BY a2.name`,
      [agentId]
    )

    const humans = await query(
      `SELECT u.id, u.name FROM users u
       JOIN server_members sm ON sm.user_id = u.id
       JOIN agents a ON a.server_id = sm.server_id AND a.id = $1
       ORDER BY u.name`,
      [agentId]
    )

    return { channels, agents, humans }
  })

  // ── GET /internal/agent/:agentId/history ────────────────────────
  app.get('/:agentId/history', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, limit, before, after } = req.query as {
      channel?: string; limit?: string; before?: string; after?: string
    }

    if (!channel) return reply.code(400).send({ error: 'channel required' })

    const chName = channel.replace(/^#/, '')
    const ch = await queryOne<{ id: string }>(
      `SELECT c.id FROM channels c
       JOIN agents a ON a.server_id = c.server_id
       WHERE a.id = $1 AND c.name = $2 LIMIT 1`,
      [agentId, chName]
    )
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const lim = Math.min(Number(limit) || 50, 100)
    let sql: string
    let params: unknown[]

    if (after) {
      sql = `SELECT m.id, m.sender_name AS "senderName", m.sender_type AS "senderType",
                    m.content, m.seq, m.created_at AS "createdAt"
             FROM messages m WHERE m.channel_id = $1 AND m.seq > $2
             ORDER BY m.seq LIMIT $3`
      params = [ch.id, Number(after), lim]
    } else if (before) {
      sql = `SELECT m.id, m.sender_name AS "senderName", m.sender_type AS "senderType",
                    m.content, m.seq, m.created_at AS "createdAt"
             FROM messages m WHERE m.channel_id = $1 AND m.seq < $2
             ORDER BY m.seq DESC LIMIT $3`
      params = [ch.id, Number(before), lim]
    } else {
      sql = `SELECT m.id, m.sender_name AS "senderName", m.sender_type AS "senderType",
                    m.content, m.seq, m.created_at AS "createdAt"
             FROM messages m WHERE m.channel_id = $1
             ORDER BY m.seq DESC LIMIT $2`
      params = [ch.id, lim]
    }

    const msgs = await query(sql, params)
    const messages = before || !after ? msgs.reverse() : msgs

    // Get last read seq
    const readRow = await queryOne<{ last_read_seq: string }>(
      'SELECT last_read_seq FROM channel_reads WHERE user_id = $1 AND channel_id = $2',
      [agentId, ch.id]
    )

    return {
      messages,
      has_more: messages.length >= lim,
      last_read_seq: Number(readRow?.last_read_seq ?? 0),
    }
  })

  // ── GET /internal/agent/:agentId/tasks ──────────────────────────
  app.get('/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, status } = req.query as { channel?: string; status?: string }

    if (!channel) return reply.code(400).send({ error: 'channel required' })

    const chName = channel.replace(/^#/, '')
    const ch = await queryOne<{ id: string }>(
      `SELECT c.id FROM channels c
       JOIN agents a ON a.server_id = c.server_id
       WHERE a.id = $1 AND c.name = $2 LIMIT 1`,
      [agentId, chName]
    )
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    let sql = `SELECT t.id, t.number AS "taskNumber", t.title, t.status,
                      t.claimed_by_name AS "claimedByName"
               FROM tasks t
               WHERE t.channel_id = $1`
    const params: unknown[] = [ch.id]

    if (status && status !== 'all') {
      sql += ` AND t.status = $2`
      params.push(status)
    }
    sql += ' ORDER BY t.number'

    const tasks = await query(sql, params)
    return { tasks }
  })

  // ── POST /internal/agent/:agentId/tasks ─────────────────────────
  app.post('/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, tasks } = req.body as { channel: string; tasks: { title: string }[] }

    const chName = channel.replace(/^#/, '')
    const ch = await queryOne<{ id: string }>('SELECT id FROM channels WHERE name = $1', [chName])
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const created = []
    for (const t of tasks) {
      const numRow = await queryOne<{ max: string }>('SELECT COALESCE(MAX(number), 0) AS max FROM tasks WHERE channel_id = $1', [ch.id])
      const num = Number(numRow?.max ?? 0) + 1
      const [task] = await query(
        `INSERT INTO tasks (channel_id, title, status, number) VALUES ($1, $2, 'open', $3) RETURNING *`,
        [ch.id, t.title, num]
      )
      created.push({ taskNumber: task.number, title: task.title })
    }
    return { tasks: created }
  })

  // ── POST /internal/agent/:agentId/tasks/claim ───────────────────
  app.post('/:agentId/tasks/claim', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_numbers } = req.body as { channel: string; task_numbers: number[] }

    const chName = channel.replace(/^#/, '')
    const ch = await queryOne<{ id: string }>('SELECT id FROM channels WHERE name = $1', [chName])
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const results = []
    for (const num of task_numbers) {
      const agent = await queryOne<{ id: string; name: string }>('SELECT id, name FROM agents WHERE id = $1', [agentId])
      const task = await queryOne<{ id: string; claimed_by_id: string | null }>(
        'SELECT id, claimed_by_id FROM tasks WHERE channel_id = $1 AND number = $2', [ch.id, num]
      )
      if (!task) {
        results.push({ taskNumber: num, success: false, reason: 'not found' })
      } else if (task.claimed_by_id) {
        results.push({ taskNumber: num, success: false, reason: 'already claimed' })
      } else {
        await query(
          "UPDATE tasks SET claimed_by_id = $1, claimed_by_type = 'agent', claimed_by_name = $2, claimed_at = NOW(), status = 'claimed' WHERE id = $3",
          [agentId, agent?.name ?? agentId, task.id]
        )
        results.push({ taskNumber: num, success: true })
      }
    }
    return { results }
  })

  // ── POST /internal/agent/:agentId/tasks/unclaim ─────────────────
  app.post('/:agentId/tasks/unclaim', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number } = req.body as { channel: string; task_number: number }

    const chName = channel.replace(/^#/, '')
    const ch = await queryOne<{ id: string }>('SELECT id FROM channels WHERE name = $1', [chName])
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    await query(
      "UPDATE tasks SET claimed_by_id = NULL, claimed_by_type = NULL, claimed_by_name = NULL, claimed_at = NULL, status = 'open' WHERE channel_id = $1 AND number = $2 AND claimed_by_id = $3",
      [ch.id, task_number, agentId]
    )
    return { ok: true }
  })

  // ── POST /internal/agent/:agentId/tasks/update-status ───────────
  app.post('/:agentId/tasks/update-status', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number, status } = req.body as {
      channel: string; task_number: number; status: string
    }

    const chName = channel.replace(/^#/, '')
    const ch = await queryOne<{ id: string }>('SELECT id FROM channels WHERE name = $1', [chName])
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    await query(
      'UPDATE tasks SET status = $1 WHERE channel_id = $2 AND number = $3',
      [status, ch.id, task_number]
    )
    return { ok: true }
  })
}
