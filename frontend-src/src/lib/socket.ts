// Red Shrimp Lab — WebSocket Client
// Socket.io connection with auto-reconnect and typed event handlers

import { io, Socket } from 'socket.io-client'
import { tokenStore } from './api'

const WS_URL = import.meta.env.VITE_WS_URL ?? ''

// ─── Event types (mirrors daemon/events.ts) ───────────────────────────────────

export interface AgentLogEvent {
  agentId:   string
  timestamp: string
  level:     string
  content:   string
  runId?:    string
}

export interface AgentStatusEvent {
  agentId:   string
  timestamp: string
  pid?:      number
  exitCode?: number | null
  signal?:   string | null
  reason?:   string
}

export interface AgentHandoffEvent {
  agentId:   string
  timestamp: string
  fromRunId: string
  toRunId:   string
}

export interface DocEvent {
  agentId:   string
  timestamp: string
  docPath:   string
}

export interface TaskEvent {
  agentId:   string
  timestamp: string
  taskId:    string
}

export interface SubagentEvent {
  agentId:    string
  timestamp:  string
  parentRunId:string
  subRunId:   string
  action:     string
  detail:     string
}

export type SocketEventMap = {
  'agent:started':      AgentStatusEvent
  'agent:stopped':      AgentStatusEvent
  'agent:crashed':      AgentStatusEvent
  'agent:offline':      AgentStatusEvent
  'agent:rate_limited': AgentStatusEvent & { retryAfterMs: number }
  'agent:handoff':      AgentHandoffEvent
  'agent:log':          AgentLogEvent
  'doc:writing':        DocEvent
  'doc:ready':          DocEvent
  'task:created':       TaskEvent
  'task:completed':     TaskEvent
  'task:all_completed': TaskEvent
  'task:doc_added':     TaskEvent & { docPath: string }
  'task:updated':       TaskEvent
  'subagent:action':    SubagentEvent
  'message':            { channelId: string; message: unknown }
}

// ─── Socket manager ───────────────────────────────────────────────────────────

class SocketManager {
  private socket: Socket | null = null
  private listeners = new Map<string, Set<(data: unknown) => void>>()

  connect() {
    if (this.socket?.connected) return

    this.socket = io(WS_URL, {
      auth: { token: tokenStore.getAccess() },
      transports: ['websocket'],
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

    // Forward all typed events to registered listeners
    const events: (keyof SocketEventMap)[] = [
      'agent:started', 'agent:stopped', 'agent:crashed', 'agent:offline',
      'agent:rate_limited', 'agent:handoff', 'agent:log',
      'doc:writing', 'doc:ready', 'task:created', 'task:completed', 'task:all_completed', 'task:doc_added', 'task:updated',
      'subagent:action', 'message',
    ]
    for (const event of events) {
      this.socket.on(event, (data: unknown) => {
        const handlers = this.listeners.get(event)
        if (handlers) for (const h of handlers) h(data)
      })
    }
  }

  disconnect() {
    this.socket?.disconnect()
    this.socket = null
  }

  // Join a channel room to receive its messages
  joinChannel(channelId: string) {
    this.socket?.emit('join:channel', channelId)
  }

  leaveChannel(channelId: string) {
    this.socket?.emit('leave:channel', channelId)
  }

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

  get connected() { return this.socket?.connected ?? false }
}

export const socketClient = new SocketManager()
