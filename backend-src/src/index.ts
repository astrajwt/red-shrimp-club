// Red Shrimp Lab — Backend Entry Point
// Fastify HTTP + Socket.io WebSocket

import 'dotenv/config'
import os from 'os'
import { resolve, join } from 'path'

// Expand ~ in path-like env vars (dotenv doesn't do shell expansion)
for (const key of ['OBSIDIAN_ROOT', 'AGENTS_WORKSPACE_DIR', 'UPLOADS_DIR']) {
  const v = process.env[key]
  if (v?.startsWith('~/')) process.env[key] = join(os.homedir(), v.slice(2))
}
import { existsSync } from 'fs'
import Fastify from 'fastify'
import { Server as SocketServer } from 'socket.io'
import { authRoutes }     from './routes/auth.js'
import { channelRoutes }  from './routes/channels.js'
import { messageRoutes }  from './routes/messages.js'
import { agentRoutes }    from './routes/agents.js'
import { taskRoutes }     from './routes/tasks.js'
import { searchRoutes }   from './routes/search.js'
import { fileRoutes }     from './routes/files.js'
import { daemonRoutes }   from './routes/daemon.js'
import { machineRoutes }  from './routes/machines.js'
import { projectRoutes }  from './routes/projects.js'
import { askRoutes }      from './routes/ask.js'
import { skillRoutes }    from './routes/skills.js'
import { feishuRoutes }   from './routes/feishu.js'
import { setupRoutes }    from './routes/setup.js'
import { bulletinRoutes } from './routes/bulletins.js'
import { internalRoutes } from './routes/internal.js'
import { pushRoutes }     from './routes/push.js'
import { daemonSocketRoutes } from './routes/daemonSocket.js'
import { setupSocketIO, setIo }  from './socket/index.js'
import { eventBus }       from './daemon/events.js'
import { scheduler }      from './daemon/scheduler.js'
import { llmClient }      from './daemon/llm-client.js'
import { ensureLocalUser } from './local-user.js'
import { query } from './db/client.js'
import { listSharedSkills } from './services/shared-skills.js'
import { notifyTaskUpdate, notifyAgentCrash } from './services/push-notifications.js'

const PORT = Number(process.env.PORT ?? 3001)
const HOST = process.env.HOST ?? '0.0.0.0'
const LOCAL_AUTH_BYPASS = process.env.LOCAL_AUTH_BYPASS === 'true'

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
  const localUser = LOCAL_AUTH_BYPASS ? await ensureLocalUser() : null
  if (localUser) process.env.REDSHRIMP_LOCAL_USER_ID = localUser.id
  else delete process.env.REDSHRIMP_LOCAL_USER_ID
  app.decorate('authenticate', async (req: any, reply: any) => {
    if (LOCAL_AUTH_BYPASS && localUser) {
      req.user = { sub: localUser.id, name: localUser.name, email: localUser.email, type: 'human' }
      return
    }
    try {
      await req.jwtVerify()
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
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
  await app.register(searchRoutes,  { prefix: '/api/search'   })
  await app.register(agentRoutes,   { prefix: '/api/agents'   })
  await app.register(taskRoutes,    { prefix: '/api/tasks'    })
  await app.register(fileRoutes,    { prefix: '/api/files'    })
  await app.register(daemonRoutes,  { prefix: '/api/daemon'   })
  await app.register(machineRoutes, { prefix: '/api/machines' })
  await app.register(projectRoutes, { prefix: '/api/projects' })
  await app.register(askRoutes,     { prefix: '/api/ask'      })
  await app.register(skillRoutes,   { prefix: '/api/skills'   })
  await app.register(feishuRoutes,  { prefix: '/api/feishu'   })
  await app.register(setupRoutes,   { prefix: '/api/setup'    })
  await app.register(bulletinRoutes, { prefix: '/api/bulletins' })
  await app.register(pushRoutes,     { prefix: '/api/push'      })
  await app.register(internalRoutes, { prefix: '/internal/agent' })
  await app.register(daemonSocketRoutes)  // WebSocket: /daemon/connect

  // ── Serve frontend SPA from ../frontend-src/dist ─────────────────
  const frontendDir = resolve(import.meta.dirname ?? __dirname, '../../frontend-src/dist')
  if (existsSync(frontendDir)) {
    await app.register(import('@fastify/static'), {
      root: frontendDir,
      prefix: '/',
      decorateReply: false,
    })
    // SPA catch-all: serve index.html for non-API, non-file routes
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/internal/') || req.url.startsWith('/uploads/') || req.url.startsWith('/socket.io') || req.url.startsWith('/daemon/')) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return reply.sendFile('index.html', frontendDir)
    })
  }

  // Health check
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }))

  // Available LLM models (used by Settings page)
  app.get('/api/models', { preHandler: [app.authenticate] }, async () => {
    return llmClient.availableModels()
  })

  // Bridge: Daemon events → Socket.io broadcast + DB persistence
  // Note: agent:log socket broadcast is handled by logEmitter in socket/index.ts
  // to avoid duplicate pushes. We only persist to DB here.
  eventBus.on('*', (event) => {
    // Skip agent:log socket broadcast — already handled by logEmitter in socket/index.ts
    if (event.type !== 'agent:log') {
      io.emit(event.type, {
        agentId:   event.agentId,
        timestamp: event.timestamp.toISOString(),
        ...event.payload,
      })
    }

    // Push notifications for key events
    if (event.type === 'task:completed' || event.type === 'task:updated') {
      const p = event.payload as { taskId?: string; channelId?: string; title?: string; status?: string }
      if (p.taskId && p.channelId) {
        notifyTaskUpdate({
          taskId: p.taskId,
          channelId: p.channelId,
          title: p.title ?? '任务状态变更',
          status: event.type === 'task:completed' ? 'completed' : (p.status ?? 'in_progress'),
          agentId: event.agentId,
        }).catch(() => {})
      }
    }
    if (event.type === 'agent:crashed') {
      notifyAgentCrash({
        agentId: event.agentId,
        agentName: (event.payload as any)?.agentName ?? event.agentId,
      }).catch(() => {})
    }

    // Persist agent:log events to database
    if (event.type === 'agent:log') {
      const { level, content, runId } = event.payload as { level: string; content: string; runId?: string }
      query(
        `INSERT INTO agent_logs (agent_id, run_id, level, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [event.agentId, runId ?? null, level, content, event.timestamp]
      ).catch((err: any) => {
        console.error(`[log-persist] Failed to write log for ${event.agentId}:`, err.message)
      })
    }
  })

  try {
    await listSharedSkills()
  } catch (err: any) {
    app.log.warn(`shared skills init failed: ${err.message}`)
  }

  // ── Start ────────────────────────────────────────────────────────
  await app.listen({ port: PORT, host: HOST })
  console.log(`[red-shrimp] Backend running at http://${HOST}:${PORT}`)

  // Start scheduler AFTER server is up
  await scheduler.start()

  // ── Rolling cleanup — keep DB lean ─────────────────────────────
  const rollingCleanup = async () => {
    const rules: Array<{ table: string; col: string; interval: string }> = [
      { table: 'agent_logs',  col: 'created_at',  interval: '7 days' },
      { table: 'agent_runs',  col: 'started_at',  interval: '30 days' },
    ]
    for (const { table, col, interval } of rules) {
      try {
        const result = await query(`DELETE FROM ${table} WHERE ${col} < NOW() - INTERVAL '${interval}'`)
        const count = (result as any[])?.length ?? 0
        if (count > 0) console.log(`[cleanup] Deleted ${count} rows from ${table} older than ${interval}`)
      } catch (err: any) {
        console.error(`[cleanup] ${table} cleanup failed: ${err.message}`)
      }
    }
  }
  // Run on startup and every 6 hours
  rollingCleanup()
  setInterval(rollingCleanup, 6 * 60 * 60 * 1000)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
