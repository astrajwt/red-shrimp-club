// Internal agent routes — /internal/agent/:agentId/*
// Used by chat-bridge.js (MCP server) to let shrimps send/receive messages
// These routes do NOT require JWT — they use agent ID directly (trusted internal)

import type { FastifyPluginAsync } from 'fastify'
import fs from 'fs'
import path from 'path'
import { query, queryOne } from '../db/client.js'
import { emitTaskAllCompleted, emitTaskCompleted, emitTaskDocAdded, emitTaskUpdated } from '../daemon/events.js'
import { processManager, type AgentConfig } from '../daemon/process-manager.js'
import { appendTodoNote, createTodoBundle } from '../services/todo-intake.js'
import { initAgentWorkspace, type AgentRole } from '../daemon/workspace-init.js'
import { resolveServerUrl } from '../server-url.js'
import { loadAgentDelegationContext, resolveDelegatedAssignee } from '../services/task-assignment.js'
import { reserveTaskNumbers } from '../services/task-sequence.js'
import { scheduleVaultCommit } from '../services/vault-git.js'
import {
  ensureProjectRegistrySchema,
  listProjectsForServer,
  resolveAgentReference,
  resolveMachineReference,
  setAgentCurrentProject,
  syncProjectRegistryMemory,
  upsertProject,
  upsertProjectAssignment,
  upsertProjectLocation,
} from '../services/project-registry.js'
import { createStoredMessage } from '../services/message-store.js'
import { drainThinking } from '../services/thinking-buffer.js'
import { resolveAgentWorkspacePath } from '../services/agent-workspace.js'
import { scheduler } from '../daemon/scheduler.js'

const EXPLICIT_ASSIGNMENT_ERROR = 'Tasks must be explicitly assigned by a human. claim_tasks/unclaim_task are disabled.'

function toExternalTaskStatus(status: string): 'todo' | 'in_progress' | 'in_review' | 'done' {
  if (status === 'in_progress') return 'in_progress'
  if (status === 'reviewing') return 'in_review'
  if (status === 'completed') return 'done'
  return 'todo'
}

function toInternalTaskStatus(status: 'todo' | 'in_progress' | 'in_review' | 'done', hasAssignee: boolean): string {
  if (status === 'in_progress') return 'in_progress'
  if (status === 'in_review') return 'reviewing'
  if (status === 'done') return 'completed'
  return hasAssignee ? 'claimed' : 'open'
}

async function getScopedChannel(agentId: string, channel: string) {
  const chName = channel.replace(/^#/, '')
  return queryOne<{ id: string }>(
    `SELECT c.id FROM channels c
     JOIN channel_members cm ON cm.channel_id = c.id AND cm.agent_id = $1
     WHERE c.name = $2
     LIMIT 1`,
    [agentId, chName]
  )
}

function slugifyTaskRoomName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'task-room'
}

async function resolveTaskForAgentNote(agentId: string, explicitTaskId?: string) {
  if (explicitTaskId?.trim()) {
    return queryOne<{ id: string; number: number; title: string }>(
      `SELECT id, number, title
       FROM tasks
       WHERE id = $1 AND claimed_by_id = $2`,
      [explicitTaskId.trim(), agentId]
    )
  }

  const activeTasks = await query<{ id: string; number: number; title: string; status: string }>(
    `SELECT id, number, title, status
     FROM tasks
     WHERE claimed_by_id = $1
       AND status IN ('claimed', 'in_progress', 'reviewing')
     ORDER BY
       CASE status
         WHEN 'in_progress' THEN 0
         WHEN 'claimed' THEN 1
         WHEN 'reviewing' THEN 2
         ELSE 3
       END,
       claimed_at DESC NULLS LAST,
       created_at DESC`,
    [agentId]
  )

  if (activeTasks.length === 1) return activeTasks[0]
  if (activeTasks.length === 0) return null

  const inProgressTasks = activeTasks.filter(task => task.status === 'in_progress')
  if (inProgressTasks.length === 1) return inProgressTasks[0]

  throw new Error(`multiple active tasks: ${activeTasks.map(task => `#t${task.number} ${task.title}`).join(', ')}`)
}

/**
 * Resolve a doc path to be vault-root-relative.
 * If the path is already vault-root-relative (starts with a known top-level dir), return as-is.
 * Otherwise, resolve it against the agent's workspace path and make it relative to OBSIDIAN_ROOT.
 */
async function resolveVaultRelativeDocPath(agentId: string, docPath: string): Promise<string> {
  const vaultRoot = process.env.OBSIDIAN_ROOT
  if (!vaultRoot) return docPath

  // Already vault-root-relative if starts with known top-level dirs
  if (/^(0[0-6]_|agents\/)/.test(docPath)) return docPath

  // Look up agent workspace
  const agent = await queryOne<{ workspace_path: string | null }>(
    'SELECT workspace_path FROM agents WHERE id = $1', [agentId]
  )
  if (!agent?.workspace_path) return docPath

  // Resolve against agent workspace, then make relative to vault root
  const absolute = path.resolve(agent.workspace_path, docPath)
  const vaultAbs = path.resolve(vaultRoot)
  if (absolute.startsWith(vaultAbs + '/')) {
    return absolute.slice(vaultAbs.length + 1)
  }
  return docPath
}

export const internalRoutes: FastifyPluginAsync = async (app) => {
  await ensureProjectRegistrySchema()

  app.addHook('preHandler', async (req) => {
    const agentId = (req.params as { agentId?: string } | undefined)?.agentId
    if (!agentId) return

    await query(
      "UPDATE agents SET status = 'running', last_heartbeat_at = NOW() WHERE id = $1",
      [agentId]
    ).catch(() => {})
  })

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
      // Handle DM:@name format — treat as dm_to
      const dmMatch = channel.match(/^DM:@(.+)$/i)
      if (dmMatch) {
        const peerName = dmMatch[1]
        // Find existing DM with this peer
        const existingDm = await queryOne<{ id: string }>(
          `SELECT c.id FROM channels c
           JOIN channel_members cm1 ON cm1.channel_id = c.id AND cm1.agent_id = $1
           JOIN channel_members cm2 ON cm2.channel_id = c.id
             AND (cm2.user_id IN (SELECT id FROM users WHERE LOWER(name) = LOWER($2))
               OR cm2.agent_id IN (SELECT id FROM agents WHERE LOWER(name) = LOWER($2)))
           WHERE c.type = 'dm' LIMIT 1`,
          [agentId, peerName]
        )
        if (existingDm) {
          channelId = existingDm.id
        } else {
          // Fall back to dm_to logic — find/create DM
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
            [peerName, agentId]
          )
          if (!target) return reply.code(404).send({ error: `User/agent "${peerName}" not found` })
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
      } else {
        // Regular channel — agents may only send into channels they already belong to.
        const ch = await getScopedChannel(agentId, channel)
        if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })
        channelId = ch.id
      }
    } else {
      return reply.code(400).send({ error: 'channel or dm_to required' })
    }

    const thinking = drainThinking(agentId)
    const msg = await createStoredMessage({
      channelId: channelId!,
      senderId: agentId,
      senderType: 'agent',
      senderName: agent.name,
      content,
      thinking,
    })

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

    // For channels without a read position, initialize to (max_seq - 5) so
    // agents joining a channel or starting fresh only see the latest messages
    for (const chId of channelIds) {
      if (readMap[chId] === undefined) {
        const maxSeqRow = await queryOne<{ max_seq: string }>(
          `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE channel_id = $1`, [chId]
        )
        const defaultRead = Math.max(0, Number(maxSeqRow?.max_seq ?? 0) - 10)
        readMap[chId] = defaultRead
        // Persist so future calls don't repeat this
        await query(
          `INSERT INTO agent_channel_reads (agent_id, channel_id, last_read_seq) VALUES ($1, $2, $3)
           ON CONFLICT (agent_id, channel_id) DO NOTHING`,
          [agentId, chId, defaultRead]
        )
      }
    }

    // Get unread messages
    let allMsgs: any[] = []
    for (const chId of channelIds) {
      const lastRead = readMap[chId] ?? 0
      const msgs = await query(
        `SELECT m.id, m.channel_id, m.sender_id, m.sender_type, m.sender_name, m.content, m.attachments, m.seq, m.created_at,
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
            `SELECT m.id, m.channel_id, m.sender_id, m.sender_type, m.sender_name, m.content, m.attachments, m.seq, m.created_at,
                    c.name AS channel_name, c.type AS channel_type
             FROM messages m JOIN channels c ON c.id = m.channel_id
             WHERE m.channel_id = $1 AND m.seq > $2 AND m.sender_id != $3
             ORDER BY m.seq LIMIT 50`,
            [chId, lastRead, agentId]
          )
          allMsgs.push(...msgs)
        }
        if (allMsgs.length > 0) break

        // Update DB timestamp during long poll
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
    const uploadsDir = process.env.UPLOADS_DIR ?? '/var/redshrimp/uploads'
    const formatted = allMsgs.map(m => {
      let content = m.content
      // Parse attachments
      const atts = typeof m.attachments === 'string' ? JSON.parse(m.attachments) : (m.attachments ?? [])
      const imageAttachments: Array<{ filename: string; mime_type: string; path: string }> = []
      if (Array.isArray(atts) && atts.length > 0) {
        const lines: string[] = []
        for (const a of atts) {
          const fileName = a.url?.replace(/^\/uploads\//, '') ?? a.file_id + '.bin'
          const filePath = `${uploadsDir}/${fileName}`
          if (a.mime_type?.startsWith('image/')) {
            imageAttachments.push({ filename: a.filename, mime_type: a.mime_type, path: filePath })
          } else {
            lines.push(`[attachment: ${a.filename} (${a.mime_type})] ${filePath}`)
          }
        }
        if (lines.length > 0) content = content + '\n' + lines.join('\n')
        if (imageAttachments.length > 0) {
          content = content + '\n' + imageAttachments.map(img => `[image: ${img.filename}]`).join(' ')
        }
      }
      return {
        channel_name: m.channel_name,
        channel_type: m.channel_type,
        sender_name: m.sender_name,
        sender_type: m.sender_type,
        content,
        timestamp: m.created_at,
        image_attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
        // Tell the agent exactly how to reply
        reply_to: m.channel_type === 'dm'
          ? { dm_to: m.sender_name }
          : { channel: `#${m.channel_name}` },
      }
    })

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

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const lim = Math.min(Number(limit) || 50, 100)
    let sql: string
    let params: unknown[]

    if (after) {
      sql = `SELECT m.id, m.sender_name AS "senderName", m.sender_type AS "senderType",
                    m.content, m.attachments, m.seq, m.created_at AS "createdAt"
             FROM messages m WHERE m.channel_id = $1 AND m.seq > $2
             ORDER BY m.seq LIMIT $3`
      params = [ch.id, Number(after), lim]
    } else if (before) {
      sql = `SELECT m.id, m.sender_name AS "senderName", m.sender_type AS "senderType",
                    m.content, m.attachments, m.seq, m.created_at AS "createdAt"
             FROM messages m WHERE m.channel_id = $1 AND m.seq < $2
             ORDER BY m.seq DESC LIMIT $3`
      params = [ch.id, Number(before), lim]
    } else {
      sql = `SELECT m.id, m.sender_name AS "senderName", m.sender_type AS "senderType",
                    m.content, m.attachments, m.seq, m.created_at AS "createdAt"
             FROM messages m WHERE m.channel_id = $1
             ORDER BY m.seq DESC LIMIT $2`
      params = [ch.id, lim]
    }

    const uploadsDir = process.env.UPLOADS_DIR ?? '/var/redshrimp/uploads'
    const msgs = await query(sql, params)
    const messages = (before || !after ? msgs.reverse() : msgs).map((m: any) => {
      const atts = typeof m.attachments === 'string' ? JSON.parse(m.attachments) : (m.attachments ?? [])
      const imageAttachments: Array<{ filename: string; mime_type: string; path: string }> = []
      if (Array.isArray(atts) && atts.length > 0) {
        for (const a of atts) {
          const fileName = a.url?.replace(/^\/uploads\//, '') ?? a.file_id + '.bin'
          if (a.mime_type?.startsWith('image/')) {
            imageAttachments.push({ filename: a.filename, mime_type: a.mime_type, path: `${uploadsDir}/${fileName}` })
          }
        }
      }
      const result: any = { id: m.id, senderName: m.senderName, senderType: m.senderType, content: m.content, seq: m.seq, createdAt: m.createdAt }
      if (imageAttachments.length > 0) result.image_attachments = imageAttachments
      return result
    })

    // Get last read seq
    const readRow = await queryOne<{ last_read_seq: string }>(
      'SELECT last_read_seq FROM agent_channel_reads WHERE agent_id = $1 AND channel_id = $2',
      [agentId, ch.id]
    )

    return {
      messages,
      has_more: messages.length >= lim,
      last_read_seq: Number(readRow?.last_read_seq ?? 0),
    }
  })

  // ── GET /internal/agent/:agentId/human-messages ──────────────────
  // Returns all human-sent messages across server channels for a given date (UTC+8).
  // Used by Akara for daily report summarization.
  app.get('/:agentId/human-messages', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { date } = req.query as { date?: string }

    // Resolve target date (UTC+8); fall back to today
    let targetDate = date?.trim()
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      targetDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
    }

    // Verify the agent exists and get its server_id
    const agentRow = await queryOne<{ server_id: string }>(
      `SELECT server_id FROM agents WHERE id = $1`,
      [agentId]
    )
    if (!agentRow) return reply.code(404).send({ error: 'Agent not found' })

    const messages = await query<{
      channelName: string
      channelType: string
      senderName: string
      content: string
      createdAt: string
    }>(
      `SELECT c.name AS "channelName", c.channel_type AS "channelType",
              m.sender_name AS "senderName", m.content,
              m.created_at AS "createdAt"
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       WHERE c.server_id = $1
         AND m.sender_type = 'human'
         AND (m.created_at AT TIME ZONE 'Asia/Shanghai')::date = $2::date
       ORDER BY m.created_at`,
      [agentRow.server_id, targetDate]
    )

    return { date: targetDate, messages }
  })

  // ── GET /internal/agent/:agentId/tasks ──────────────────────────
  app.get('/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, status, mine } = req.query as { channel?: string; status?: string; mine?: string }

    if (!channel) return reply.code(400).send({ error: 'channel required' })

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    let sql = `SELECT t.id, t.number AS "taskNumber", t.title,
                      CASE
                        WHEN t.status = 'pending_discussion' THEN 'pending_discussion'
                        WHEN t.status IN ('open', 'claimed') THEN 'todo'
                        WHEN t.status = 'reviewing' THEN 'in_review'
                        WHEN t.status = 'completed' THEN 'done'
                        ELSE t.status
                      END AS status,
                      t.claimed_by_name AS "claimedByName"
               FROM tasks t
               WHERE t.channel_id = $1`
    const params: unknown[] = [ch.id]

    // mine=true: only show tasks assigned to this agent (default behavior for work queue)
    if (mine === 'true' || mine === '1') {
      sql += ` AND t.claimed_by_id = $${params.length + 1}`
      params.push(agentId)
    }

    if (status && status !== 'all') {
      if (status === 'todo') {
        sql += ` AND t.status IN ('open', 'claimed', 'pending_discussion')`
      } else if (status === 'in_review') {
        sql += ` AND t.status = $${params.length + 1}`
        params.push('reviewing')
      } else if (status === 'done') {
        sql += ` AND t.status = $${params.length + 1}`
        params.push('completed')
      } else {
        sql += ` AND t.status = $${params.length + 1}`
        params.push(status)
      }
    }
    sql += ' ORDER BY t.number'

    const tasks = await query(sql, params)
    return { tasks }
  })

  // ── POST /internal/agent/:agentId/tasks ─────────────────────────
  app.post('/:agentId/tasks', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, tasks } = req.body as {
      channel: string
      tasks: Array<{ title: string; assignee_agent_id?: string; estimated_minutes?: number; linked_docs?: string[] }>
    }

    if (!tasks?.length) {
      return reply.code(400).send({ error: 'tasks[] required' })
    }

    const caller = await queryOne<{ role: string | null }>(
      `SELECT role FROM agents WHERE id = $1`,
      [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Agent not found' })
    if (caller.role !== 'coordinator') {
      return reply.code(403).send({ error: 'Only coordinator agents can create tasks' })
    }

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })
    const delegation = await loadAgentDelegationContext(agentId)

    const reserved = await reserveTaskNumbers(ch.id, tasks.length)

    const created = []
    for (const [index, t] of tasks.entries()) {
      if (!t.title?.trim()) {
        return reply.code(400).send({ error: 'Task title is required' })
      }
      let assignee
      try {
        assignee = resolveDelegatedAssignee(delegation, t.assignee_agent_id, 'assignee_agent_id')
      } catch (err: any) {
        return reply.code(400).send({ error: err.message ?? 'Invalid task assignee' })
      }
      const [task] = await query(
        `INSERT INTO tasks (
           channel_id, title, status, number, claimed_by_id, claimed_by_type, claimed_by_name, claimed_at, estimated_minutes
         ) VALUES ($1, $2, 'pending_discussion', $3, $4, 'agent', $5, NOW(), $6) RETURNING *`,
        [ch.id, t.title.trim(), reserved.first + index, assignee.id, assignee.name, t.estimated_minutes ?? null]
      )
      // Link documents if provided
      if (t.linked_docs?.length) {
        for (const docPath of t.linked_docs) {
          const trimmed = docPath.trim()
          if (!trimmed) continue
          const resolvedDocPath = await resolveVaultRelativeDocPath(agentId, trimmed)
          const docName = resolvedDocPath.split('/').pop()?.replace(/\.md$/, '') ?? resolvedDocPath
          await query(
            `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
             VALUES ($1, $2, $3, 'writing')
             ON CONFLICT DO NOTHING`,
            [task.id, resolvedDocPath, docName]
          )
          emitTaskDocAdded(agentId, task.id, resolvedDocPath)
        }
      }
      created.push({ taskNumber: task.number, title: task.title, assigneeName: assignee.name, estimatedMinutes: task.estimated_minutes })
    }
    return { tasks: created }
  })

  // ── POST /internal/agent/:agentId/task-room ─────────────────────
  app.post('/:agentId/task-room', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number, participant_agent_ids } = req.body as {
      channel?: string
      task_number?: number
      participant_agent_ids?: string[]
    }

    if (!channel) return reply.code(400).send({ error: 'channel required' })
    if (!Number.isInteger(task_number) || Number(task_number) <= 0) {
      return reply.code(400).send({ error: 'task_number must be a positive integer' })
    }

    const creator = await queryOne<{ id: string; name: string; server_id: string }>(
      `SELECT id, name, server_id FROM agents WHERE id = $1`,
      [agentId]
    )
    if (!creator) return reply.code(404).send({ error: 'Agent not found' })

    const scopedChannel = await getScopedChannel(agentId, channel)
    if (!scopedChannel) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const task = await queryOne<{
      id: string
      title: string
      number: number
      channel_id: string
      server_id: string
      parent_channel_name: string
      claimed_by_id: string | null
    }>(
      `SELECT t.id, t.title, t.number, t.channel_id, c.server_id, c.name AS parent_channel_name, t.claimed_by_id
       FROM tasks t
       JOIN channels c ON c.id = t.channel_id
       WHERE t.channel_id = $1 AND t.number = $2`,
      [scopedChannel.id, Number(task_number)]
    )
    if (!task) return reply.code(404).send({ error: `Task #t${task_number} not found in ${channel}` })

    let room = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM channels WHERE task_id = $1 LIMIT 1`,
      [task.id]
    )
    const created = !room

    if (!room) {
      const baseName = slugifyTaskRoomName(`${task.parent_channel_name}-t${task.number}-${task.id.slice(0, 6)}-${task.title}`)
      const [inserted] = await query<{ id: string; name: string }>(
        `INSERT INTO channels (server_id, name, description, type, task_id)
         VALUES ($1, $2, $3, 'channel', $4)
         RETURNING id, name`,
        [
          task.server_id,
          baseName,
          `task room for #t${task.number} ${task.title}`,
          task.id,
        ]
      )
      room = inserted
    }

    const serverAgents = await query<{ id: string; name: string; role: string | null; parent_agent_id: string | null }>(
      `SELECT id, name, role, parent_agent_id FROM agents WHERE server_id = $1`,
      [task.server_id]
    )
    const agentsById = new Map(serverAgents.map(agent => [agent.id, agent]))
    const agentsByNormalizedName = new Map(serverAgents.map(agent => [agent.name.trim().replace(/^@+/, '').toLowerCase(), agent]))
    const invitedAgentIds = new Set<string>()
    const inviteAgentByRef = (rawRef?: string | null) => {
      const ref = rawRef?.trim()
      if (!ref) return
      const byId = serverAgents.find(agent => agent.id === ref)
      if (byId) {
        invitedAgentIds.add(byId.id)
        return
      }
      const normalized = ref.replace(/^@+/, '').toLowerCase()
      const byName = agentsByNormalizedName.get(normalized)
      if (byName) invitedAgentIds.add(byName.id)
    }

    inviteAgentByRef(agentId)
    inviteAgentByRef(task.claimed_by_id)
    inviteAgentByRef(agentsById.get(agentId)?.parent_agent_id)
    inviteAgentByRef(task.claimed_by_id ? agentsById.get(task.claimed_by_id)?.parent_agent_id : null)
    for (const managerAgent of serverAgents) {
      if (['coordinator', 'ops'].includes(managerAgent.role ?? '')) {
        invitedAgentIds.add(managerAgent.id)
      }
    }
    for (const extraRef of participant_agent_ids ?? []) inviteAgentByRef(extraRef)

    const parentHumanMembers = await query<{ user_id: string }>(
      `SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id IS NOT NULL`,
      [task.channel_id]
    )

    for (const invitedAgentId of invitedAgentIds) {
      await query(
        `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [room.id, invitedAgentId]
      )
    }
    for (const member of parentHumanMembers) {
      await query(
        `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [room.id, member.user_id]
      )
    }

    return {
      ok: true,
      created,
      channel: {
        id: room.id,
        name: room.name,
      },
      invitedAgents: serverAgents
        .filter(agent => invitedAgentIds.has(agent.id))
        .map(agent => agent.name),
      invitedHumans: parentHumanMembers.length,
    }
  })

  // ── POST /internal/agent/:agentId/tasks/claim ───────────────────
  app.post('/:agentId/tasks/claim', async (_req, reply) => {
    return reply.code(409).send({ error: EXPLICIT_ASSIGNMENT_ERROR })
  })

  // ── POST /internal/agent/:agentId/tasks/unclaim ─────────────────
  app.post('/:agentId/tasks/unclaim', async (_req, reply) => {
    return reply.code(409).send({ error: EXPLICIT_ASSIGNMENT_ERROR })
  })

  // ── POST /internal/agent/:agentId/tasks/update-status ───────────
  app.post('/:agentId/tasks/update-status', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number, status } = req.body as {
      channel: string; task_number: number; status: string
    }

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    if (!['todo', 'in_progress', 'in_review', 'done'].includes(status)) {
      return reply.code(400).send({ error: `Unsupported status: ${status}` })
    }

    if (status === 'done') {
      return reply.code(403).send({
        error: 'Assigned agents cannot mark tasks done directly. Submit in_review and use reviewer approval to complete.',
      })
    }

    const task = await queryOne<{
      id: string
      status: string
      claimed_by_id: string | null
    }>(
      'SELECT id, status, claimed_by_id FROM tasks WHERE channel_id = $1 AND number = $2',
      [ch.id, task_number]
    )
    if (!task) return reply.code(404).send({ error: `Task #t${task_number} not found` })
    if (task.status === 'pending_discussion') {
      return reply.code(409).send({ error: 'Task is awaiting discussion. Coordinator must call mark_task_discussed first.' })
    }
    if (!task.claimed_by_id) {
      return reply.code(409).send({ error: 'Task has no assignee. A human must assign it first.' })
    }
    if (task.claimed_by_id !== agentId) {
      return reply.code(403).send({ error: 'Only the assigned agent can update this task' })
    }

    const currentStatus = toExternalTaskStatus(task.status)
    if (currentStatus === status) return { ok: true }

    const allowedTransitions: Record<string, string[]> = {
      todo: ['in_progress'],
      in_progress: ['in_review'],
      in_review: ['in_progress'],
      done: [],
    }
    if (!allowedTransitions[currentStatus]?.includes(status)) {
      return reply.code(409).send({
        error: `Invalid transition: ${currentStatus} -> ${status}`,
      })
    }

    // WF-02/WF-03: Cannot move to in_review without linked documents
    if (status === 'in_review') {
      const docs = await query(
        'SELECT id FROM task_documents WHERE task_id = $1 LIMIT 1',
        [task.id]
      )
      if (docs.length === 0) {
        return reply.code(409).send({
          error: 'Cannot move to in_review: no documents linked. Use link_task_doc first.',
        })
      }
    }

    const nextInternalStatus = toInternalTaskStatus(
      status as 'todo' | 'in_progress' | 'in_review' | 'done',
      true
    )
    await query(
      `UPDATE tasks
       SET status = $1::varchar,
           started_at = CASE WHEN $1::varchar = 'in_progress' AND started_at IS NULL THEN NOW() ELSE started_at END,
           completed_at = CASE WHEN $1::varchar = 'completed' THEN NOW() ELSE NULL END
       WHERE id = $2`,
      [nextInternalStatus, task.id]
    )

    if (nextInternalStatus === 'completed') {
      emitTaskCompleted(agentId, task.id, ch.id)
      const openTasks = await query(
        `SELECT id FROM tasks WHERE channel_id = $1 AND status != 'completed'`,
        [ch.id]
      )
      if (openTasks.length === 0) {
        emitTaskAllCompleted(agentId, ch.id)
      }
    }

    // ── Auto-notify reviewer (Akara) when task moves to in_review ──
    if (nextInternalStatus === 'reviewing') {
      try {
        const reviewer = await queryOne<{ id: string; name: string }>(
          `SELECT a.id, a.name FROM agents a
           JOIN channel_members cm ON cm.agent_id = a.id AND cm.channel_id = $1
           WHERE a.role IN ('ops', 'coordinator')
           ORDER BY CASE a.role WHEN 'ops' THEN 0 ELSE 1 END
           LIMIT 1`,
          [ch.id]
        )
        if (reviewer) {
          const agentRow = await queryOne<{ name: string }>(`SELECT name FROM agents WHERE id = $1`, [agentId])
          const agentName = agentRow?.name ?? 'Agent'
          await createStoredMessage({
            channelId: ch.id,
            senderId: agentId,
            senderType: 'agent',
            senderName: agentName,
            content: `@${reviewer.name} #t${task_number} 已提交审查，请 review。`,
          }).catch(() => {})
        }
      } catch { /* best effort */ }
    }

    return { ok: true }
  })

  // ── POST /internal/agent/:agentId/tasks/review-accept ───────────
  // ops/coordinator agent approves a reviewing task → completed
  app.post('/:agentId/tasks/review-accept', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number } = req.body as { channel: string; task_number: number }

    const caller = await queryOne<{ id: string; name: string; role: string | null }>(
      `SELECT id, name, role FROM agents WHERE id = $1`, [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Agent not found' })
    if (caller.role !== 'ops' && caller.role !== 'coordinator') {
      return reply.code(403).send({ error: 'Only ops or coordinator agents can review tasks' })
    }

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const [task] = await query(
      `UPDATE tasks
       SET status = 'completed',
           completed_at = NOW(),
           review_feedback = NULL,
           review_feedback_at = NULL,
           review_feedback_by_name = NULL
       WHERE channel_id = $1 AND number = $2 AND status = 'reviewing'
       RETURNING *`,
      [ch.id, task_number]
    )
    if (!task) return reply.code(409).send({ error: `Task #t${task_number} is not in reviewing status` })

    // Record accept feedback
    await query(
      `INSERT INTO task_feedbacks (task_id, reviewer_id, reviewer_type, reviewer_name, verdict)
       VALUES ($1, $2, 'agent', $3, 'accept')`,
      [task.id, agentId, caller.name]
    ).catch(() => {})

    emitTaskCompleted(agentId, task.id, ch.id)
    const openTasks = await query(
      `SELECT id FROM tasks WHERE channel_id = $1 AND status != 'completed'`,
      [ch.id]
    )
    if (openTasks.length === 0) {
      emitTaskAllCompleted(agentId, ch.id)
    }

    return { ok: true, message: `#t${task_number} approved and completed.` }
  })

  // ── POST /internal/agent/:agentId/tasks/review-reject ───────────
  // ops/coordinator agent rejects a reviewing task → in_progress + DM notification
  app.post('/:agentId/tasks/review-reject', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number, feedback } = req.body as {
      channel: string; task_number: number; feedback: string
    }

    if (!feedback?.trim()) {
      return reply.code(400).send({ error: 'Rejection feedback is required' })
    }

    const caller = await queryOne<{ id: string; name: string; role: string | null }>(
      `SELECT id, name, role FROM agents WHERE id = $1`, [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Agent not found' })
    if (caller.role !== 'ops' && caller.role !== 'coordinator') {
      return reply.code(403).send({ error: 'Only ops or coordinator agents can review tasks' })
    }

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const [task] = await query(
      `UPDATE tasks
       SET status = 'in_progress',
           completed_at = NULL,
           review_feedback = $3,
           review_feedback_at = NOW(),
           review_feedback_by_name = $4
       WHERE channel_id = $1 AND number = $2 AND status = 'reviewing' AND claimed_by_id IS NOT NULL
       RETURNING *`,
      [ch.id, task_number, feedback.trim(), caller.name]
    )
    if (!task) return reply.code(409).send({ error: `Task #t${task_number} is not in reviewing status or has no assignee` })

    emitTaskUpdated(agentId, task.id, ch.id)

    // Record reject feedback
    await query(
      `INSERT INTO task_feedbacks (task_id, reviewer_id, reviewer_type, reviewer_name, verdict, reason_text)
       VALUES ($1, $2, 'agent', $3, 'reject', $4)`,
      [task.id, agentId, caller.name, feedback.trim()]
    ).catch(() => {})

    // DM the assigned agent with rejection details
    if (task.claimed_by_id) {
      try {
        const agentRow = await queryOne<{ id: string; server_id: string }>(
          'SELECT id, server_id FROM agents WHERE id = $1', [task.claimed_by_id]
        )
        if (agentRow) {
          let dmChannel = await queryOne<{ id: string }>(
            `SELECT c.id FROM channels c
             JOIN channel_members cm1 ON cm1.channel_id = c.id AND cm1.agent_id = $1
             JOIN channel_members cm2 ON cm2.channel_id = c.id AND cm2.agent_id = $2
             WHERE c.type = 'dm' LIMIT 1`,
            [task.claimed_by_id, agentId]
          )
          if (!dmChannel) {
            const [newCh] = await query(
              `INSERT INTO channels (server_id, name, type) VALUES ($1, $2, 'dm') RETURNING id`,
              [agentRow.server_id, `dm-${Date.now()}`]
            )
            dmChannel = newCh
            await query('INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [newCh.id, task.claimed_by_id])
            await query('INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [newCh.id, agentId])
          }

          const rejectionContent = `#t${task.number} "${task.title}" 被驳回，请继续修改。\n\n驳回理由：${feedback.trim()}`
          await createStoredMessage({
            channelId: dmChannel.id,
            senderId: agentId,
            senderType: 'agent',
            senderName: caller.name,
            content: rejectionContent,
          }).catch(() => {})
        }
      } catch { /* best effort DM */ }
    }

    return { ok: true, message: `#t${task_number} rejected — assignee notified.` }
  })

  // ── POST /internal/agent/:agentId/tasks/mark-discussed ──────────
  // Only coordinator can unblock a pending_discussion task
  app.post('/:agentId/tasks/mark-discussed', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number } = req.body as { channel: string; task_number: number }

    const caller = await queryOne<{ role: string | null }>(
      `SELECT role FROM agents WHERE id = $1`, [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Agent not found' })
    if (caller.role !== 'coordinator') {
      return reply.code(403).send({ error: 'Only coordinator (Donovan) can mark tasks as discussed' })
    }

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const task = await queryOne<{ id: string; status: string; claimed_by_id: string | null }>(
      `SELECT id, status, claimed_by_id FROM tasks WHERE channel_id = $1 AND number = $2`,
      [ch.id, task_number]
    )
    if (!task) return reply.code(404).send({ error: `Task #t${task_number} not found` })
    if (task.status !== 'pending_discussion') {
      return { ok: true, message: 'Task was not in pending_discussion state — no change needed' }
    }

    const nextStatus = task.claimed_by_id ? 'claimed' : 'open'
    await query(
      `UPDATE tasks SET status = $1 WHERE id = $2`,
      [nextStatus, task.id]
    )
    return { ok: true, taskNumber: task_number, newStatus: nextStatus }
  })

  // ── POST /internal/agent/:agentId/tasks/link-doc ────────────────
  app.post('/:agentId/tasks/link-doc', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number, doc_path, doc_name, status } = req.body as {
      channel: string
      task_number: number
      doc_path: string
      doc_name?: string
      status?: string
    }

    if (!doc_path?.trim()) return reply.code(400).send({ error: 'doc_path required' })
    if (!Number.isInteger(task_number) || task_number <= 0) {
      return reply.code(400).send({ error: 'task_number must be a positive integer' })
    }

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const task = await queryOne<{ id: string }>(
      `SELECT id FROM tasks WHERE channel_id = $1 AND number = $2`,
      [ch.id, task_number]
    )
    if (!task) return reply.code(404).send({ error: `Task #t${task_number} not found` })

    const resolvedPath = await resolveVaultRelativeDocPath(agentId, doc_path.trim())
    const resolvedName = doc_name?.trim() || resolvedPath.split('/').pop()?.replace(/\.md$/, '') || resolvedPath

    const existing = await queryOne(
      `SELECT id FROM task_documents WHERE task_id = $1 AND doc_path = $2`,
      [task.id, resolvedPath]
    )
    if (existing) return { ok: true, already_linked: true }

    const [doc] = await query(
      `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [task.id, resolvedPath, resolvedName, status || 'writing']
    )
    emitTaskDocAdded(agentId, task.id, resolvedPath)
    return { ok: true, doc }
  })

  // ── GET /internal/agent/:agentId/agent-memory/:targetName ───────────
  // Only coordinator (Donovan) can read other agents' MEMORY.md
  app.get('/:agentId/agent-memory/:targetName', async (req, reply) => {
    const { agentId, targetName } = req.params as { agentId: string; targetName: string }

    const caller = await queryOne<{ role: string | null; server_id: string }>(
      `SELECT role, server_id FROM agents WHERE id = $1`, [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Agent not found' })
    if (caller.role !== 'coordinator') {
      return reply.code(403).send({ error: 'Only coordinator (Donovan) can read other agents\' memory' })
    }

    const target = await queryOne<{ workspace_path: string | null; name: string; server_id: string }>(
      `SELECT workspace_path, name, server_id FROM agents WHERE LOWER(name) = LOWER($1) AND server_id = $2`,
      [targetName, caller.server_id]
    )
    if (!target) return reply.code(404).send({ error: `Agent "${targetName}" not found` })
    if (!target.workspace_path) return reply.code(404).send({ error: `Agent "${targetName}" has no workspace` })

    try {
      const { readFile } = await import('fs/promises')
      const { join } = await import('path')
      const { homedir } = await import('os')
      const resolvedPath = target.workspace_path.replace(/^~/, homedir())
      const memoryPath = join(resolvedPath, 'MEMORY.md')
      const content = await readFile(memoryPath, 'utf-8')
      return { agentName: target.name, path: memoryPath, content }
    } catch {
      return reply.code(404).send({ error: `MEMORY.md not found for agent "${targetName}"` })
    }
  })

  // ── GET /internal/agent/:agentId/team-status ─────────────────────
  // Returns all agents on the same server with their status, task counts, and sub-agent counts
  app.get('/:agentId/team-status', async (req) => {
    const { agentId } = req.params as { agentId: string }

    const agentRow = await queryOne<{ server_id: string }>(
      `SELECT server_id FROM agents WHERE id = $1`, [agentId]
    )
    if (!agentRow) return { team: [] }

    const rows = await query<{
      id: string
      name: string
      role: string | null
      status: string
      activity: string | null
      project_name: string | null
      assigned_task_count: string
      sub_agent_count: string
    }>(
      `SELECT
         a.id,
         a.name,
         a.role,
         a.status,
         a.activity,
         p.name AS project_name,
         (SELECT COUNT(*) FROM tasks t
          JOIN channels c ON c.id = t.channel_id
          WHERE c.server_id = a.server_id
            AND t.claimed_by_id = a.id
            AND t.status NOT IN ('completed')) AS assigned_task_count,
         (SELECT COUNT(*) FROM agents sub WHERE sub.parent_agent_id = a.id) AS sub_agent_count
       FROM agents a
       LEFT JOIN projects p ON p.id = a.current_project_id
       WHERE a.server_id = $1
       ORDER BY a.created_at ASC`,
      [agentRow.server_id]
    )

    return {
      team: rows.map(r => ({
        id: r.id,
        name: r.name,
        role: r.role ?? 'general',
        status: r.status,
        activity: r.activity ?? null,
        currentProject: r.project_name ?? null,
        assignedTaskCount: parseInt(r.assigned_task_count, 10),
        subAgentCount: parseInt(r.sub_agent_count, 10),
      })),
    }
  })

  // ── GET /internal/agent/:agentId/tasks/server ───────────────────
  // Returns all tasks across all channels on this agent's server (for weekly reports / ops overview)
  app.get('/:agentId/tasks/server', async (req) => {
    const { agentId } = req.params as { agentId: string }
    const { status } = req.query as { status?: string }

    const agentRow = await queryOne<{ server_id: string }>(
      `SELECT server_id FROM agents WHERE id = $1`, [agentId]
    )
    if (!agentRow) return { tasks: [] }

    let sql = `SELECT t.id, t.number AS "taskNumber", t.title,
                      c.name AS "channelName",
                      CASE
                        WHEN t.status = 'pending_discussion' THEN 'pending_discussion'
                        WHEN t.status IN ('open', 'claimed') THEN 'todo'
                        WHEN t.status = 'reviewing' THEN 'in_review'
                        WHEN t.status = 'completed' THEN 'done'
                        ELSE t.status
                      END AS status,
                      t.claimed_by_name AS "claimedByName",
                      t.created_by_name AS "createdByName",
                      t.created_at AS "createdAt",
                      t.updated_at AS "updatedAt"
               FROM tasks t
               JOIN channels c ON c.id = t.channel_id
               WHERE c.server_id = $1`
    const params: unknown[] = [agentRow.server_id]

    if (status && status !== 'all') {
      if (status === 'todo') {
        sql += ` AND t.status IN ('open', 'claimed', 'pending_discussion')`
      } else if (status === 'in_review') {
        sql += ` AND t.status = 'reviewing'`
      } else if (status === 'done') {
        sql += ` AND t.status = 'completed'`
      } else {
        sql += ` AND t.status = $${params.length + 1}`
        params.push(status)
      }
    }
    sql += ` ORDER BY c.name, t.number`

    const tasks = await query(sql, params)
    return { tasks }
  })

  // ── GET /internal/agent/:agentId/tasks/overdue ──────────────────
  // Returns tasks that have exceeded their estimated_minutes or been in_progress > 7 days
  app.get('/:agentId/tasks/overdue', async (req) => {
    const rows = await query(
      `SELECT t.*, c.name AS channel_name
       FROM tasks t
       JOIN channels c ON c.id = t.channel_id
       WHERE t.status IN ('claimed', 'in_progress', 'reviewing')
         AND (
           -- Has estimate and exceeded it
           (t.estimated_minutes IS NOT NULL AND t.started_at IS NOT NULL
            AND NOW() > t.started_at + (t.estimated_minutes || ' minutes')::INTERVAL)
           OR
           -- No estimate but in_progress for over 7 days
           (t.started_at IS NOT NULL AND NOW() > t.started_at + INTERVAL '7 days')
           OR
           -- Claimed but never started, older than 7 days
           (t.started_at IS NULL AND t.created_at < NOW() - INTERVAL '7 days')
         )
       ORDER BY t.created_at ASC`,
      []
    )
    return {
      overdue: rows.map((r: any) => ({
        taskNumber: r.number,
        title: r.title,
        status: r.status,
        assignee: r.claimed_by_name,
        channel: r.channel_name,
        estimatedMinutes: r.estimated_minutes,
        startedAt: r.started_at,
        createdAt: r.created_at,
        overdueMinutes: r.started_at && r.estimated_minutes
          ? Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000 - r.estimated_minutes)
          : null,
      })),
    }
  })

  // ── POST /internal/agent/:agentId/tasks/subtask ───────────────────
  // Create a subtask under an existing parent task.
  // Worker agents create candidates (is_candidate=true); coordinator/tech-lead create approved subtasks.
  app.post('/:agentId/tasks/subtask', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { parent_task_number, channel, title, assignee_agent_id, estimated_minutes, source_doc_path } = req.body as {
      parent_task_number: number
      channel: string
      title: string
      assignee_agent_id?: string
      estimated_minutes?: number
      source_doc_path?: string
    }

    if (!title?.trim()) return reply.code(400).send({ error: 'title required' })
    if (!parent_task_number) return reply.code(400).send({ error: 'parent_task_number required' })

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    // Find parent task
    const parent = await queryOne<{ id: string; channel_id: string }>(
      'SELECT id, channel_id FROM tasks WHERE channel_id = $1 AND number = $2',
      [ch.id, parent_task_number]
    )
    if (!parent) return reply.code(404).send({ error: `Parent task #t${parent_task_number} not found` })

    // Check if caller is coordinator or tech-lead (can create approved subtasks)
    const callerAgent = await queryOne<{ role: string }>(
      'SELECT role FROM agents WHERE id = $1', [agentId]
    )
    const isManager = callerAgent && ['coordinator', 'ops'].includes(callerAgent.role ?? '')
    // Tech lead agents can also create approved subtasks
    const isTechLead = callerAgent?.role === 'tech-lead'
    const isCandidate = !isManager // Workers create candidates, managers create approved

    const delegation = await loadAgentDelegationContext(agentId)
    let assignee
    try {
      assignee = resolveDelegatedAssignee(delegation, assignee_agent_id, 'assignee_agent_id')
    } catch (err: any) {
      return reply.code(400).send({ error: err.message ?? 'Invalid assignee' })
    }

    const reserved = await reserveTaskNumbers(ch.id, 1)
    const [task] = await query(
      `INSERT INTO tasks (
         channel_id, title, number, status, claimed_by_id, claimed_by_type, claimed_by_name, claimed_at,
         parent_task_id, estimated_minutes, source_doc_path, is_candidate
       ) VALUES ($1, $2, $3, 'claimed', $4, 'agent', $5, NOW(), $6, $7, $8, $9)
       RETURNING *`,
      [
        ch.id, title.trim(), reserved.first, assignee.id, assignee.name,
        parent.id, estimated_minutes ?? null, source_doc_path ?? null, isCandidate,
      ]
    )

    return {
      task: {
        taskNumber: task.number,
        title: task.title,
        assignee: task.claimed_by_name,
        parentTaskNumber: parent_task_number,
        isCandidate,
        estimatedMinutes: task.estimated_minutes,
      },
    }
  })

  // ── POST /internal/agent/:agentId/tasks/approve-candidate ─────────
  // Coordinator/tech-lead approves a candidate subtask
  app.post('/:agentId/tasks/approve-candidate', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, task_number } = req.body as { channel: string; task_number: number }

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    // Only coordinator role can approve
    const callerAgent = await queryOne<{ role: string }>(
      'SELECT role FROM agents WHERE id = $1', [agentId]
    )
    if (!callerAgent || !['coordinator', 'ops'].includes(callerAgent.role ?? '')) {
      return reply.code(403).send({ error: 'Only coordinator/ops can approve candidate subtasks' })
    }

    const [task] = await query(
      `UPDATE tasks SET is_candidate = false WHERE channel_id = $1 AND number = $2 AND is_candidate = true RETURNING *`,
      [ch.id, task_number]
    )
    if (!task) return reply.code(404).send({ error: `Candidate task #t${task_number} not found` })

    return { ok: true, task: { taskNumber: task.number, title: task.title, isCandidate: false } }
  })

  // ── GET /internal/agent/:agentId/tasks/:taskNumber/subtasks ───────
  // List subtasks of a parent task
  app.get('/:agentId/tasks/:taskNumber/subtasks', async (req) => {
    const { agentId, taskNumber } = req.params as { agentId: string; taskNumber: string }
    const num = parseInt(taskNumber, 10)

    // Find any channel the agent has access to that contains this task
    const task = await queryOne<{ id: string }>(
      `SELECT t.id FROM tasks t
       JOIN channels c ON c.id = t.channel_id
       JOIN channel_members cm ON cm.channel_id = c.id
       WHERE t.number = $1 AND cm.agent_id = $2
       LIMIT 1`,
      [num, agentId]
    )
    if (!task) return { subtasks: [] }

    const rows = await query(
      `SELECT number, title, status, claimed_by_name, estimated_minutes, started_at, is_candidate, created_at
       FROM tasks WHERE parent_task_id = $1 ORDER BY number`,
      [task.id]
    )

    return { subtasks: rows }
  })

  // ── POST /internal/agent/:agentId/todo-intake ────────────────────
  app.post('/:agentId/todo-intake', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const body = req.body as {
      channel: string
      title: string
      summary?: string
      owner_agent_id?: string
      clean_level?: string
      subtasks?: Array<{ title: string; assignee_agent_id?: string }>
    }

    const ch = await getScopedChannel(agentId, body.channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${body.channel}" not found` })

    try {
      const delegation = await loadAgentDelegationContext(agentId)
      const ownerAgent = resolveDelegatedAssignee(delegation, body.owner_agent_id, 'owner_agent_id')
      const subtasks = (body.subtasks ?? []).map(item => ({
        title: item.title,
        assigneeAgentId: resolveDelegatedAssignee(
          delegation,
          item.assignee_agent_id?.trim() || ownerAgent.id,
          'subtasks[].assignee_agent_id'
        ).id,
      }))
      const bundle = await createTodoBundle({
        actorId: agentId,
        channelId: ch.id,
        title: body.title.trim(),
        summary: body.summary,
        ownerAgentId: ownerAgent.id,
        cleanLevel: body.clean_level,
        reviewerName: 'Jwt2077',
        subtasks,
      })
      return { ok: true, bundle }
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'todo intake failed' })
    }
  })

  // ── POST /internal/agent/:agentId/tasks/:taskId/memory-note ─────
  app.post('/:agentId/tasks/:taskId/memory-note', async (req, reply) => {
    const { agentId, taskId } = req.params as { agentId: string; taskId: string }
    const body = req.body as { title: string; content: string }

    if (!body.title?.trim() || !body.content?.trim()) {
      return reply.code(400).send({ error: 'title and content are required' })
    }

    try {
      const note = await appendTodoNote({
        actorId: agentId,
        taskId,
        title: body.title.trim(),
        content: body.content,
      })
      return { ok: true, note }
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'todo note failed' })
    }
  })

  // ── POST /internal/agent/:agentId/tasks/memory-note ─────────────
  app.post('/:agentId/tasks/memory-note', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const body = req.body as { task_id?: string; title: string; content: string }

    if (!body.title?.trim() || !body.content?.trim()) {
      return reply.code(400).send({ error: 'title and content are required' })
    }

    try {
      const task = await resolveTaskForAgentNote(agentId, body.task_id)
      if (!task) {
        return reply.code(409).send({ error: 'No active task found for this agent. Pass task_id explicitly.' })
      }

      const note = await appendTodoNote({
        actorId: agentId,
        taskId: task.id,
        title: body.title.trim(),
        content: body.content,
      })
      return { ok: true, task, note }
    } catch (err: any) {
      if (err?.message?.startsWith('multiple active tasks:')) {
        return reply.code(409).send({ error: `${err.message}. Pass task_id explicitly.` })
      }
      return reply.code(500).send({ error: err.message ?? 'todo note failed' })
    }
  })

  // ── POST /internal/agent/:agentId/create-agent ──────────────────
  // Lets a coordinator agent create new agents programmatically
  app.get('/:agentId/projects', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const agent = await queryOne<{ id: string; server_id: string }>(
      'SELECT id, server_id FROM agents WHERE id = $1',
      [agentId]
    )
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    return {
      projects: await listProjectsForServer(agent.server_id),
    }
  })

  app.post('/:agentId/projects/upsert', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const body = req.body as {
      id?: string
      name?: string
      slug?: string
      summary?: string | null
      default_machine_ref?: string | null
      owner_agent_ref?: string | null
      current_agent_ref?: string | null
      locations?: Array<{
        machine_ref?: string | null
        root_path: string
        notes?: string | null
        is_primary?: boolean
      }>
      assignments?: Array<{
        agent_ref: string
        responsibility?: string | null
        is_owner?: boolean
        set_current?: boolean
      }>
    }

    const actor = await queryOne<{ id: string; server_id: string; name: string; role: string | null }>(
      'SELECT id, server_id, name, role FROM agents WHERE id = $1',
      [agentId]
    )
    if (!actor) return reply.code(404).send({ error: 'Agent not found' })

    const canMaintainRegistry = actor.role === 'coordinator' || actor.role === 'ops'
    if (!canMaintainRegistry) {
      return reply.code(403).send({ error: 'Only coordinator/ops agents may maintain the project registry' })
    }

    const maintainedByAgentId = actor.id
    const defaultMachine = await resolveMachineReference(actor.server_id, body.default_machine_ref ?? null)
    const ownerAgent = await resolveAgentReference(actor.server_id, body.owner_agent_ref ?? null)
    const currentAgent = await resolveAgentReference(actor.server_id, body.current_agent_ref ?? null)

    let resolvedName = body.name?.trim() || ''
    if (body.id?.trim() && !resolvedName) {
      const existing = await queryOne<{ id: string; name: string }>(
        'SELECT id, name FROM projects WHERE id = $1 AND server_id = $2',
        [body.id.trim(), actor.server_id]
      )
      if (!existing) return reply.code(404).send({ error: 'Project not found' })
      resolvedName = existing.name
    }
    if (!resolvedName) return reply.code(400).send({ error: 'name required' })

    const project = await upsertProject({
      id: body.id?.trim() || null,
      serverId: actor.server_id,
      name: resolvedName,
      slug: body.slug?.trim() || null,
      summary: body.summary ?? null,
      ownerAgentId: ownerAgent?.id ?? null,
      maintainedByAgentId,
      defaultMachineId: defaultMachine?.id ?? null,
    })

    for (const location of body.locations ?? []) {
      if (!location.root_path?.trim()) continue
      const machine = await resolveMachineReference(actor.server_id, location.machine_ref ?? null)
      await upsertProjectLocation(project.id, {
        machineId: machine?.id ?? null,
        machineLabel: machine?.hostname || machine?.name || location.machine_ref?.trim() || null,
        rootPath: location.root_path,
        notes: location.notes ?? null,
        isPrimary: location.is_primary,
      })
    }

    for (const assignment of body.assignments ?? []) {
      const resolvedAgent = await resolveAgentReference(actor.server_id, assignment.agent_ref)
      if (!resolvedAgent) continue
      await upsertProjectAssignment(project.id, {
        agentId: resolvedAgent.id,
        responsibility: assignment.responsibility ?? null,
        isOwner: assignment.is_owner,
        setCurrent: assignment.set_current,
      })
    }

    if (currentAgent) {
      await setAgentCurrentProject(currentAgent.id, project.id)
    }

    await syncProjectRegistryMemory(actor.server_id)

    return {
      ok: true,
      project: (await listProjectsForServer(actor.server_id)).find(item => item.id === project.id),
    }
  })

  // ── POST /:agentId/invite-to-channel ────────────────────────────
  // Let an agent invite other agents/humans into a channel
  app.post('/:agentId/invite-to-channel', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel, members } = req.body as {
      channel: string            // '#channel-name'
      members: string[]          // agent names, @mentions, or IDs
    }

    if (!channel?.trim()) return reply.code(400).send({ error: 'channel required' })
    if (!members?.length) return reply.code(400).send({ error: 'members required (array of names or IDs)' })

    const caller = await queryOne<{ id: string; server_id: string }>(
      'SELECT id, server_id FROM agents WHERE id = $1', [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Agent not found' })

    // Resolve channel
    const channelName = channel.replace(/^#/, '')
    const ch = await queryOne<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND name = $2 LIMIT 1`,
      [caller.server_id, channelName]
    )
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    const invited: string[] = []
    const failed: string[] = []

    for (const ref of members) {
      const cleanRef = ref.replace(/^@/, '').trim()
      if (!cleanRef) { failed.push(ref); continue }

      // Try agent first (by ID or name)
      const agent = await queryOne<{ id: string; name: string }>(
        `SELECT id, name FROM agents WHERE server_id = $1 AND (id::text = $2 OR LOWER(name) = LOWER($2))`,
        [caller.server_id, cleanRef]
      )
      if (agent) {
        await query(
          `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [ch.id, agent.id]
        )
        invited.push(`@${agent.name}`)
        continue
      }

      // Try human
      const human = await queryOne<{ id: string; name: string }>(
        `SELECT u.id, u.name FROM users u
         JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $1
         WHERE LOWER(u.name) = LOWER($2)`,
        [caller.server_id, cleanRef]
      )
      if (human) {
        await query(
          `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [ch.id, human.id]
        )
        invited.push(`@${human.name}`)
        continue
      }

      failed.push(ref)
    }

    return { ok: true, channel, invited, failed }
  })

  app.post('/:agentId/create-agent', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { name, description, role, modelId, runtime, parentAgentId, machineId } = req.body as {
      name: string
      description?: string
      role?: string
      modelId?: string
      runtime?: string
      parentAgentId?: string
      machineId?: string
    }

    if (!name?.trim()) return reply.code(400).send({ error: 'name required' })

    // Get creator agent's server
    const creator = await queryOne<{ id: string; server_id: string; role: string; machine_id: string | null }>(
      'SELECT id, server_id, role, machine_id FROM agents WHERE id = $1',
      [agentId]
    )
    if (!creator) return reply.code(404).send({ error: 'Creator agent not found' })

    // Only coordinators and tech-leads can create agents
    if (creator.role !== 'coordinator' && creator.role !== 'tech-lead') {
      return reply.code(403).send({ error: 'Only coordinator/tech-lead agents can create new agents' })
    }

    const resolvedRuntime = runtime ?? 'claude'
    const resolvedModelId = modelId ?? (resolvedRuntime === 'kimi' ? 'kimi-code/kimi-for-coding' : resolvedRuntime === 'codex' ? 'gpt-5.4' : resolvedRuntime === 'gemini' ? 'gemini-3.1-pro' : 'claude-sonnet-4-6')
    const resolvedProvider = resolvedModelId.startsWith('claude') ? 'anthropic' : resolvedModelId.startsWith('gemini') ? 'google' : (resolvedModelId.startsWith('kimi') || resolvedModelId.startsWith('moonshot')) ? 'moonshot' : 'openai'

    const resolvedWorkspace = resolveAgentWorkspacePath(name)

    // Default parent to the creating agent (Donovan)
    const resolvedParent = parentAgentId ?? agentId

    const resolvedMachineId = machineId ?? creator.machine_id

    const [agent] = await query(
      `INSERT INTO agents
        (server_id, name, description, model_id, model_provider, runtime, workspace_path, role, parent_agent_id, machine_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        creator.server_id, name.trim(), description ?? null,
        resolvedModelId, resolvedProvider, resolvedRuntime,
        resolvedWorkspace, role ?? 'general', resolvedParent,
        resolvedMachineId,
      ]
    )

    // Add to #all channel
    const allChannel = await queryOne<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND name = 'all' LIMIT 1`,
      [creator.server_id]
    )
    if (allChannel) {
      await query(
        `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [allChannel.id, agent.id]
      )
    }

    // Also add to role-specific channel
    const roleChannelMap: Record<string, string> = {
      investigator: 'investigation',
      observer: 'investigation',
      developer: 'engineering', profiler: 'engineering',
      'exp-kernel': 'experiment', 'exp-training': 'experiment', 'exp-inference': 'experiment',
    }
    const roleChannel = roleChannelMap[role ?? '']
    if (roleChannel) {
      const ch = await queryOne<{ id: string }>(
        `SELECT id FROM channels WHERE server_id = $1 AND name = $2 LIMIT 1`,
        [creator.server_id, roleChannel]
      )
      if (ch) {
        await query(
          `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [ch.id, agent.id]
        )
      }
    }

    // Init workspace
    const serverUrl = resolveServerUrl(req)
    initAgentWorkspace(resolvedWorkspace, {
      agentId: agent.id,
      agentName: agent.name,
      description: agent.description ?? null,
      role: (role as AgentRole) ?? 'general',
      modelId: resolvedModelId,
      serverUrl,
      channelName: '#all',
      teamContext: 'Red Shrimp Lab — AI Infra Research Agent Swarm',
    }).catch(err => console.error(`[workspace] Init failed for ${agent.name}:`, err.message))

    return { ok: true, agent: { id: agent.id, name: agent.name, role: agent.role, workspace: resolvedWorkspace } }
  })

  // ── DELETE /:agentId/delete-agent ──────────────────────────────
  // Lets a coordinator/ops agent delete another agent
  app.delete('/:agentId/delete-agent', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { targetAgentId } = req.body as { targetAgentId: string }

    if (!targetAgentId?.trim()) return reply.code(400).send({ error: 'targetAgentId required' })

    // Verify caller exists and has permission
    const caller = await queryOne<{ id: string; role: string }>(
      'SELECT id, role FROM agents WHERE id = $1',
      [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Caller agent not found' })
    if (caller.role !== 'coordinator' && caller.role !== 'ops') {
      return reply.code(403).send({ error: 'Only coordinator/ops agents can delete agents' })
    }

    // Verify target exists
    const target = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM agents WHERE id = $1',
      [targetAgentId]
    )
    if (!target) return reply.code(404).send({ error: 'Target agent not found' })

    // Prevent self-deletion
    if (targetAgentId === agentId) {
      return reply.code(400).send({ error: 'Cannot delete yourself' })
    }

    // Stop the agent process if running
    try { processManager.stop(targetAgentId) } catch { /* may not be running */ }

    // Delete in dependency order
    await query('DELETE FROM agent_logs WHERE agent_id = $1', [targetAgentId])
    await query('DELETE FROM agent_runs WHERE agent_id = $1', [targetAgentId])
    await query('DELETE FROM channel_members WHERE agent_id = $1', [targetAgentId])
    await query('DELETE FROM agents WHERE id = $1', [targetAgentId])

    return { ok: true, deleted: { id: target.id, name: target.name } }
  })

  // ── POST /:agentId/restart-agent ──────────────────────────────
  // Lets a coordinator/tech-lead/ops agent restart another agent
  app.post('/:agentId/restart-agent', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { targetAgentId } = req.body as { targetAgentId: string }

    if (!targetAgentId?.trim()) return reply.code(400).send({ error: 'targetAgentId required' })

    // Verify caller exists and has permission
    const caller = await queryOne<{ id: string; role: string }>(
      'SELECT id, role FROM agents WHERE id = $1',
      [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Caller agent not found' })
    if (caller.role !== 'coordinator' && caller.role !== 'tech-lead' && caller.role !== 'ops') {
      return reply.code(403).send({ error: 'Only coordinator/tech-lead/ops agents can restart agents' })
    }

    // Get target agent
    const target = await queryOne<{ id: string; name: string; status: string }>(
      'SELECT id, name, status FROM agents WHERE id = $1',
      [targetAgentId]
    )
    if (!target) return reply.code(404).send({ error: 'Target agent not found' })

    // Stop if running
    try { await processManager.stop(targetAgentId) } catch { /* may not be running */ }

    // Get full agent config for restart
    const agentRow = await queryOne<any>(
      `SELECT * FROM agents WHERE id = $1`,
      [targetAgentId]
    )
    if (!agentRow) return reply.code(404).send({ error: 'Agent record not found after stop' })

    // Resolve machine name
    let machineName: string | undefined
    if (agentRow.machine_id) {
      const machineRow = await queryOne<{ name: string }>('SELECT name FROM machines WHERE id = $1', [agentRow.machine_id])
      machineName = machineRow?.name || process.env.MACHINE_NAME?.trim() || undefined
    } else {
      machineName = process.env.MACHINE_NAME?.trim() || undefined
    }

    const serverUrl = resolveServerUrl(req)
    const apiKey = `agent_${agentRow.id}_${Date.now()}`

    const config: AgentConfig = {
      id:              agentRow.id,
      name:            agentRow.name,
      machineId:       agentRow.machine_id ?? 'local',
      machineName,
      serverUrl,
      apiKey,
      workspacePath:   agentRow.workspace_path ?? process.cwd(),
      runtime:         agentRow.runtime ?? 'claude',
      modelId:         agentRow.model_id,
      reasoningEffort: agentRow.reasoning_effort ?? undefined,
      sessionId:       agentRow.session_id ?? undefined,
      role:            agentRow.role ?? undefined,
      customApiKey:    agentRow.custom_api_key ?? undefined,
      customBaseUrl:   agentRow.custom_base_url ?? undefined,
    }

    try {
      await processManager.spawn(config)
      await query(`UPDATE agents SET status = 'starting' WHERE id = $1`, [targetAgentId])
    } catch (err: any) {
      await query(`UPDATE agents SET status = 'error' WHERE id = $1`, [targetAgentId])
      return reply.code(500).send({ error: `Failed to restart: ${err.message}` })
    }

    return { ok: true, agent: { id: target.id, name: target.name, pid: null } }
  })

  // ── POST /:agentId/create-channel ──────────────────────────────
  // Create a channel with specific members (agents + humans)
  app.post('/:agentId/create-channel', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { name, description, member_names } = req.body as {
      name: string
      description?: string
      member_names?: string[]
    }

    if (!name?.trim()) return reply.code(400).send({ error: 'name required' })

    // Get caller agent's server
    const caller = await queryOne<{ id: string; server_id: string; name: string }>(
      'SELECT id, server_id, name FROM agents WHERE id = $1',
      [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Agent not found' })

    // Create channel
    const channelName = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    const [channel] = await query(
      `INSERT INTO channels (server_id, name, description, type)
       VALUES ($1, $2, $3, 'channel')
       RETURNING *`,
      [caller.server_id, channelName, description ?? null]
    )

    // Add the calling agent as member
    await query(
      `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [channel.id, agentId]
    )

    const addedMembers: string[] = [caller.name]

    // Add requested members
    if (member_names && member_names.length > 0) {
      for (const memberName of member_names) {
        const cleanName = memberName.replace(/^@/, '').trim()
        if (!cleanName) continue

        // Try agent first
        const agent = await queryOne<{ id: string; name: string }>(
          `SELECT id, name FROM agents WHERE server_id = $1 AND LOWER(name) = LOWER($2)`,
          [caller.server_id, cleanName]
        )
        if (agent) {
          await query(
            `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [channel.id, agent.id]
          )
          if (!addedMembers.includes(agent.name)) addedMembers.push(agent.name)
          continue
        }

        // Try human user
        const user = await queryOne<{ id: string; name: string }>(
          `SELECT u.id, u.name FROM users u
           JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $1
           WHERE LOWER(u.name) = LOWER($2)`,
          [caller.server_id, cleanName]
        )
        if (user) {
          await query(
            `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [channel.id, user.id]
          )
          if (!addedMembers.includes(user.name)) addedMembers.push(user.name)
        }
      }
    }

    return { ok: true, channel: { id: channel.id, name: channel.name }, members: addedMembers }
  })

  // ── POST /:agentId/wake-agent — Wake a sleeping agent without stopping it first
  app.post('/:agentId/wake-agent', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { targetAgentId, message } = req.body as { targetAgentId: string; message?: string }

    if (!targetAgentId?.trim()) return reply.code(400).send({ error: 'targetAgentId required' })

    const caller = await queryOne<{ id: string; role: string; server_id: string }>(
      'SELECT id, role, server_id FROM agents WHERE id = $1', [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Caller not found' })
    if (!['coordinator', 'tech-lead', 'ops'].includes(caller.role)) {
      return reply.code(403).send({ error: 'Only coordinator/tech-lead/ops can wake agents' })
    }

    const target = await queryOne<any>(
      'SELECT * FROM agents WHERE id = $1', [targetAgentId]
    )
    if (!target) return reply.code(404).send({ error: 'Target agent not found' })

    // Check if already running
    if (processManager.isRunning(targetAgentId)) {
      return { ok: true, agent: target.name, status: 'already_running' }
    }

    // Resolve machine name
    let machineName: string | undefined
    if (target.machine_id) {
      const machineRow = await queryOne<{ name: string }>('SELECT name FROM machines WHERE id = $1', [target.machine_id])
      machineName = machineRow?.name || process.env.MACHINE_NAME?.trim() || undefined
    } else {
      machineName = process.env.MACHINE_NAME?.trim() || undefined
    }

    const serverUrl = resolveServerUrl(req)
    const apiKey = `agent_${target.id}_${Date.now()}`

    const config: AgentConfig = {
      id:              target.id,
      name:            target.name,
      machineId:       target.machine_id ?? 'local',
      machineName,
      serverUrl,
      apiKey,
      workspacePath:   target.workspace_path ?? process.cwd(),
      runtime:         target.runtime ?? 'claude',
      modelId:         target.model_id,
      reasoningEffort: target.reasoning_effort ?? undefined,
      sessionId:       target.session_id ?? undefined,
      role:            target.role ?? undefined,
      customApiKey:    target.custom_api_key ?? undefined,
      customBaseUrl:   target.custom_base_url ?? undefined,
    }

    try {
      await processManager.spawn(config)
      await query(`UPDATE agents SET status = 'starting' WHERE id = $1`, [targetAgentId])
    } catch (err: any) {
      return reply.code(500).send({ error: `Failed to wake: ${err.message}` })
    }

    return { ok: true, agent: target.name, status: 'woken' }
  })

  // ── POST /:agentId/add-channel-member — Add member(s) to an existing channel
  app.post('/:agentId/add-channel-member', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { channel_name, member_names } = req.body as {
      channel_name: string
      member_names: string[]
    }

    if (!channel_name?.trim()) return reply.code(400).send({ error: 'channel_name required' })
    if (!member_names?.length) return reply.code(400).send({ error: 'member_names required' })

    // Get caller agent's server
    const caller = await queryOne<{ id: string; server_id: string; name: string }>(
      'SELECT id, server_id, name FROM agents WHERE id = $1',
      [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Agent not found' })

    // Find the channel
    const cleanChannelName = channel_name.replace(/^#/, '').toLowerCase().trim()
    const channel = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM channels WHERE server_id = $1 AND LOWER(name) = LOWER($2)`,
      [caller.server_id, cleanChannelName]
    )
    if (!channel) return reply.code(404).send({ error: `Channel "${channel_name}" not found` })

    const addedMembers: string[] = []
    const notFound: string[] = []

    for (const memberName of member_names) {
      const cleanName = memberName.replace(/^@/, '').trim()
      if (!cleanName) continue

      // Try agent first
      const agent = await queryOne<{ id: string; name: string }>(
        `SELECT id, name FROM agents WHERE server_id = $1 AND LOWER(name) = LOWER($2)`,
        [caller.server_id, cleanName]
      )
      if (agent) {
        await query(
          `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [channel.id, agent.id]
        )
        addedMembers.push(agent.name)
        continue
      }

      // Try human user
      const user = await queryOne<{ id: string; name: string }>(
        `SELECT u.id, u.name FROM users u
         JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $1
         WHERE LOWER(u.name) = LOWER($2)`,
        [caller.server_id, cleanName]
      )
      if (user) {
        await query(
          `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [channel.id, user.id]
        )
        addedMembers.push(user.name)
      } else {
        notFound.push(cleanName)
      }
    }

    return { ok: true, channel: channel.name, added: addedMembers, not_found: notFound }
  })

  // ── POST /:agentId/update-agent-role — Change an agent's role
  app.post('/:agentId/update-agent-role', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { target_agent_name, role } = req.body as { target_agent_name: string; role: string }

    if (!target_agent_name?.trim()) return reply.code(400).send({ error: 'target_agent_name required' })
    if (!role?.trim()) return reply.code(400).send({ error: 'role required' })

    // Permission check: only coordinator/tech-lead/ops can change roles
    const caller = await queryOne<{ id: string; server_id: string; role: string }>(
      'SELECT id, server_id, role FROM agents WHERE id = $1', [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Caller not found' })
    if (!['coordinator', 'tech-lead', 'ops'].includes(caller.role)) {
      return reply.code(403).send({ error: `Role ${caller.role} cannot change agent roles` })
    }

    // Find target agent
    const cleanName = target_agent_name.replace(/^@/, '').trim()
    const target = await queryOne<{ id: string; name: string; role: string }>(
      `SELECT id, name, role FROM agents WHERE server_id = $1 AND LOWER(name) = LOWER($2)`,
      [caller.server_id, cleanName]
    )
    if (!target) return reply.code(404).send({ error: `Agent "${target_agent_name}" not found` })

    const oldRole = target.role
    await query(`UPDATE agents SET role = $1 WHERE id = $2`, [role.trim(), target.id])
    return { ok: true, agent: target.name, old_role: oldRole, new_role: role.trim() }
  })

  // ── POST /:agentId/update-agent-model — Update agent model_id (internal)
  app.post('/:agentId/update-agent-model', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { target_agent_name, model_id } = req.body as {
      target_agent_name: string
      model_id: string
    }
    if (!target_agent_name?.trim() || !model_id?.trim()) {
      return reply.code(400).send({ error: 'target_agent_name and model_id required' })
    }
    const target = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM agents WHERE LOWER(name) = LOWER($1) OR id::text = $1`,
      [target_agent_name.trim()]
    )
    if (!target) return reply.code(404).send({ error: `Agent "${target_agent_name}" not found` })
    await query(
      `UPDATE agents SET model_id = $1 WHERE id = $2`,
      [model_id.trim(), target.id]
    )
    return { ok: true, agent: target.name, model_id: model_id.trim() }
  })

  // ── POST /:agentId/set-agent-parent — Set parent/supervisor for an agent
  app.post('/:agentId/set-agent-parent', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { target_agent_name, parent_agent_name } = req.body as {
      target_agent_name: string
      parent_agent_name: string | null
    }

    if (!target_agent_name?.trim()) return reply.code(400).send({ error: 'target_agent_name required' })

    const caller = await queryOne<{ id: string; server_id: string; role: string }>(
      'SELECT id, server_id, role FROM agents WHERE id = $1', [agentId]
    )
    if (!caller) return reply.code(404).send({ error: 'Caller not found' })
    if (!['coordinator', 'tech-lead', 'ops'].includes(caller.role)) {
      return reply.code(403).send({ error: `Role ${caller.role} cannot set agent hierarchy` })
    }

    const cleanTarget = target_agent_name.replace(/^@/, '').trim()
    const target = await queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM agents WHERE server_id = $1 AND LOWER(name) = LOWER($2)`,
      [caller.server_id, cleanTarget]
    )
    if (!target) return reply.code(404).send({ error: `Agent "${target_agent_name}" not found` })

    let parentId: string | null = null
    let parentName: string | null = null
    if (parent_agent_name) {
      const cleanParent = parent_agent_name.replace(/^@/, '').trim()
      const parent = await queryOne<{ id: string; name: string }>(
        `SELECT id, name FROM agents WHERE server_id = $1 AND LOWER(name) = LOWER($2)`,
        [caller.server_id, cleanParent]
      )
      if (!parent) return reply.code(404).send({ error: `Parent agent "${parent_agent_name}" not found` })
      parentId = parent.id
      parentName = parent.name
    }

    await query(`UPDATE agents SET parent_agent_id = $1 WHERE id = $2`, [parentId, target.id])
    return { ok: true, agent: target.name, parent: parentName ?? '(none)' }
  })

  // ── POST /:agentId/bulletins — Agent publishes a bulletin ─────────────────
  app.post('/:agentId/bulletins', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const agent = await queryOne<{ id: string; name: string; server_id: string }>(
      'SELECT id, name, server_id FROM agents WHERE id = $1', [agentId]
    )
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const { category, title, content, priority, linked_file, linked_url, linked_task_id, metadata, pinned } = req.body as any
    if (!category || !title) return reply.code(400).send({ error: 'category and title are required' })

    const [bulletin] = await query(
      `INSERT INTO bulletins
         (server_id, category, title, content, author_id, author_type, author_name,
          priority, linked_file, linked_task_id, linked_url, metadata, pinned)
       VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        agent.server_id, category, title.trim(), content ?? null,
        agentId, agent.name,
        priority ?? 'normal',
        linked_file ?? null, linked_task_id ?? null, linked_url ?? null,
        metadata ? JSON.stringify(metadata) : '{}',
        pinned ?? false,
      ]
    )

    // Write flash note to vault
    if (process.env.OBSIDIAN_ROOT) {
      const vaultRoot = process.env.OBSIDIAN_ROOT
      const flashDir = path.join(vaultRoot, '05_notes', 'flash')
      try {
        fs.mkdirSync(flashDir, { recursive: true })
        const date = new Date().toISOString().slice(0, 10)
        const slug = (title as string).trim()
          .toLowerCase()
          .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'note'
        const fileName = `flash-${date}-${slug}.md`
        const filePath = path.join(flashDir, fileName)
        const frontmatter = [
          '---',
          `title: "${(title as string).trim()}"`,
          `date: ${date}`,
          `agent: ${agent.name}`,
          `type: ${category}`,
          `tags: [flash, ${category}]`,
          `status: active`,
          '---',
          '',
          (content as string)?.trim() || '',
          '',
        ].join('\n')
        fs.writeFileSync(filePath, frontmatter, 'utf-8')
        // Update bulletin with linked_file
        const vaultRelPath = `05_notes/flash/${fileName}`
        await query('UPDATE bulletins SET linked_file = $1 WHERE id = $2', [vaultRelPath, bulletin.id]).catch(() => {})
        bulletin.linked_file = vaultRelPath
        scheduleVaultCommit(agentName, `${category}: ${title}`)
      } catch {}
    }

    return { bulletin }
  })

  // ── POST /:agentId/vault-commit — Commit vault changes to git ──────
  app.post<{ Params: { agentId: string }; Body: { message?: string } }>(
    '/:agentId/vault-commit',
    async (req) => {
      const { agentId } = req.params
      const agent = await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [agentId])
      if (!agent) return { ok: false, error: 'agent not found' }
      const desc = (req.body as any)?.message?.trim() || undefined
      scheduleVaultCommit(agent.name, desc)
      return { ok: true, message: 'vault commit scheduled' }
    },
  )

  // ── Chrono (Cron Jobs) ────────────────────────────────────────────

  // GET /internal/agent/:agentId/cron — list all cron jobs
  app.get('/:agentId/cron', async (req) => {
    const jobs = await query(
      `SELECT cj.id, cj.agent_id, a.name AS agent_name, cj.cron_expr, cj.prompt,
              cj.channel_id, ch.name AS channel_name, cj.enabled, cj.last_run_at, cj.created_at
       FROM cron_jobs cj
       JOIN agents a ON a.id = cj.agent_id
       LEFT JOIN channels ch ON ch.id = cj.channel_id
       ORDER BY cj.created_at`
    )
    return { jobs }
  })

  // POST /internal/agent/:agentId/cron — create a cron job
  app.post('/:agentId/cron', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { target_agent, cron_expr, prompt, channel } = req.body as {
      target_agent?: string  // agent name or ID; defaults to self
      cron_expr: string
      prompt: string
      channel?: string       // #channel-name
    }

    if (!cron_expr?.trim() || !prompt?.trim()) {
      return reply.code(400).send({ error: 'cron_expr and prompt are required' })
    }

    // Resolve target agent (default: self)
    let targetAgentId = agentId
    if (target_agent?.trim()) {
      const found = await queryOne<{ id: string }>(
        `SELECT id FROM agents WHERE LOWER(name) = LOWER($1) OR id::text = $1`, [target_agent.trim()]
      )
      if (!found) return reply.code(404).send({ error: `Agent "${target_agent}" not found` })
      targetAgentId = found.id
    }

    // Resolve channel
    let channelId: string | null = null
    if (channel?.trim()) {
      const ch = await getScopedChannel(agentId, channel.trim())
      if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })
      channelId = ch.id
    }

    const [job] = await query(
      `INSERT INTO cron_jobs (agent_id, cron_expr, prompt, channel_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [targetAgentId, cron_expr.trim(), prompt.trim(), channelId]
    )
    await scheduler.reloadCronJobs()

    const targetName = target_agent?.trim() || (await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [targetAgentId]))?.name || targetAgentId
    return {
      ok: true,
      job_id: job.id,
      message: `Cron job created: "${cron_expr.trim()}" → ${targetName}${channelId ? ` in ${channel}` : ''}`,
    }
  })

  // PATCH /internal/agent/:agentId/cron/:jobId — update a cron job
  app.patch('/:agentId/cron/:jobId', async (req, reply) => {
    const { jobId } = req.params as { agentId: string; jobId: string }
    const { enabled, cron_expr, prompt } = req.body as {
      enabled?: boolean; cron_expr?: string; prompt?: string
    }

    const existing = await queryOne('SELECT 1 FROM cron_jobs WHERE id = $1', [jobId])
    if (!existing) return reply.code(404).send({ error: 'Cron job not found' })

    const [job] = await query(
      `UPDATE cron_jobs
       SET enabled   = COALESCE($1, enabled),
           cron_expr = COALESCE($2, cron_expr),
           prompt    = COALESCE($3, prompt)
       WHERE id = $4 RETURNING *`,
      [enabled ?? null, cron_expr ?? null, prompt ?? null, jobId]
    )
    await scheduler.reloadCronJobs()
    return { ok: true, job }
  })

  // DELETE /internal/agent/:agentId/cron/:jobId — delete a cron job
  app.delete('/:agentId/cron/:jobId', async (req, reply) => {
    const { jobId } = req.params as { agentId: string; jobId: string }
    const [deleted] = await query('DELETE FROM cron_jobs WHERE id = $1 RETURNING id', [jobId])
    if (!deleted) return reply.code(404).send({ error: 'Cron job not found' })
    await scheduler.reloadCronJobs()
    return { ok: true, message: 'Cron job deleted' }
  })
}
