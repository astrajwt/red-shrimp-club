/**
 * 任务路由 — /api/tasks
 *
 * 文件位置: backend-src/src/routes/tasks.ts
 * 核心功能:
 *   GET    /              — 列出频道中的任务（含关联文档和技能标签）
 *   POST   /              — 批量创建任务
 *   POST   /:id/claim     — 原子认领任务
 *   POST   /:id/unclaim   — 释放认领
 *   POST   /:id/complete  — 标记完成（需先审阅所有关联文档）
 *   GET    /:id/docs      — 获取任务关联文档
 *   POST   /:id/docs      — 关联文档到任务
 *   PATCH  /:id/docs/:docId — 更新文档状态 (writing/unread/read)
 *   GET    /:id/skills    — 获取任务技能标签
 *   POST   /:id/skills    — 添加技能标签
 *
 * 任务生命周期: open → claimed → pending_review → completed
 * 任务编号: 每个频道独立递增的序号 (#t1, #t2, ...)
 * 认领机制: 乐观锁 (WHERE status = 'open')，人类和 Agent 均可认领
 */

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'

export const taskRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/tasks?channelId= ────────────────────────────────────
  /**
   * 获取频道中的所有任务
   * 使用 LEFT JOIN + json_agg 聚合，一次查询返回任务及其关联的技能和文档
   * FILTER (WHERE ... IS NOT NULL) 避免聚合出 [null] 的情况
   * 按任务编号排序
   */
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
  /**
   * 批量创建任务
   * @param channelId 所属频道
   * @param tasks     任务列表 [{ title }]
   *
   * 编号分配算法:
   *   使用 task_sequences 表原子递增，一次预分配 N 个编号
   *   ON CONFLICT DO UPDATE 保证并发安全
   */
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId, tasks: taskList } = req.body as {
      channelId: string
      tasks: { title: string }[]
    }

    if (!taskList?.length) return reply.code(400).send({ error: 'tasks[] required' })

    // 原子分配连续的任务编号
    const seqRow = await queryOne<{ last_num: number }>(
      `INSERT INTO task_sequences (channel_id, last_num) VALUES ($1, $2)
       ON CONFLICT (channel_id) DO UPDATE
         SET last_num = task_sequences.last_num + $2
       RETURNING last_num`,
      [channelId, taskList.length]
    )
    const lastNum  = seqRow?.last_num ?? taskList.length
    const firstNum = lastNum - taskList.length + 1

    // 并行插入所有任务
    const created = await Promise.all(
      taskList.map(async (t, i) => {
        const [task] = await query(
          `INSERT INTO tasks (channel_id, title, number) VALUES ($1, $2, $3) RETURNING *`,
          [channelId, t.title, firstNum + i]
        )
        return task
      })
    )
    return { tasks: created }
  })

  // ── POST /api/tasks/:id/claim ─────────────────────────────────────
  /**
   * 原子认领任务
   * 使用乐观锁: WHERE status = 'open' 确保只有一个人能认领
   * 人类和 Agent 均可认领（通过 claimed_by_type 区分）
   * 返回 409 表示任务已被他人认领
   */
  app.post('/:id/claim', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller  = req.user as { sub: string }
    const { id }  = req.params as { id: string }

    // 识别调用者身份（人类 or Agent）
    const user = await queryOne<{ name: string }>('SELECT name FROM users WHERE id = $1', [caller.sub])
    const agent = !user
      ? await queryOne<{ name: string }>('SELECT name FROM agents WHERE id = $1', [caller.sub])
      : null

    const callerType = user ? 'human' : 'agent'
    const callerName = (user ?? agent)?.name ?? 'unknown'

    // 原子认领: 仅当 status='open' 时才能成功
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
  /**
   * 释放任务认领
   * 安全约束: 只有认领者本人才能释放 (WHERE claimed_by_id = $2)
   */
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
  /**
   * 标记任务完成
   * 前置条件: 所有关联文档必须已被审阅（doc_reads 表中有记录）
   * 排除 status='writing' 的文档（Agent 正在撰写中的不算）
   * 安全约束: 只有认领者本人才能完成
   */
  app.post('/:id/complete', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    // 检查是否有未审阅的关联文档
    const unreadDocs = await query(
      `SELECT td.id FROM task_documents td
       LEFT JOIN doc_reads dr ON dr.doc_path = td.doc_path AND dr.user_id = $1
       WHERE td.task_id = $2 AND dr.user_id IS NULL AND td.status != 'writing'`,
      [caller.sub, id]
    )

    if (unreadDocs.length > 0) {
      return reply.code(400).send({
        error: 'Review required: please read all linked documents first',
        unreadCount: unreadDocs.length,
      })
    }

    const [task] = await query(
      `UPDATE tasks SET status = 'completed', completed_at = NOW()
       WHERE id = $1 AND claimed_by_id = $2
       RETURNING *`,
      [id, caller.sub]
    )
    if (!task) return reply.code(403).send({ error: 'Cannot complete — not your task' })
    return { task }
  })

  // ── GET/POST /api/tasks/:id/docs ─────────────────────────────────
  /** 获取任务关联的文档列表 */
  app.get('/:id/docs', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const docs = await query('SELECT * FROM task_documents WHERE task_id = $1', [id])
    return { docs }
  })

  /** 将一个文档关联到任务，初始状态为 'unread' */
  app.post('/:id/docs', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const { docPath, docName } = req.body as { docPath: string; docName: string }

    const [doc] = await query(
      `INSERT INTO task_documents (task_id, doc_path, doc_name, status)
       VALUES ($1, $2, $3, 'unread') RETURNING *`,
      [id, docPath, docName]
    )
    return { doc }
  })

  // ── PATCH /api/tasks/:id/docs/:docId ─────────────────────────────
  /**
   * 更新文档状态
   * 状态流转: writing（Agent 撰写中） → unread（待审阅） → read（已审阅）
   * 当标记为 'read' 时，同时在 doc_reads 表记录用户已阅
   */
  app.patch('/:id/docs/:docId', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { docId } = req.params as { id: string; docId: string }
    const { status } = req.body as { status: 'writing' | 'unread' | 'read' }

    if (status === 'read') {
      // 在 doc_reads 表记录用户已阅读此文档
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

  // ── GET/POST /api/tasks/:id/skills ───────────────────────────────
  /** 获取任务关联的技能标签列表 */
  app.get('/:id/skills', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const skills = await query('SELECT skill_name FROM task_skills WHERE task_id = $1', [id])
    return { skills: skills.map((r: any) => r.skill_name) }
  })

  /** 为任务添加技能标签（幂等，ON CONFLICT DO NOTHING） */
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
