/**
 * 频道路由 — /api/channels
 *
 * 文件位置: backend-src/src/routes/channels.ts
 * 核心功能:
 *   GET  /           — 列出当前用户所在 server 的公开频道
 *   POST /           — 创建新频道
 *   GET  /dm         — 列出当前用户的私信频道
 *   POST /dm         — 开启私信（与用户或 Agent）
 *   GET  /unread     — 获取各频道未读消息数
 *   POST /:id/join   — 加入频道
 *   POST /:id/read   — 标记已读到指定 seq
 *
 * 频道类型:
 *   - 'channel': 公开频道，所有 server 成员可见
 *   - 'dm': 私信频道，仅参与者可见
 *
 * 未读计算: last_seq (频道最新消息序号) - last_read_seq (用户已读序号)
 */

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'

export const channelRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/channels ─────────────────────────────────────────────
  /**
   * 列出当前用户可见的公开频道
   * 通过 server_members JOIN 确保用户只能看到自己所属 server 的频道
   * 返回结果中 joined 字段标识用户是否已加入该频道
   * 排序: #all 频道始终排在最前
   */
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { serverId } = req.query as { serverId?: string }

    const rows = await query(
      `SELECT c.id, c.name, c.description, c.type,
              (cm.user_id IS NOT NULL OR cm.agent_id IS NOT NULL) AS joined
       FROM channels c
       JOIN servers s ON s.id = c.server_id
       JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
       LEFT JOIN channel_members cm
         ON cm.channel_id = c.id AND (cm.user_id = $1)
       WHERE c.type = 'channel'
         AND ($2::uuid IS NULL OR c.server_id = $2::uuid)
       ORDER BY CASE WHEN c.name = 'all' THEN 0 ELSE 1 END, c.name`,
      [caller.sub, serverId ?? null]
    )
    return rows
  })

  // ── POST /api/channels ───────────────────────────────────────────
  /**
   * 创建新的公开频道
   * 权限: 仅 server 成员可以创建
   * 频道名自动转为小写并用 '-' 替换空格
   */
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { serverId, name, description } = req.body as {
      serverId: string; name: string; description?: string
    }

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
  /**
   * 列出当前用户的所有私信频道
   * 通过双 JOIN channel_members 找到 DM 中的另一个参与者
   * display_name 为对方的名称（用户名或 Agent 名）
   */
  app.get('/dm', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const dms = await query(
      `SELECT c.id, c.name, c.type,
              -- 获取对方的名称作为 DM 频道显示名
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
  /**
   * 开启私信频道（与用户或 Agent）
   * 幂等设计: 如果与目标的 DM 已存在，直接返回现有频道
   * 支持两种目标: agentId（与 Agent 私信）或 userId（与用户私信）
   *
   * 流程:
   *   1. 查询是否已有 DM 频道 → 有则直接返回
   *   2. 创建 type='dm' 的频道
   *   3. 将双方加入 channel_members
   */
  app.post('/dm', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { agentId, userId } = req.body as { agentId?: string; userId?: string }

    const targetId   = agentId ?? userId
    const targetType = agentId ? 'agent' : 'user'
    if (!targetId) throw new Error('agentId or userId required')

    // 检查是否已存在与目标的 DM 频道
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

    // 创建新的 DM 频道（server_id 从调用者的 server_members 中获取）
    const name = `dm-${Date.now()}`
    const [channel] = await query(
      `INSERT INTO channels (server_id, name, type)
       SELECT sm.server_id, $1, 'dm' FROM server_members sm WHERE sm.user_id = $2 LIMIT 1
       RETURNING *`,
      [name, caller.sub]
    )

    // 将双方添加为频道成员
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
  /**
   * 获取各频道的未读消息数
   * 计算方式: channel_sequences.last_seq - channel_reads.last_read_seq
   * 返回格式: { channelId: unreadCount } 的 Map
   */
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
    return Object.fromEntries(rows.map(r => [r.channel_id, Number(r.unread)]))
  })

  // ── POST /api/channels/:id/join ───────────────────────────────────
  /**
   * 加入频道
   * ON CONFLICT DO NOTHING 保证幂等（重复加入不报错）
   */
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

  // ── POST /api/channels/:id/read ───────────────────────────────────
  /**
   * 标记频道已读到指定消息序号
   * 使用 GREATEST 确保 last_read_seq 只增不减（防止并发导致倒退）
   * @param seq 已读到的消息序号
   */
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
