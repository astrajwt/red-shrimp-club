// Messages routes — /api/messages
// GET  /channel/:channelId?limit=&before=   (history with pagination)
// POST /                                    (send message, with optional attachments & @mentions)
// WebSocket handles real-time delivery

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import { broadcastMessage } from '../socket/index.js'

// Parse @mentions from message content, returns array of { name, id? }
function parseMentions(content: string): { name: string }[] {
  const mentionRegex = /@(\w+)/g
  const mentions: { name: string }[] = []
  let match
  while ((match = mentionRegex.exec(content)) !== null) {
    mentions.push({ name: match[1] })
  }
  return mentions
}

const MSG_COLUMNS = `id, channel_id, sender_id, sender_type, sender_name, content, seq, attachments, mentions, created_at`

export const messageRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/messages/channel/:channelId ─────────────────────────
  app.get('/channel/:channelId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as { channelId: string }
    const { limit = '50', before } = req.query as { limit?: string; before?: string }

    const lim = Math.min(Number(limit), 100)

    let sql: string
    let params: unknown[]

    if (before) {
      sql = `
        SELECT ${MSG_COLUMNS}
        FROM messages
        WHERE channel_id = $1 AND seq < $2
        ORDER BY seq DESC
        LIMIT $3
      `
      params = [channelId, Number(before), lim]
    } else {
      sql = `
        SELECT ${MSG_COLUMNS}
        FROM messages
        WHERE channel_id = $1
        ORDER BY seq DESC
        LIMIT $2
      `
      params = [channelId, lim]
    }

    const msgs = await query(sql, params)
    return msgs.reverse()
  })

  // ── POST /api/messages ───────────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string; type?: string; name?: string }
    const { channelId, content, fileIds } = req.body as {
      channelId: string; content: string; fileIds?: string[]
    }

    if (!content?.trim() && !fileIds?.length) return reply.code(400).send({ error: 'content required' })

    // Determine sender info (human or agent)
    let senderType = 'human'
    let senderName = ''
    let senderId   = caller.sub

    const user = await queryOne<{ name: string }>(
      'SELECT name FROM users WHERE id = $1', [caller.sub]
    )
    if (user) {
      senderName = user.name
    } else {
      const agent = await queryOne<{ name: string }>(
        'SELECT name FROM agents WHERE id = $1', [caller.sub]
      )
      if (agent) {
        senderType = 'agent'
        senderName = agent.name
      }
    }

    // Build attachments from fileIds
    let attachments: any[] = []
    if (fileIds?.length) {
      const placeholders = fileIds.map((_, i) => `$${i + 1}`).join(', ')
      const files = await query(
        `SELECT id, filename, mime_type, size_bytes, storage_path FROM files WHERE id IN (${placeholders})`,
        fileIds
      )
      attachments = files.map((f: any) => ({
        file_id: f.id,
        filename: f.filename,
        mime_type: f.mime_type,
        size: f.size_bytes,
        url: `/uploads/${f.storage_path.split('/').pop()}`,
      }))

      // Log file attachments
      console.log(`[${new Date().toISOString()}] [MSG] ${senderName} attached ${attachments.length} file(s): ${attachments.map((a: any) => `${a.filename} (${a.mime_type})`).join(', ')}`)
    }

    // Parse @mentions
    const rawMentions = parseMentions(content)
    let mentions: any[] = []
    if (rawMentions.length) {
      // Resolve mention names to IDs (check both users and agents)
      for (const m of rawMentions) {
        const mentionedAgent = await queryOne<{ id: string; name: string }>(
          'SELECT id, name FROM agents WHERE LOWER(name) = LOWER($1)', [m.name]
        )
        if (mentionedAgent) {
          mentions.push({ id: mentionedAgent.id, name: mentionedAgent.name, type: 'agent' })
          continue
        }
        const mentionedUser = await queryOne<{ id: string; name: string }>(
          'SELECT id, name FROM users WHERE LOWER(name) = LOWER($1)', [m.name]
        )
        if (mentionedUser) {
          mentions.push({ id: mentionedUser.id, name: mentionedUser.name, type: 'human' })
        }
      }
    }

    // Atomically increment channel sequence
    const seqRow = await queryOne<{ last_seq: string }>(
      `INSERT INTO channel_sequences (channel_id, last_seq) VALUES ($1, 1)
       ON CONFLICT (channel_id) DO UPDATE SET last_seq = channel_sequences.last_seq + 1
       RETURNING last_seq`,
      [channelId]
    )
    const seq = Number(seqRow?.last_seq ?? 1)

    const [msg] = await query(
      `INSERT INTO messages
         (channel_id, sender_id, sender_type, sender_name, content, seq, attachments, mentions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [channelId, senderId, senderType, senderName, content.trim(), seq,
       JSON.stringify(attachments), JSON.stringify(mentions)]
    )

    broadcastMessage(channelId, msg)
    return msg
  })

  // ── GET /api/messages/sync/:channelId?after= ────────────────────
  // Used by agents to catch up on missed messages
  app.get('/sync/:channelId', { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as { channelId: string }
    const { after = '0' } = req.query as { after?: string }

    const msgs = await query(
      `SELECT ${MSG_COLUMNS} FROM messages WHERE channel_id = $1 AND seq > $2 ORDER BY seq`,
      [channelId, Number(after)]
    )
    return { messages: msgs }
  })
}
