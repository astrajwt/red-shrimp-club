// Socket.io setup — real-time message delivery
// Events:
//   client→server: join:channel, leave:channel, agent:heartbeat
//   server→client: message:new, task:updated, agent:activity, agent:log,
//                  doc:writing, doc:ready, agent:rate_limited, subagent:action

import type { Server, Socket } from 'socket.io'
// Singleton io reference — set once in index.ts, used by broadcastMessage
let _io: Server | null = null
export function setIo(io: Server) { _io = io }
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
  // Auth middleware — local mode accepts anonymous browser clients.
  io.use(async (socket: AuthSocket, next) => {
    const token    = socket.handshake.auth?.token as string
    const serverId = socket.handshake.auth?.serverId as string
    const localUserId = process.env.REDSHRIMP_LOCAL_USER_ID
    if (!token) {
      socket.userId = localUserId
      socket.serverId = serverId
      return next()
    }

    try {
      socket.userId  = localUserId
      socket.serverId = serverId

      // Check if it's a user or agent
      const agent = await queryOne<{ id: string }>(
        'SELECT id FROM agents WHERE id = $1', [token]
      )
      if (agent) socket.agentId = token

      next()
    } catch {
      socket.userId = localUserId
      next()
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
