/**
 * 红虾俱乐部 (Red Shrimp Lab) — 后端入口文件
 *
 * 文件位置: backend-src/src/index.ts
 * 核心功能:
 *   1. 初始化 Fastify HTTP 服务器，注册所有插件和路由
 *   2. 创建 Socket.io WebSocket 服务，支持实时消息推送
 *   3. 建立 Daemon 事件总线 → Socket.io 的桥接，将后台事件广播给前端
 *   4. 启动调度器 (Scheduler)，管理定时任务和心跳监控
 *
 * 启动顺序: 插件注册 → 路由挂载 → WebSocket 初始化 → HTTP 监听 → 调度器启动
 */

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
import { setupSocketIO }  from './socket/index.js'
import { eventBus }       from './daemon/events.js'
import { scheduler }      from './daemon/scheduler.js'
import { llmClient }      from './daemon/llm-client.js'

/** 服务监听端口，默认 3001 */
const PORT = Number(process.env.PORT ?? 3001)
/** 服务监听地址，默认 0.0.0.0（所有网卡） */
const HOST = process.env.HOST ?? '0.0.0.0'

/**
 * 主启动函数
 * 按顺序完成: Fastify 实例化 → 插件注册 → 路由挂载 → Socket.io → 监听 → 调度器
 */
async function main() {
  // ── Fastify 实例化 ──────────────────────────────────────────────
  const app = Fastify({ logger: { level: 'info' } })

  // 跨域配置：允许前端 dev server 或指定域名访问
  await app.register(import('@fastify/cors'), {
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })

  // JWT 认证插件：生成和验证 access token
  // authenticate 装饰器可作为路由的 preHandler 使用
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

  // ── Socket.io WebSocket 服务 ──────────────────────────────────────
  // 必须在 @fastify/websocket 之前创建，attach 到 httpServer 以支持 polling 传输
  const httpServer = app.server
  const io = new SocketServer(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? '*' },
  })
  setupSocketIO(io)

  // WebSocket 支持（用于 /daemon/connect 等 Fastify 原生 WebSocket 路由）
  // 注意: @fastify/websocket 会接管所有 upgrade 事件并销毁不匹配路径的连接
  // 因此需要在注册后手动修复 upgrade 路由，将 /socket.io 路径交回 Socket.io 处理
  await app.register(import('@fastify/websocket'))

  // 修复 WebSocket upgrade 路由冲突:
  // @fastify/websocket 会拦截所有 upgrade 请求，对非 Fastify 路由的路径直接 destroy
  // 这里将 /socket.io 路径的 upgrade 交给 Socket.io engine 处理
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

  // 文件上传插件：支持 multipart/form-data，最大 50MB
  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: 50 * 1024 * 1024 },  // 50MB max
  })

  // 静态文件服务：将上传目录映射到 /uploads/ 路径
  await app.register(import('@fastify/static'), {
    root: process.env.UPLOADS_DIR ?? '/var/redshrimp/uploads',
    prefix: '/uploads/',
  })

  // ── API 路由注册 ─────────────────────────────────────────────────
  // 各模块路由分别挂载到对应的 URL 前缀下
  await app.register(authRoutes,    { prefix: '/api/auth'     })  // 认证（登录/注册/刷新令牌）
  await app.register(channelRoutes, { prefix: '/api/channels' })  // 频道管理
  await app.register(messageRoutes, { prefix: '/api/messages' })  // 消息收发
  await app.register(agentRoutes,   { prefix: '/api/agents'   })  // AI Agent 管理
  await app.register(taskRoutes,    { prefix: '/api/tasks'    })  // 任务看板
  await app.register(fileRoutes,    { prefix: '/api/files'    })  // 文件上传
  await app.register(daemonRoutes,  { prefix: '/api/daemon'   })  // Daemon 内部 API

  // 健康检查端点，供监控和负载均衡探针使用
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }))

  // 可用 LLM 模型列表，前端设置页面使用
  app.get('/api/models', { preHandler: [app.authenticate] }, async () => {
    return llmClient.availableModels()
  })

  // 事件桥接：将 Daemon 事件总线的所有事件广播到 Socket.io
  // 前端通过 WebSocket 订阅这些事件实现实时 UI 更新
  eventBus.on('*', (event) => {
    io.emit(event.type, {
      agentId:   event.agentId,
      timestamp: event.timestamp.toISOString(),
      ...event.payload,
    })
  })

  // ── 启动服务 ────────────────────────────────────────────────────
  await app.listen({ port: PORT, host: HOST })
  console.log(`[red-shrimp] Backend running at http://${HOST}:${PORT}`)

  // 调度器必须在 HTTP 服务就绪后启动，确保 API 可用
  await scheduler.start()
}

// 顶层启动，异常时打印错误并退出
main().catch((err) => {
  console.error(err)
  process.exit(1)
})
