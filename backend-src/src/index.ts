// Red Shrimp Lab — Backend Entry Point
// Fastify HTTP + Socket.io WebSocket

import 'dotenv/config'
import Fastify from 'fastify'
import { Server as SocketServer } from 'socket.io'
import { authRoutes }     from './routes/auth.js'
import { channelRoutes }  from './routes/channels.js'
import { messageRoutes }  from './routes/messages.js'
import { agentRoutes }    from './routes/agents.js'
import { taskRoutes }     from './routes/tasks.js'
import { fileRoutes }     from './routes/files.js'
import { daemonRoutes }   from './routes/daemon.js'
import { machineRoutes }  from './routes/machines.js'
import { askRoutes }      from './routes/ask.js'
import { setupRoutes }    from './routes/setup.js'
import { internalRoutes } from './routes/internal.js'
import { daemonSocketRoutes } from './routes/daemonSocket.js'
import { setupSocketIO, setIo }  from './socket/index.js'
import { eventBus }       from './daemon/events.js'
import { scheduler }      from './daemon/scheduler.js'
import { llmClient }      from './daemon/llm-client.js'

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '0.0.0.0'

async function main() {
  // ── Fastify ──────────────────────────────────────────────────────
  const app = Fastify({ logger: { level: 'info' } })

  // CORS
  await app.register(import('@fastify/cors'), {
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })

  // JWT auth plugin + authenticate decorator
  await app.register(import('@fastify/jwt'), {
    secret: process.env.JWT_SECRET!,
  })
  app.decorate('authenticate', async (req: any, reply: any) => {
    try {
      await req.jwtVerify()
    } catch {
      reply.code(401).send({ error: 'Unauthorized' })
    }
  })

  // WebSocket support (for /daemon/connect)
  await app.register(import('@fastify/websocket'))

  // Multipart for file uploads
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 50 * 1024 * 1024 },  // 50MB max
  })

  // Static files (uploads served from /files/)
  await app.register(import('@fastify/static'), {
    root: process.env.UPLOADS_DIR ?? '/var/redshrimp/uploads',
    prefix: '/uploads/',
  })

  // ── API Routes ───────────────────────────────────────────────────
  await app.register(authRoutes,    { prefix: '/api/auth'     })
  await app.register(channelRoutes, { prefix: '/api/channels' })
  await app.register(messageRoutes, { prefix: '/api/messages' })
  await app.register(agentRoutes,   { prefix: '/api/agents'   })
  await app.register(taskRoutes,    { prefix: '/api/tasks'    })
  await app.register(fileRoutes,    { prefix: '/api/files'    })
  await app.register(daemonRoutes,  { prefix: '/api/daemon'   })
  await app.register(machineRoutes, { prefix: '/api/machines' })
  await app.register(askRoutes,     { prefix: '/api/ask'      })
  await app.register(setupRoutes,   { prefix: '/api/setup'    })
  await app.register(internalRoutes, { prefix: '/internal/agent' })
  await app.register(daemonSocketRoutes)  // WebSocket: /daemon/connect

  // Health check
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }))

  // Available LLM models (used by Settings page)
  app.get('/api/models', { preHandler: [app.authenticate] }, async () => {
    return llmClient.availableModels()
  })

  // ── Socket.io ────────────────────────────────────────────────────
  const httpServer = app.server
  const io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? '*' },
  })
  setupSocketIO(io)
  setIo(io)  // make io available to broadcastMessage()

  // Bridge: Daemon events → Socket.io broadcast
  eventBus.on('*', (event) => {
    io.emit(event.type, {
      agentId:   event.agentId,
      timestamp: event.timestamp.toISOString(),
      ...event.payload,
    })
  })

  // ── Start ────────────────────────────────────────────────────────
  await app.listen({ port: PORT, host: HOST })
  console.log(`[red-shrimp] Backend running at http://${HOST}:${PORT}`)

  // Start scheduler AFTER server is up
  await scheduler.start()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
