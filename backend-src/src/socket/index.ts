// Socket.io setup — real-time message delivery
// Events:
//   client→server: join:channel, leave:channel, agent:heartbeat
//   server→client: message:new, task:updated, agent:activity, agent:log,
//                  doc:writing, doc:ready, agent:rate_limited, subagent:action

import type { Server, Socket } from 'socket.io'
import { createHmac } from 'crypto'

// Singleton io reference — set once in index.ts, used by broadcastMessage
let _io: Server | null = null
export function setIo(io: Server) { _io = io }

// Minimal JWT verify — HS256 only, matches @fastify/jwt token format
function verifyJwt(token: string, secret: string): { sub: string } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT')
  const [header, payload, sig] = parts
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  if (expected !== sig) throw new Error('Invalid signature')
  return JSON.parse(Buffer.from(payload, 'base64url').toString())
}
import { query, queryOne } from '../db/client.js'
import { processManager } from '../daemon/process-manager.js'

interface AuthSocket extends Socket {
  userId?:  string
  agentId?: string
  serverId?: string
}

function getChannelId(payload: string | { channelId?: string }): string | null {
  if (typeof payload === 'string') return payload
  if (payload && typeof payload.channelId === 'string') return payload.channelId
  return null
}

export function setupSocketIO(io: Server): void {
  // Auth middleware — validate token on connection
  io.use(async (socket: AuthSocket, next) => {
    const token    = socket.handshake.auth?.token as string
    const serverId = socket.handshake.auth?.serverId as string

    if (!token) return next(new Error('No token'))

    try {
      const payload = verifyJwt(token, process.env.JWT_SECRET!)
      socket.userId  = payload.sub
      socket.serverId = serverId

      // Check if it's a user or agent
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
    // Join channel rooms
    socket.on('join:channel', (payload: string | { channelId?: string }) => {
      const channelId = getChannelId(payload)
      if (!channelId) return
      socket.join(`channel:${channelId}`)
    })

    socket.on('leave:channel', (payload: string | { channelId?: string }) => {
      const channelId = getChannelId(payload)
      if (!channelId) return
      socket.leave(`channel:${channelId}`)
    })

    // Agent heartbeat — update both in-memory and DB
    socket.on('agent:heartbeat', ({ agentId }: { agentId: string }) => {
      if (socket.agentId === agentId) {
        processManager.updateHeartbeat(agentId)
        query(
          `UPDATE agents SET last_heartbeat_at = NOW(), status = 'online' WHERE id = $1`,
          [agentId]
        ).catch(() => {})
      }
    })

    socket.on('disconnect', () => {
      // Could track online status here
    })
  })

  // Bridge: forward daemon log events to relevant sockets
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

// Helper: broadcast a new message to a channel room (uses singleton io)
export function broadcastMessage(channelId: string, message: unknown): void {
  _io?.to(`channel:${channelId}`).emit('message', { channelId, message })
}
