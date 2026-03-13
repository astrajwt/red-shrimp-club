/**
 * @file socket.ts — Socket.io 实时通信客户端
 * @description WebSocket 连接管理器，负责：
 *   1. 与后端 Socket.io 服务建立/断开连接（自动重连）
 *   2. 转发 daemon 事件到前端组件（agent 状态、日志、任务、文档等）
 *   3. 管理频道房间的加入/离开（用于接收实时消息）
 *
 * 事件类型与后端 daemon/events.ts 镜像对应，共 13 种事件类型。
 * 使用发布-订阅模式，组件通过 socketClient.on() 注册监听器。
 */

import { io, Socket } from 'socket.io-client'
import { tokenStore } from './api'

/** WebSocket 服务地址，可通过环境变量覆盖 */
const WS_URL = import.meta.env.VITE_WS_URL ?? 'http://localhost:3001'

// ─── 事件类型定义（与后端 daemon/events.ts 对应） ──────────────────────────────

/** Agent 日志事件 — 实时日志流 */
export interface AgentLogEvent {
  agentId:   string
  timestamp: string
  level:     string       // ACTION / FILE / SPAWN / WARN / ERROR / INFO
  content:   string
  runId?:    string
}

/** Agent 状态变更事件 — 启动/停止/崩溃/离线 */
export interface AgentStatusEvent {
  agentId:   string
  timestamp: string
  pid?:      number       // 进程 PID（启动时有值）
  exitCode?: number | null // 退出码（停止/崩溃时有值）
  signal?:   string | null // 终止信号
  reason?:   string
}

/** Agent 交接事件 — token 耗尽时新旧 run 交接 */
export interface AgentHandoffEvent {
  agentId:   string
  timestamp: string
  fromRunId: string       // 旧 run ID
  toRunId:   string       // 新 run ID
}

/** 文档事件 — agent 正在写入或文档就绪 */
export interface DocEvent {
  agentId:   string
  timestamp: string
  docPath:   string       // Obsidian vault 中的文件路径
}

/** 任务事件 — 任务更新或完成 */
export interface TaskEvent {
  agentId:   string
  timestamp: string
  taskId:    string
}

/** 子 agent 事件 — 父 agent 派生子 agent 的操作 */
export interface SubagentEvent {
  agentId:    string
  timestamp:  string
  parentRunId:string
  subRunId:   string
  action:     string
  detail:     string
}

/**
 * 完整的 Socket 事件映射表
 * key = 事件名, value = 事件负载类型
 * 用于 on() 方法的类型安全推导
 */
export type SocketEventMap = {
  'agent:started':      AgentStatusEvent           // Agent 进程启动
  'agent:stopped':      AgentStatusEvent           // Agent 进程停止
  'agent:crashed':      AgentStatusEvent           // Agent 进程崩溃
  'agent:offline':      AgentStatusEvent           // Agent 心跳超时离线
  'agent:rate_limited': AgentStatusEvent & { retryAfterMs: number }  // 触发速率限制
  'agent:handoff':      AgentHandoffEvent          // Token 耗尽交接
  'agent:log':          AgentLogEvent              // 实时日志
  'doc:writing':        DocEvent                   // 文档写入中
  'doc:ready':          DocEvent                   // 文档写入完成
  'task:completed':     TaskEvent                  // 任务完成
  'task:updated':       TaskEvent                  // 任务更新
  'subagent:action':    SubagentEvent              // 子 agent 操作
  'message':            { channelId: string; message: unknown }  // 频道新消息
}

// ─── Socket 连接管理器 ────────────────────────────────────────────────────────

/**
 * SocketManager — WebSocket 连接和事件分发的单例管理器
 *
 * 设计模式：发布-订阅
 * - 内部维护一个 listeners Map（事件名 → 回调函数集合）
 * - Socket.io 收到事件后遍历对应的回调集合逐个执行
 * - on() 返回取消订阅函数，方便在 React useEffect 清理中调用
 */
class SocketManager {
  private socket: Socket | null = null
  /** 事件监听器映射表：事件名 → 回调函数集合 */
  private listeners = new Map<string, Set<(data: unknown) => void>>()

  /**
   * 建立 WebSocket 连接
   * 使用 JWT token 进行握手认证，仅使用 websocket 传输（跳过 polling）
   * 自动重连：2秒起步，最长 30 秒
   */
  connect() {
    if (this.socket?.connected) return

    this.socket = io(WS_URL, {
      auth: { token: tokenStore.getAccess() },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 2_000,
      reconnectionDelayMax: 30_000,
    })

    this.socket.on('connect', () => {
      console.log('[ws] Connected')
    })

    this.socket.on('disconnect', (reason) => {
      console.log('[ws] Disconnected:', reason)
    })

    this.socket.on('connect_error', (err) => {
      console.error('[ws] Connection error:', err.message)
    })

    // 注册所有业务事件的转发：Socket.io 事件 → 内部 listeners
    const events: (keyof SocketEventMap)[] = [
      'agent:started', 'agent:stopped', 'agent:crashed', 'agent:offline',
      'agent:rate_limited', 'agent:handoff', 'agent:log',
      'doc:writing', 'doc:ready', 'task:completed', 'task:updated',
      'subagent:action', 'message',
    ]
    for (const event of events) {
      this.socket.on(event, (data: unknown) => {
        const handlers = this.listeners.get(event)
        if (handlers) for (const h of handlers) h(data)
      })
    }
  }

  /** 断开 WebSocket 连接并清理 socket 实例 */
  disconnect() {
    this.socket?.disconnect()
    this.socket = null
  }

  /** 加入频道房间，开始接收该频道的实时消息 */
  joinChannel(channelId: string) {
    this.socket?.emit('join:channel', { channelId })
  }

  /** 离开频道房间，停止接收该频道的实时消息 */
  leaveChannel(channelId: string) {
    this.socket?.emit('leave:channel', { channelId })
  }

  /**
   * 注册事件监听器（类型安全）
   * @param event - 事件名（如 'agent:log', 'message' 等）
   * @param handler - 回调函数，参数类型根据事件名自动推导
   * @returns 取消订阅函数（在 useEffect cleanup 中调用）
   */
  on<K extends keyof SocketEventMap>(
    event: K,
    handler: (data: SocketEventMap[K]) => void
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    const h = handler as (data: unknown) => void
    this.listeners.get(event)!.add(h)
    return () => this.listeners.get(event)?.delete(h)
  }

  /** 当前是否已连接 */
  get connected() { return this.socket?.connected ?? false }
}

/** 全局单例 Socket 客户端，在 auth store 登录成功后调用 connect() */
export const socketClient = new SocketManager()
