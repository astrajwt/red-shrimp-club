// Internal agent routes — /internal/agent/:agentId/*
// Used by chat-bridge.js (MCP server) to let shrimps send/receive messages
// These routes do NOT require JWT — they use agent ID directly (trusted internal)

import type { FastifyPluginAsync } from 'fastify'
import fs from 'fs'
import path from 'path'
import { query, queryOne } from '../db/client.js'
import { emitTaskAllCompleted, emitTaskCompleted, emitTaskDocAdded } from '../daemon/events.js'
import { processManager } from '../daemon/process-manager.js'
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

    processManager.updateHeartbeat(agentId)
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
      // Agents may only send into channels they already belong to.
      const ch = await getScopedChannel(agentId, channel)
      if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })
      channelId = ch.id
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
        processManager.updateHeartbeat(agentId)
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
      // Append attachment absolute paths so agents can read files directly
      const atts = typeof m.attachments === 'string' ? JSON.parse(m.attachments) : (m.attachments ?? [])
      if (Array.isArray(atts) && atts.length > 0) {
        const lines = atts.map((a: any) => {
          const fileName = a.url?.replace(/^\/uploads\//, '') ?? a.file_id + '.bin'
          return `[attachment: ${a.filename} (${a.mime_type})] ${uploadsDir}/${fileName}`
        })
        content = content + '\n' + lines.join('\n')
      }
      return {
        channel_name: m.channel_name,
        channel_type: m.channel_type,
        sender_name: m.sender_name,
        sender_type: m.sender_type,
        content,
        timestamp: m.created_at,
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

    const ch = await getScopedChannel(agentId, channel)
    if (!ch) return reply.code(404).send({ error: `Channel "${channel}" not found` })

    let sql = `SELECT t.id, t.number AS "taskNumber", t.title,
                      CASE
                        WHEN t.status IN ('open', 'claimed') THEN 'todo'
                        WHEN t.status = 'reviewing' THEN 'in_review'
                        WHEN t.status = 'completed' THEN 'done'
                        ELSE t.status
                      END AS status,
                      t.claimed_by_name AS "claimedByName"
               FROM tasks t
               WHERE t.channel_id = $1`
    const params: unknown[] = [ch.id]

    if (status && status !== 'all') {
      if (status === 'todo') {
        sql += ` AND t.status IN ('open', 'claimed')`
      } else if (status === 'in_review') {
        sql += ` AND t.status = $2`
        params.push('reviewing')
      } else if (status === 'done') {
        sql += ` AND t.status = $2`
        params.push('completed')
      } else {
        sql += ` AND t.status = $2`
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
         ) VALUES ($1, $2, 'claimed', $3, $4, 'agent', $5, NOW(), $6) RETURNING *`,
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

    const task = await queryOne<{
      id: string
      status: string
      claimed_by_id: string | null
    }>(
      'SELECT id, status, claimed_by_id FROM tasks WHERE channel_id = $1 AND number = $2',
      [ch.id, task_number]
    )
    if (!task) return reply.code(404).send({ error: `Task #t${task_number} not found` })
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
      in_progress: ['in_review', 'done'],
      in_review: ['in_progress', 'done'],
      done: [],
    }
    if (!allowedTransitions[currentStatus]?.includes(status)) {
      return reply.code(409).send({
        error: `Invalid transition: ${currentStatus} -> ${status}`,
      })
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

    return { ok: true }
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

  app.post('/:agentId/create-agent', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const { name, description, role, modelId, runtime, parentAgentId } = req.body as {
      name: string
      description?: string
      role?: string
      modelId?: string
      runtime?: string
      parentAgentId?: string
    }

    if (!name?.trim()) return reply.code(400).send({ error: 'name required' })

    // Get creator agent's server
    const creator = await queryOne<{ id: string; server_id: string; role: string }>(
      'SELECT id, server_id, role FROM agents WHERE id = $1',
      [agentId]
    )
    if (!creator) return reply.code(404).send({ error: 'Creator agent not found' })

    // Only coordinators can create agents
    if (creator.role !== 'coordinator' && creator.role !== 'general') {
      return reply.code(403).send({ error: 'Only coordinator agents can create new agents' })
    }

    const resolvedRuntime = runtime ?? 'claude'
    const resolvedModelId = modelId ?? (resolvedRuntime === 'kimi' ? 'kimi-code/kimi-for-coding' : resolvedRuntime === 'codex' ? 'gpt-5.4' : 'claude-sonnet-4-6')
    const resolvedProvider = resolvedModelId.startsWith('claude') ? 'anthropic' : (resolvedModelId.startsWith('kimi') || resolvedModelId.startsWith('moonshot')) ? 'moonshot' : 'openai'

    const resolvedWorkspace = resolveAgentWorkspacePath(name)

    // Default parent to the creating agent (Donovan)
    const resolvedParent = parentAgentId ?? agentId

    const [agent] = await query(
      `INSERT INTO agents
        (server_id, name, description, model_id, model_provider, runtime, workspace_path, role, parent_agent_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        creator.server_id, name.trim(), description ?? null,
        resolvedModelId, resolvedProvider, resolvedRuntime,
        resolvedWorkspace, role ?? 'general', resolvedParent,
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

    return { ok: true, agent: { id: agent.id, name: agent.name, role: agent.role } }
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
}
