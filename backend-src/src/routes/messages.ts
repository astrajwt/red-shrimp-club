// Messages routes — /api/messages
// GET  /channel/:channelId?limit=&before=   (history with pagination)
// POST /                                    (send message, with optional attachments & @mentions)
// WebSocket handles real-time delivery

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import { createStoredMessage, type MessageSenderType } from '../services/message-store.js'

const OPTION_ITEM_RE = /^\[([A-Za-z\d])\]\s+(.+)$/

interface ParsedDecisionItem {
  index: number
  label: string
  text: string
  details: string[]
}

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

function parseDecisionItems(content: string): ParsedDecisionItem[] {
  const lines = content.split(/\r?\n/)
  const items: ParsedDecisionItem[] = []

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? ''
    const trimmed = rawLine.trim()
    const optionMatch = trimmed.match(OPTION_ITEM_RE)
    if (!optionMatch) continue

    const details: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const detailRaw = lines[j] ?? ''
      const detailTrimmed = detailRaw.trim()
      if (!detailTrimmed) continue
      if (detailTrimmed.match(OPTION_ITEM_RE)) break
      if (!/^\s+/.test(detailRaw) && !detailTrimmed.startsWith('>')) break
      details.push(detailTrimmed.replace(/^>\s?/, ''))
      i = j
    }

    items.push({
      index: items.length,
      label: optionMatch[1]!.toUpperCase(),
      text: optionMatch[2]!.trim(),
      details,
    })
  }

  return items
}

const MSG_COLUMNS = `m.id, m.channel_id, m.sender_id, m.sender_type, m.sender_name, m.content, m.seq, m.attachments, m.mentions, m.thinking, m.created_at`

export const messageRoutes: FastifyPluginAsync = async (app) => {
  await query(`
    CREATE TABLE IF NOT EXISTS message_feedbacks (
      message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_index  INT NOT NULL,
      verdict     VARCHAR(10) NOT NULL CHECK (verdict IN ('correct', 'wrong', 'selected')),
      item_label  VARCHAR(20),
      item_text   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id, item_index)
    )
  `).catch(() => {})
  await query(`
    ALTER TABLE message_feedbacks
      ADD COLUMN IF NOT EXISTS item_label VARCHAR(20),
      ADD COLUMN IF NOT EXISTS item_text TEXT
  `).catch(() => {})

  // ── GET /api/messages/channel/:channelId ─────────────────────────
  app.get('/channel/:channelId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { channelId } = req.params as { channelId: string }
    const { limit = '50', before } = req.query as { limit?: string; before?: string }

    const lim = Math.min(Number(limit), 100)

    let sql: string
    let params: unknown[]

    if (before) {
      sql = `
        SELECT ${MSG_COLUMNS},
               COALESCE((
                 SELECT jsonb_object_agg(mf.item_index::text, mf.verdict)
                 FROM message_feedbacks mf
                 WHERE mf.message_id = m.id AND mf.user_id = $4
               ), '{}'::jsonb) AS feedback
        FROM messages m
        WHERE m.channel_id = $1 AND m.seq < $2
        ORDER BY m.seq DESC
        LIMIT $3
      `
      params = [channelId, Number(before), lim, caller.sub]
    } else {
      sql = `
        SELECT ${MSG_COLUMNS},
               COALESCE((
                 SELECT jsonb_object_agg(mf.item_index::text, mf.verdict)
                 FROM message_feedbacks mf
                 WHERE mf.message_id = m.id AND mf.user_id = $3
               ), '{}'::jsonb) AS feedback
        FROM messages m
        WHERE m.channel_id = $1
        ORDER BY m.seq DESC
        LIMIT $2
      `
      params = [channelId, lim, caller.sub]
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

    const msg = await createStoredMessage({
      channelId,
      senderId,
      senderType: senderType as MessageSenderType,
      senderName,
      content,
      attachments,
      mentions,
    })
    return msg
  })

  // ── POST /api/messages/:messageId/feedback ──────────────────────
  app.post('/:messageId/feedback', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { messageId } = req.params as { messageId: string }
    const { itemIndex, verdict } = req.body as { itemIndex?: number; verdict?: string }

    const user = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE id = $1',
      [caller.sub]
    )
    if (!user) return reply.code(403).send({ error: 'Only human users can submit message feedback' })
    if (!Number.isInteger(itemIndex) || Number(itemIndex) < 0) {
      return reply.code(400).send({ error: 'itemIndex must be a non-negative integer' })
    }
    if (verdict !== 'correct' && verdict !== 'wrong' && verdict !== 'selected') {
      return reply.code(400).send({ error: 'verdict must be "correct", "wrong", or "selected"' })
    }

    const message = await queryOne<{
      id: string
      channel_id: string
      sender_name: string
      content: string
    }>(
      'SELECT id, channel_id, sender_name, content FROM messages WHERE id = $1',
      [messageId]
    )
    if (!message) return reply.code(404).send({ error: 'Message not found' })

    let itemLabel: string | null = null
    let itemText: string | null = null
    let shouldEchoSelection = false

    if (verdict === 'selected') {
      const parsedOptions = parseDecisionItems(message.content)
      const selectedItem = parsedOptions.find(item => item.index === Number(itemIndex))
      if (!selectedItem) {
        return reply.code(400).send({ error: 'Selected itemIndex must point to a Donovan decision option' })
      }

      itemLabel = selectedItem.label
      itemText = [selectedItem.text, ...selectedItem.details].join('\n').trim()

      const existingSelected = await queryOne<{ item_index: number }>(
        `SELECT item_index
         FROM message_feedbacks
         WHERE message_id = $1 AND user_id = $2 AND verdict = 'selected'`,
        [messageId, caller.sub]
      )

      shouldEchoSelection = existingSelected?.item_index !== Number(itemIndex)

      await query(
        `DELETE FROM message_feedbacks
         WHERE message_id = $1 AND user_id = $2 AND verdict = 'selected' AND item_index <> $3`,
        [messageId, caller.sub, Number(itemIndex)]
      )
    }

    await query(
      `INSERT INTO message_feedbacks (message_id, user_id, item_index, verdict, item_label, item_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id, user_id, item_index)
       DO UPDATE SET
         verdict = EXCLUDED.verdict,
         item_label = EXCLUDED.item_label,
         item_text = EXCLUDED.item_text,
         updated_at = NOW()`,
      [messageId, caller.sub, Number(itemIndex), verdict, itemLabel, itemText]
    )

    if (verdict === 'selected' && shouldEchoSelection && itemLabel && itemText) {
      await createStoredMessage({
        channelId: message.channel_id,
        senderId: caller.sub,
        senderType: 'human',
        senderName: user.name,
        content: `我选择了 ${message.sender_name} 的方案 [${itemLabel}] ${itemText.split('\n')[0]}`,
      })
    }

    const feedbackRow = await queryOne<{ feedback: Record<string, 'correct' | 'wrong' | 'selected'> }>(
      `SELECT COALESCE(jsonb_object_agg(item_index::text, verdict), '{}'::jsonb) AS feedback
       FROM message_feedbacks
       WHERE message_id = $1 AND user_id = $2`,
      [messageId, caller.sub]
    )

    return { ok: true, feedback: feedbackRow?.feedback ?? {} }
  })

  // ── GET /api/messages/sync/:channelId?after= ────────────────────
  // Used by agents to catch up on missed messages
  app.get('/sync/:channelId', { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as { channelId: string }
    const { after = '0' } = req.query as { after?: string }

    const msgs = await query(
      `SELECT ${MSG_COLUMNS} FROM messages m WHERE m.channel_id = $1 AND m.seq > $2 ORDER BY m.seq`,
      [channelId, Number(after)]
    )
    return { messages: msgs }
  })
}
