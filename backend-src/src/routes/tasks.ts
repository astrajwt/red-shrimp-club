// Tasks routes — /api/tasks
// GET    /              list tasks for a channel
// POST   /              create tasks (batch)
// POST   /:id/claim     disabled in explicit-assignment mode
// POST   /:id/unclaim   disabled in explicit-assignment mode
// POST   /:id/review    submit for human review
// POST   /:id/complete  human approves and marks done
// POST   /:id/reopen    human sends task back to doing
// GET    /:id/docs      get linked documents
// POST   /:id/docs      link a document
// PATCH  /:id/docs/:docId  update doc status (writing/unread/read)
// GET    /:id/skills    get linked skills
// POST   /:id/skills    add skill link

import type { FastifyPluginAsync } from 'fastify'
import fs from 'fs'
import path from 'path'
import { query, queryOne } from '../db/client.js'
import {
  emitTaskCreated, emitTaskCompleted, emitTaskAllCompleted, emitTaskDocAdded, emitTaskUpdated,
} from '../daemon/events.js'
import { appendTodoNote, createTodoBundle } from '../services/todo-intake.js'
import { resolveServerScopedAgent } from '../services/task-assignment.js'
import { notifyAgentMembers } from '../services/agent-delivery.js'
import { createStoredMessage } from '../services/message-store.js'
import { reserveTaskNumbers } from '../services/task-sequence.js'

async function getCallerIdentity(sub: string) {
  const user = await queryOne<{ name: string }>('SELECT name FROM users WHERE id = $1', [sub])
  const agent = !user
    ? await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [sub])
    : null

  return {
    callerType: user ? 'human' as const : 'agent' as const,
    callerName: (user ?? agent)?.name ?? 'unknown',
  }
}

const EXPLICIT_ASSIGNMENT_ERROR = 'Tasks must be explicitly assigned. Claim/unclaim is disabled.'

function normalizeDocPath(docPath: string): string {
  return docPath.trim().replace(/\\/g, '/').replace(/^\/+/, '')
}

function resolveDocName(docPath: string, docName?: string): string {
  return docName?.trim() || path.posix.basename(docPath)
}

export const taskRoutes: FastifyPluginAsync = async (app) => {
  await query(`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS review_feedback TEXT,
      ADD COLUMN IF NOT EXISTS review_feedback_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_feedback_by_name VARCHAR(100)
  `).catch(() => {})

  app.get('/review-summary', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const summary = await queryOne<{ reviewing_count: number | string }>(
      `SELECT COUNT(*)::int AS reviewing_count
       FROM tasks t
       JOIN channels c ON c.id = t.channel_id
       JOIN server_members sm ON sm.server_id = c.server_id
       WHERE sm.user_id = $1
         AND t.status = 'reviewing'`,
      [caller.sub]
    )

    return {
      reviewingCount: Number(summary?.reviewing_count ?? 0),
    }
  })

  // ── GET /api/tasks?channelId= ────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.query as { channelId: string }
    const tasks = await query(
      `SELECT t.*,
              pt.number AS parent_task_number,
              COALESCE(json_agg(DISTINCT ts.skill_name) FILTER (WHERE ts.skill_name IS NOT NULL), '[]') AS skills,
              COALESCE(json_agg(DISTINCT jsonb_build_object(
                'id', td.id, 'task_id', td.task_id, 'doc_path', td.doc_path, 'doc_name', td.doc_name, 'status', td.status
              )) FILTER (WHERE td.id IS NOT NULL), '[]') AS docs,
              (SELECT count(*)::int FROM tasks sub WHERE sub.parent_task_id = t.id) AS subtask_count
       FROM tasks t
       LEFT JOIN task_skills   ts ON ts.task_id = t.id
       LEFT JOIN task_documents td ON td.task_id = t.id
       LEFT JOIN tasks         pt ON pt.id = t.parent_task_id
       WHERE t.channel_id = $1
       GROUP BY t.id, pt.number
       ORDER BY t.number`,
      [channelId]
    )
    return { tasks }
  })

  // ── POST /api/tasks ───────────────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { channelId, tasks: taskList } = req.body as {
      channelId: string
      tasks: { title: string; assigneeAgentId?: string; estimatedMinutes?: number }[]
    }

    if (!taskList?.length) return reply.code(400).send({ error: 'tasks[] required' })

    const channel = await queryOne<{ id: string; server_id: string }>(
      'SELECT id, server_id FROM channels WHERE id = $1',
      [channelId]
    )
    if (!channel) return reply.code(404).send({ error: 'Channel not found' })

    const reserved = await reserveTaskNumbers(channelId, taskList.length)

    const created = await Promise.all(
      taskList.map(async (t, i) => {
        const assignee = await resolveServerScopedAgent(channel.server_id, t.assigneeAgentId)
        const [task] = await query(
          `INSERT INTO tasks (
             channel_id, title, number, status, claimed_by_id, claimed_by_type, claimed_by_name, claimed_at, estimated_minutes
           ) VALUES ($1, $2, $3, 'claimed', $4, 'agent', $5, NOW(), $6)
           RETURNING *`,
          [channelId, t.title, reserved.first + i, assignee.id, assignee.name, t.estimatedMinutes ?? null]
        )
        return task
      })
    )
    // Emit task:created for each new task
    for (const task of created) {
      emitTaskCreated(caller.sub, task.id, channelId)
    }
    return { tasks: created }
  })

  // ── POST /api/tasks/intake ────────────────────────────────────────
  app.post('/intake', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string; name?: string }
    const body = req.body as {
      channelId: string
      title: string
      summary?: string
      ownerAgentId?: string
      cleanLevel?: string
      dueDate?: string
      subtasks?: Array<{ title: string; assigneeAgentId?: string }>
    }

    if (!body.channelId || !body.title?.trim()) {
      return reply.code(400).send({ error: 'channelId and title are required' })
    }
    if (!body.ownerAgentId?.trim()) {
      return reply.code(400).send({ error: 'ownerAgentId is required for explicit assignment' })
    }

    try {
      const channel = await queryOne<{ id: string; server_id: string }>(
        'SELECT id, server_id FROM channels WHERE id = $1',
        [body.channelId]
      )
      if (!channel) {
        return reply.code(404).send({ error: 'Channel not found' })
      }

      const ownerAgent = await resolveServerScopedAgent(channel.server_id, body.ownerAgentId)
      const subtasks = await Promise.all(
        (body.subtasks ?? []).map(async item => ({
          title: item.title,
          assigneeAgentId: item.assigneeAgentId?.trim()
            ? (await resolveServerScopedAgent(channel.server_id, item.assigneeAgentId)).id
            : undefined,
        }))
      )

      const bundle = await createTodoBundle({
        actorId: caller.sub,
        channelId: body.channelId,
        title: body.title.trim(),
        summary: body.summary,
        ownerAgentId: ownerAgent.id,
        reviewerName: caller.name ?? 'Jwt2077',
        cleanLevel: body.cleanLevel,
        dueDate: body.dueDate,
        subtasks,
      })
      return { ok: true, bundle }
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'Todo intake failed' })
    }
  })

  // ── POST /api/tasks/:id/approve ───────────────────────────────────
  // Human approves a candidate subtask
  app.post('/:id/approve', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const [task] = await query(
      `UPDATE tasks SET is_candidate = false WHERE id = $1 AND is_candidate = true RETURNING *`,
      [id]
    )
    if (!task) return reply.code(404).send({ error: 'Candidate task not found' })
    emitTaskUpdated(caller.sub, id, task.channel_id)
    return { task }
  })

  // ── PATCH /api/tasks/:id/estimate ─────────────────────────────────
  // Set or update estimated_minutes for a task (used by Donovan/coordinator)
  app.patch('/:id/estimate', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { estimatedMinutes } = req.body as { estimatedMinutes: number }
    if (!estimatedMinutes || estimatedMinutes <= 0) {
      return reply.code(400).send({ error: 'estimatedMinutes must be a positive number' })
    }
    const [task] = await query(
      `UPDATE tasks SET estimated_minutes = $1 WHERE id = $2 RETURNING *`,
      [estimatedMinutes, id]
    )
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    emitTaskUpdated(caller.sub, id, task.channel_id)
    return { task }
  })

  // ── PATCH /api/tasks/:id ──────────────────────────────────────────
  // Generic update for editable fields (title, due_date, estimated_minutes)
  app.patch('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const updates = req.body as Record<string, any>

    const allowed = ['title', 'due_date', 'estimated_minutes']
    const sets: string[] = []
    const params: any[] = []
    let idx = 1

    for (const key of allowed) {
      if (key in updates) {
        sets.push(`${key} = $${idx}`)
        params.push(updates[key])
        idx++
      }
    }

    if (sets.length === 0) return reply.code(400).send({ error: 'No valid fields to update' })

    params.push(id)
    const [task] = await query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    )
    if (!task) return reply.code(404).send({ error: 'Task not found' })
    emitTaskUpdated(caller.sub, id, task.channel_id)
    return { task }
  })

  // ── POST /api/tasks/:id/claim ─────────────────────────────────────
  app.post('/:id/claim', { preHandler: [app.authenticate] }, async (_req, reply) => {
    return reply.code(409).send({ error: EXPLICIT_ASSIGNMENT_ERROR })
  })

  // ── POST /api/tasks/:id/unclaim ───────────────────────────────────
  app.post('/:id/unclaim', { preHandler: [app.authenticate] }, async (_req, reply) => {
    return reply.code(409).send({ error: EXPLICIT_ASSIGNMENT_ERROR })
  })

  // ── POST /api/tasks/:id/complete ──────────────────────────────────
  app.post('/:id/start', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const [task] = await query(
      `UPDATE tasks
       SET status = 'in_progress',
           started_at = COALESCE(started_at, NOW()),
           review_feedback = NULL,
           review_feedback_at = NULL,
           review_feedback_by_name = NULL
       WHERE id = $1 AND claimed_by_id = $2 AND status = 'claimed'
       RETURNING *`,
      [id, caller.sub]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot move task to in_progress' })
    emitTaskUpdated(caller.sub, id, task.channel_id)
    return { task }
  })

  // ── POST /api/tasks/:id/complete ──────────────────────────────────
  app.post('/:id/review', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const unreadDocs = await query(
      `SELECT td.id FROM task_documents td
       LEFT JOIN doc_reads dr ON dr.doc_path = td.doc_path AND dr.user_id = $1
       WHERE td.task_id = $2 AND dr.user_id IS NULL AND td.status != 'writing'`,
      [caller.sub, id]
    )

    if (unreadDocs.length > 0) {
      return reply.code(400).send({
        error: 'Review package incomplete: please read all linked documents first',
        unreadCount: unreadDocs.length,
      })
    }

    const [task] = await query(
      `UPDATE tasks
       SET status = 'reviewing'
       WHERE id = $1 AND claimed_by_id = $2 AND status = 'in_progress'
       RETURNING *`,
      [id, caller.sub]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot submit for review' })
    emitTaskUpdated(caller.sub, id, task.channel_id)
    return { task }
  })

  // ── POST /api/tasks/:id/complete ──────────────────────────────────
  app.post('/:id/complete', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { callerType } = await getCallerIdentity(caller.sub)

    if (callerType !== 'human') {
      return reply.code(403).send({ error: 'Only a human reviewer can mark task done' })
    }

    const [task] = await query(
      `UPDATE tasks
       SET status = 'completed',
           completed_at = NOW(),
           review_feedback = NULL,
           review_feedback_at = NULL,
           review_feedback_by_name = NULL
       WHERE id = $1 AND status = 'reviewing'
       RETURNING *`,
      [id]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot complete — task is not in reviewing' })

    // Record accept feedback
    const { callerType: cType, callerName: cName } = await getCallerIdentity(caller.sub)
    await query(
      `INSERT INTO task_feedbacks (task_id, reviewer_id, reviewer_type, reviewer_name, verdict)
       VALUES ($1, $2, $3, $4, 'accept')`,
      [id, caller.sub, cType, cName]
    ).catch(() => {})

    // Emit task:completed
    emitTaskCompleted(caller.sub, id, task.channel_id)

    // Check if ALL tasks in this channel are now completed → emit task:all_completed
    const openTasks = await query(
      `SELECT id FROM tasks WHERE channel_id = $1 AND status != 'completed'`,
      [task.channel_id]
    )
    if (openTasks.length === 0) {
      emitTaskAllCompleted(caller.sub, task.channel_id)
    }

    return { task }
  })

  // ── POST /api/tasks/:id/reject ────────────────────────────────────
  app.post('/:id/reject', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { callerType, callerName } = await getCallerIdentity(caller.sub)
    const { message } = req.body as { message?: string }

    if (callerType !== 'human') {
      return reply.code(403).send({ error: 'Only a human reviewer can reject task' })
    }
    if (!message?.trim()) {
      return reply.code(400).send({ error: 'Rejection message is required' })
    }

    const [task] = await query(
      `UPDATE tasks
       SET status = 'in_progress',
           completed_at = NULL,
           review_feedback = $2,
           review_feedback_at = NOW(),
           review_feedback_by_name = $3
       WHERE id = $1 AND status = 'reviewing' AND claimed_by_id IS NOT NULL
       RETURNING *`,
      [id, message.trim(), callerName]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot reject task' })
    emitTaskUpdated(caller.sub, id, task.channel_id)

    // Also write to task_feedbacks for unified tracking
    await query(
      `INSERT INTO task_feedbacks (task_id, reviewer_id, reviewer_type, reviewer_name, verdict, reason_text)
       VALUES ($1, $2, $3, $4, 'reject', $5)`,
      [id, caller.sub, callerType, callerName, message.trim()]
    ).catch(() => {})

    // DM the assigned agent so they wake up and continue working
    if (task.claimed_by_id) {
      // Find or create DM channel between reviewer and agent
      const agentRow = await queryOne<{ id: string; server_id: string }>(
        'SELECT id, server_id FROM agents WHERE id = $1', [task.claimed_by_id]
      )
      if (agentRow) {
        let dmChannel = await queryOne<{ id: string }>(
          `SELECT c.id FROM channels c
           JOIN channel_members cm1 ON cm1.channel_id = c.id AND cm1.agent_id = $1
           JOIN channel_members cm2 ON cm2.channel_id = c.id AND cm2.user_id = $2
           WHERE c.type = 'dm' LIMIT 1`,
          [task.claimed_by_id, caller.sub]
        )
        if (!dmChannel) {
          const [ch] = await query(
            `INSERT INTO channels (server_id, name, type) VALUES ($1, $2, 'dm') RETURNING id`,
            [agentRow.server_id, `dm-${Date.now()}`]
          )
          dmChannel = ch
          await query('INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ch.id, task.claimed_by_id])
          await query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ch.id, caller.sub])
        }
        const rejectionContent = `#t${task.number} "${task.title}" 被驳回，请继续修改。驳回理由：${message.trim()}`
        await createStoredMessage({
          channelId: dmChannel.id,
          senderId: caller.sub,
          senderType: 'user',
          senderName: callerName,
          content: rejectionContent,
        }).catch(() => {})
      }
    }

    return { task }
  })

  app.delete('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { callerType } = await getCallerIdentity(caller.sub)

    if (callerType !== 'human') {
      return reply.code(403).send({ error: 'Only a human can permanently delete tasks' })
    }

    const task = await queryOne<{ id: string; title: string; number: number; channel_id: string }>(
      'SELECT id, title, number, channel_id FROM tasks WHERE id = $1',
      [id]
    )
    if (!task) return reply.code(404).send({ error: 'Task not found' })

    await query('DELETE FROM tasks WHERE id = $1', [id])
    return { ok: true, deletedTask: task }
  })

  // ── Auto-create task_feedbacks table ──────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS task_feedbacks (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      reviewer_id     UUID NOT NULL,
      reviewer_type   VARCHAR(10) NOT NULL,
      reviewer_name   VARCHAR(100) NOT NULL,
      verdict         VARCHAR(10) NOT NULL CHECK (verdict IN ('accept', 'reject', 'revise')),
      reason_category VARCHAR(30) CHECK (reason_category IN (
        'skill_gap', 'prompt_gap', 'bad_split', 'missing_context', 'execution_error', 'permission_issue'
      )),
      reason_text     TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {})

  // ── POST /api/tasks/:id/feedback ────────────────────────────────
  app.post('/:id/feedback', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { verdict, reasonCategory, reasonText } = req.body as {
      verdict: 'accept' | 'reject' | 'revise'
      reasonCategory?: string
      reasonText?: string
    }

    if (!['accept', 'reject', 'revise'].includes(verdict)) {
      return reply.code(400).send({ error: 'verdict must be accept, reject, or revise' })
    }

    const { callerType, callerName } = await getCallerIdentity(caller.sub)

    const [feedback] = await query(
      `INSERT INTO task_feedbacks (task_id, reviewer_id, reviewer_type, reviewer_name, verdict, reason_category, reason_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, caller.sub, callerType, callerName, verdict, reasonCategory ?? null, reasonText ?? null]
    )
    return { feedback }
  })

  // ── GET /api/tasks/:id/feedback ─────────────────────────────────
  app.get('/:id/feedback', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const feedbacks = await query(
      `SELECT * FROM task_feedbacks WHERE task_id = $1 ORDER BY created_at`,
      [id]
    )
    return { feedbacks }
  })

  // ── GET /api/tasks/:id/docs ─────────────────────────────────
  app.get('/:id/docs', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const docs = await query('SELECT * FROM task_documents WHERE task_id = $1', [id])
    return { docs }
  })

  app.post('/:id/docs', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { docPath, docName } = req.body as { docPath: string; docName?: string }
    const normalizedDocPath = normalizeDocPath(docPath ?? '')

    if (!normalizedDocPath) {
      return reply.code(400).send({ error: 'docPath is required' })
    }

    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (vaultRoot) {
      const resolved = path.resolve(vaultRoot, normalizedDocPath)
      if (!resolved.startsWith(path.resolve(vaultRoot))) {
        return reply.code(403).send({ error: 'Path traversal not allowed' })
      }
      if (!fs.existsSync(resolved)) {
        return reply.code(404).send({ error: `Document not found: ${normalizedDocPath}` })
      }
    }

    const existing = await queryOne(
      `SELECT * FROM task_documents WHERE task_id = $1 AND doc_path = $2`,
      [id, normalizedDocPath]
    )
    if (existing) return { doc: existing }

    const [doc] = await query(
      `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
       VALUES ($1, $2, $3, 'unread') RETURNING *`,
      [id, normalizedDocPath, resolveDocName(normalizedDocPath, docName)]
    )
    emitTaskDocAdded(caller.sub, id, normalizedDocPath)
    return { doc }
  })

  app.delete('/:id/docs/:docId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id, docId } = req.params as { id: string; docId: string }

    const [deleted] = await query(
      `DELETE FROM task_documents WHERE task_id = $1 AND id = $2 RETURNING *`,
      [id, docId]
    )
    if (!deleted) return reply.code(404).send({ error: 'Document link not found' })
    return { ok: true }
  })

  app.post('/:id/docs/:docId/read', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id, docId } = req.params as { id: string; docId: string }

    const doc = await queryOne<{ id: string; doc_path: string }>(
      `SELECT id, doc_path FROM task_documents WHERE task_id = $1 AND id = $2`,
      [id, docId]
    )
    if (!doc) return reply.code(404).send({ error: 'Document link not found' })

    await query(
      `INSERT INTO doc_reads (user_id, doc_path) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [caller.sub, doc.doc_path]
    )

    const [updated] = await query(
      `UPDATE task_documents SET status = 'read' WHERE id = $1 RETURNING *`,
      [docId]
    )
    return { doc: updated }
  })

  // ── PATCH /api/tasks/:id/docs/:docId ─────────────────────────────
  app.patch('/:id/docs/:docId', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { docId } = req.params as { id: string; docId: string }
    const { status } = req.body as { status: 'writing' | 'unread' | 'read' }

    if (status === 'read') {
      // Record user read
      const doc = await queryOne<{ doc_path: string }>(
        'SELECT doc_path FROM task_documents WHERE id = $1', [docId]
      )
      if (doc) {
        await query(
          `INSERT INTO doc_reads (user_id, doc_path) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [caller.sub, doc.doc_path]
        )
      }
    }

    const [updated] = await query(
      `UPDATE task_documents SET status = $1 WHERE id = $2 RETURNING *`,
      [status, docId]
    )
    return { doc: updated }
  })

  // ── POST /api/tasks/:id/memory-note ──────────────────────────────
  app.post('/:id/memory-note', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const body = req.body as { title: string; content: string }

    if (!body.title?.trim() || !body.content?.trim()) {
      return reply.code(400).send({ error: 'title and content are required' })
    }

    try {
      const note = await appendTodoNote({
        actorId: caller.sub,
        taskId: id,
        title: body.title.trim(),
        content: body.content,
      })
      return { ok: true, note }
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'Failed to append memory note' })
    }
  })

  // ── GET/POST /api/tasks/:id/skills ───────────────────────────────
  app.get('/:id/skills', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const skills = await query('SELECT skill_name FROM task_skills WHERE task_id = $1', [id])
    return { skills: skills.map((r: any) => r.skill_name) }
  })

  app.post('/:id/skills', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const { skillName } = req.body as { skillName: string }

    await query(
      `INSERT INTO task_skills (task_id, skill_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, skillName]
    )
    return { ok: true }
  })
}
