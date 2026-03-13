// Tasks routes — /api/tasks
// GET    /              list tasks for a channel
// POST   /              create tasks (batch)
// POST   /:id/claim     atomic claim
// POST   /:id/unclaim   release claim
// POST   /:id/review    submit for human review
// POST   /:id/complete  human approves and marks done
// POST   /:id/reopen    human sends task back to doing
// GET    /:id/docs      get linked documents
// POST   /:id/docs      link a document
// PATCH  /:id/docs/:docId  update doc status (writing/unread/read)
// GET    /:id/skills    get linked skills
// POST   /:id/skills    add skill link

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import {
  emitTaskCreated, emitTaskCompleted, emitTaskAllCompleted, emitTaskDocAdded,
} from '../daemon/events.js'
import { appendTodoNote, createTodoBundle } from '../services/todo-intake.js'

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

export const taskRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/tasks?channelId= ────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.query as { channelId: string }
    const tasks = await query(
      `SELECT t.*,
              COALESCE(json_agg(DISTINCT ts.skill_name) FILTER (WHERE ts.skill_name IS NOT NULL), '[]') AS skills,
              COALESCE(json_agg(DISTINCT jsonb_build_object(
                'id', td.id, 'docPath', td.doc_path, 'docName', td.doc_name, 'status', td.status
              )) FILTER (WHERE td.id IS NOT NULL), '[]') AS docs
       FROM tasks t
       LEFT JOIN task_skills   ts ON ts.task_id = t.id
       LEFT JOIN task_documents td ON td.task_id = t.id
       WHERE t.channel_id = $1
       GROUP BY t.id
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
      tasks: { title: string }[]
    }

    if (!taskList?.length) return reply.code(400).send({ error: 'tasks[] required' })

    // Atomically get next task numbers
    const seqRow = await queryOne<{ last_num: number }>(
      `INSERT INTO task_sequences (channel_id, last_num) VALUES ($1, $2)
       ON CONFLICT (channel_id) DO UPDATE
         SET last_num = task_sequences.last_num + $2
       RETURNING last_num`,
      [channelId, taskList.length]
    )
    const lastNum  = seqRow?.last_num ?? taskList.length
    const firstNum = lastNum - taskList.length + 1

    const created = await Promise.all(
      taskList.map(async (t, i) => {
        const [task] = await query(
          `INSERT INTO tasks (channel_id, title, number) VALUES ($1, $2, $3) RETURNING *`,
          [channelId, t.title, firstNum + i]
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
      subtasks?: Array<{ title: string; assigneeAgentId?: string }>
    }

    if (!body.channelId || !body.title?.trim()) {
      return reply.code(400).send({ error: 'channelId and title are required' })
    }

    try {
      const bundle = await createTodoBundle({
        actorId: caller.sub,
        channelId: body.channelId,
        title: body.title.trim(),
        summary: body.summary,
        ownerAgentId: body.ownerAgentId,
        reviewerName: caller.name ?? 'Jwt2077',
        cleanLevel: body.cleanLevel,
        subtasks: body.subtasks,
      })
      return { ok: true, bundle }
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'Todo intake failed' })
    }
  })

  // ── POST /api/tasks/:id/claim ─────────────────────────────────────
  app.post('/:id/claim', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller  = req.user as { sub: string }
    const { id }  = req.params as { id: string }

    const { callerType, callerName } = await getCallerIdentity(caller.sub)

    // Atomic claim — only succeeds if currently open
    const [task] = await query(
      `UPDATE tasks
       SET status = 'claimed', claimed_by_id = $1, claimed_by_type = $2,
           claimed_by_name = $3, claimed_at = NOW()
       WHERE id = $4 AND status = 'open'
       RETURNING *`,
      [caller.sub, callerType, callerName, id]
    )

    if (!task) return reply.code(409).send({ error: 'Task already claimed or not found' })
    return { task }
  })

  // ── POST /api/tasks/:id/unclaim ───────────────────────────────────
  app.post('/:id/unclaim', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const [task] = await query(
      `UPDATE tasks
       SET status = 'open', claimed_by_id = NULL, claimed_by_type = NULL,
           claimed_by_name = NULL, claimed_at = NULL
       WHERE id = $1 AND claimed_by_id = $2 AND status = 'claimed'
       RETURNING *`,
      [id, caller.sub]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot unclaim — not your task' })
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
       WHERE id = $1 AND claimed_by_id = $2 AND status = 'claimed'
       RETURNING *`,
      [id, caller.sub]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot submit for review' })
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
      `UPDATE tasks SET status = 'completed', completed_at = NOW()
       WHERE id = $1 AND status = 'reviewing'
       RETURNING *`,
      [id]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot complete — task is not in reviewing' })

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

  // ── POST /api/tasks/:id/reopen ────────────────────────────────────
  app.post('/:id/reopen', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { callerType } = await getCallerIdentity(caller.sub)

    if (callerType !== 'human') {
      return reply.code(403).send({ error: 'Only a human reviewer can reopen task' })
    }

    const [task] = await query(
      `UPDATE tasks
       SET status = 'claimed', completed_at = NULL
       WHERE id = $1 AND status IN ('reviewing', 'completed') AND claimed_by_id IS NOT NULL
       RETURNING *`,
      [id]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot reopen task' })
    return { task }
  })

  // ── GET/POST /api/tasks/:id/docs ─────────────────────────────────
  app.get('/:id/docs', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const docs = await query('SELECT * FROM task_documents WHERE task_id = $1', [id])
    return { docs }
  })

  app.post('/:id/docs', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { docPath, docName } = req.body as { docPath: string; docName: string }

    const [doc] = await query(
      `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
       VALUES ($1, $2, $3, 'unread') RETURNING *`,
      [id, docPath, docName]
    )
    emitTaskDocAdded(caller.sub, id, docPath)
    return { doc }
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
