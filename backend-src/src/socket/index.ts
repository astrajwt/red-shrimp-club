/**
 * Socket.io WebSocket 配置与事件处理
 *
 * 文件位置: backend-src/src/socket/index.ts
 * 核心功能:
 *   1. WebSocket 连接认证: 使用 JWT (HS256) 验证连接身份
 *   2. 频道房间管理: 客户端加入/离开频道房间，实现消息隔离
 *   3. Agent 心跳转发: 将 Agent 的心跳 ping 转发给 ProcessManager
 *   4. Daemon 日志桥接: 将 ProcessManager 的日志事件广播给所有客户端
 *
 * 事件协议:
 *   客户端 → 服务端: join:channel, leave:channel, agent:heartbeat
 *   服务端 → 客户端: message:new, task:updated, agent:activity, agent:log,
 *                    doc:writing, doc:ready, agent:rate_limited, subagent:action
 */

import type { Server, Socket } from 'socket.io'
import { createHmac } from 'crypto'

/**
 * 轻量 JWT 验证（仅支持 HS256）
 * 与 @fastify/jwt 生成的 token 格式兼容
 * 不依赖完整的 JWT 库，减少 Socket.io 中间件的开销
 *
 * @param token  JWT 字符串 (header.payload.signature)
 * @param secret JWT 密钥
 * @returns 解析后的 payload，包含 sub (用户/Agent ID)
 * @throws 签名不匹配时抛出错误
 */
function verifyJwt(token: string, secret: string): { sub: string } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT')
  const [header, payload, sig] = parts
  // 用相同密钥重新计算签名并比对
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  if (expected !== sig) throw new Error('Invalid signature')
  return JSON.parse(Buffer.from(payload, 'base64url').toString())
}
import { queryOne } from '../db/client.js'
import { processManager } from '../daemon/process-manager.js'

/** 扩展 Socket 类型，附加认证信息 */
interface AuthSocket extends Socket {
  userId?:  string   // 用户 UUID（人类或 Agent）
  agentId?: string   // 如果连接者是 Agent，记录其 UUID
  serverId?: string  // 客户端传入的 server UUID
}

/**
 * 初始化 Socket.io 服务
 * @param io Socket.io Server 实例
 *
 * 设置内容:
 *   1. 连接认证中间件 (JWT 验证 + 身份识别)
 *   2. 频道房间事件处理
 *   3. Agent 心跳处理
 *   4. Daemon 日志 → WebSocket 桥接
 */
export function setupSocketIO(io: Server): void {
  // 认证中间件：每个 WebSocket 连接建立时验证 JWT
  io.use(async (socket: AuthSocket, next) => {
    const token    = socket.handshake.auth?.token as string
    const serverId = socket.handshake.auth?.serverId as string

    if (!token) return next(new Error('No token'))

    try {
      const payload = verifyJwt(token, process.env.JWT_SECRET!)
      socket.userId  = payload.sub
      socket.serverId = serverId

      // 查询数据库判断连接者是普通用户还是 Agent
      const agent = await queryOne<{ id: string }>(
        'SELECT id FROM agents WHERE id = $1', [payload.sub]
      )
      if (agent) socket.agentId = payload.sub

      next()
    } catch {
      next(new Error('Invalid token'))
    }
  })

  io.on('connection', (socket: AuthSocket) => {
    // 加入频道房间：客户端进入某个频道时调用，后续该频道的消息只推送给房间内的 socket
    socket.on('join:channel', (channelId: string) => {
      socket.join(`channel:${channelId}`)
    })

    // 离开频道房间
    socket.on('leave:channel', (channelId: string) => {
      socket.leave(`channel:${channelId}`)
    })

    // Agent 心跳：Agent 进程通过 WebSocket 发送心跳，转发给 ProcessManager 更新时间戳
    // 安全校验: 只有 socket 对应的 agentId 才能更新自己的心跳
    socket.on('agent:heartbeat', ({ agentId }: { agentId: string }) => {
      if (socket.agentId === agentId) {
        processManager.updateHeartbeat(agentId)
      }
    })

    socket.on('disconnect', () => {
      // 预留：可在此追踪在线状态
    })
  })

  // 日志桥接：将 ProcessManager 收集的 Agent 日志广播给所有连接的客户端
  processManager.logEmitter.on((entry) => {
    io.emit('agent:log', {
      agentId:   entry.agentId,
      agentName: entry.agentName,
      level:     entry.level,
      content:   entry.content,
      runId:     entry.runId,
      timestamp: entry.timestamp.toISOString(),
    })
  })
}

/**
 * 向指定频道房间广播新消息
 * 由消息路由在新消息入库后调用
 * @param io        Socket.io Server 实例
 * @param channelId 频道 UUID
 * @param message   消息对象
 */
export function broadcastMessage(io: Server, channelId: string, message: unknown): void {
  io.to(`channel:${channelId}`).emit('message:new', message)
}
