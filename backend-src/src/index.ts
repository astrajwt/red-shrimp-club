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
import { ensureLocalUser } from './local-user.js'

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
  const localUser = await ensureLocalUser()
  process.env.REDSHRIMP_LOCAL_USER_ID = localUser.id
  app.decorate('authenticate', async (req: any, reply: any) => {
    req.user = { sub: localUser.id, name: localUser.name, email: localUser.email, type: 'human' }
  })

  // ── Socket.io (attach to httpServer for polling transport) ──
  const httpServer = app.server
  const io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? '*' },
  })
  setupSocketIO(io)
  setIo(io)

  // WebSocket support (for /daemon/connect via @fastify/websocket)
  // NOTE: @fastify/websocket removes existing upgrade listeners (including Socket.io's)
  // and destroys sockets for non-matching paths. We fix this below.
  await app.register(import('@fastify/websocket'))

  // Fix upgrade routing: @fastify/websocket steals all upgrades and destroys
  // non-matching ones. Re-route /socket.io paths to Socket.io's engine.
  {
    const fastifyWsHandlers = httpServer.listeners('upgrade').slice()
    httpServer.removeAllListeners('upgrade')
    httpServer.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith('/socket.io')) {
        io.engine.handleUpgrade(req as any, socket, head)
      } else {
        for (const fn of fastifyWsHandlers) {
          (fn as Function).call(httpServer, req, socket, head)
        }
      }
    })
  }

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
