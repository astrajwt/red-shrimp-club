/**
 * 消息路由 — /api/messages
 *
 * 文件位置: backend-src/src/routes/messages.ts
 * 核心功能:
 *   GET  /channel/:channelId  — 获取频道消息历史（分页）
 *   POST /                    — 发送新消息
 *   GET  /sync/:channelId     — 消息同步（Agent 追赶遗漏消息）
 *
 * 消息序号机制:
 *   每个频道维护一个递增序号 (channel_sequences.last_seq)
 *   消息通过 seq 字段排序，前端用 seq 做分页游标
 *   实时消息通过 Socket.io 推送，此 API 负责历史消息查询
 *
 * 发送者身份:
 *   使用 sender_id + sender_type (human/agent) 模式
 *   自动查询 users/agents 表确定发送者类型和名称
 */

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'

export const messageRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/messages/channel/:channelId ─────────────────────────
  /**
   * 获取频道消息历史（支持向前分页）
   * @param limit  每页条数，默认 50，最大 100
   * @param before 游标：返回 seq < before 的消息（向历史方向翻页）
   *
   * 查询策略: ORDER BY seq DESC + LIMIT 获取最新 N 条，然后 reverse 返回时间正序
   */
  app.get('/channel/:channelId', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { channelId } = req.params as { channelId: string }
    const { limit = '50', before } = req.query as { limit?: string; before?: string }

    const lim = Math.min(Number(limit), 100)  // 限制最大 100 条

    let sql: string
    let params: unknown[]

    if (before) {
      // 向历史方向翻页：获取 seq < before 的消息
      sql = `
        SELECT id, channel_id, sender_id, sender_type, sender_name, content, seq,
               created_at
        FROM messages
        WHERE channel_id = $1 AND seq < $2
        ORDER BY seq DESC
        LIMIT $3
      `
      params = [channelId, Number(before), lim]
    } else {
      // 默认：获取最新消息
      sql = `
        SELECT id, channel_id, sender_id, sender_type, sender_name, content, seq,
               created_at
        FROM messages
        WHERE channel_id = $1
        ORDER BY seq DESC
        LIMIT $2
      `
      params = [channelId, lim]
    }

    const msgs = await query(sql, params)
    // 反转为时间正序（最旧在前）返回给前端
    return msgs.reverse()
  })

  // ── POST /api/messages ───────────────────────────────────────────
  /**
   * 发送新消息
   * 流程:
   *   1. 识别发送者身份（查 users 表 → 不在则查 agents 表）
   *   2. 原子递增频道消息序号 (ON CONFLICT DO UPDATE)
   *   3. 插入消息记录
   *
   * 注意: 实时推送由 Socket.io 层单独处理，此 API 仅负责持久化
   */
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string; type?: string; name?: string }
    const { channelId, content } = req.body as { channelId: string; content: string }

    if (!content?.trim()) return reply.code(400).send({ error: 'content required' })

    // 识别发送者身份：先查用户表，未找到则查 Agent 表
    let senderType = 'human'
    let senderName = ''
    let senderId   = caller.sub

    const user = await queryOne<{ name: string }>(
      'SELECT name FROM users WHERE id = $1', [caller.sub]
    )
    if (user) {
      senderName = user.name
    } else {
      // 可能是 Agent 通过机器 API Key 调用
      const agent = await queryOne<{ name: string }>(
        'SELECT name FROM agents WHERE id = $1', [caller.sub]
      )
      if (agent) {
        senderType = 'agent'
        senderName = agent.name
      }
    }

    // 原子递增频道消息序号（首次插入初始值 1，后续 +1）
    const seqRow = await queryOne<{ last_seq: string }>(
      `INSERT INTO channel_sequences (channel_id, last_seq) VALUES ($1, 1)
       ON CONFLICT (channel_id) DO UPDATE SET last_seq = channel_sequences.last_seq + 1
       RETURNING last_seq`,
      [channelId]
    )
    const seq = Number(seqRow?.last_seq ?? 1)

    const [msg] = await query(
      `INSERT INTO messages
         (channel_id, sender_id, sender_type, sender_name, content, seq)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [channelId, senderId, senderType, senderName, content.trim(), seq]
    )

    return msg
  })

  // ── GET /api/messages/sync/:channelId?after= ────────────────────
  /**
   * 消息同步接口
   * 供 Agent 进程启动后追赶遗漏的消息
   * @param after 起始序号，返回 seq > after 的所有消息
   * @returns { messages: Message[] } 按 seq 升序排列
   */
  app.get('/sync/:channelId', { preHandler: [app.authenticate] }, async (req) => {
    const { channelId } = req.params as { channelId: string }
    const { after = '0' } = req.query as { after?: string }

    const msgs = await query(
      `SELECT * FROM messages WHERE channel_id = $1 AND seq > $2 ORDER BY seq`,
      [channelId, Number(after)]
    )
    return { messages: msgs }
  })
}
