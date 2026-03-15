// Daemon Event Bus — 回调通知中心
// 所有状态变化通过此模块统一发出，WebSocket 订阅后推给前端

export type DaemonEventType =
  | 'agent:started'
  | 'agent:stopped'
  | 'agent:crashed'
  | 'agent:offline'
  | 'agent:rate_limited'
  | 'agent:handoff'
  | 'agent:activity'
  | 'agent:log'
  | 'doc:writing'
  | 'doc:ready'
  | 'task:created'
  | 'task:completed'
  | 'task:all_completed'
  | 'task:doc_added'
  | 'task:updated'
  | 'subagent:action'

export interface DaemonEvent {
  type:      DaemonEventType
  agentId:   string
  payload:   Record<string, unknown>
  timestamp: Date
}

type EventListener = (event: DaemonEvent) => void

// Global singleton event bus
class EventBus {
  private listeners = new Map<DaemonEventType | '*', EventListener[]>()

  on(type: DaemonEventType | '*', listener: EventListener): () => void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
    // Return unsubscribe function
    return () => this.off(type, listener)
  }

  off(type: DaemonEventType | '*', listener: EventListener): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter(l => l !== listener))
  }

  emit(event: DaemonEvent): void {
    // Notify type-specific listeners
    const specific = this.listeners.get(event.type) ?? []
    for (const l of specific) l(event)
    // Notify wildcard listeners
    const wildcard = this.listeners.get('*') ?? []
    for (const l of wildcard) l(event)
  }
}

export const eventBus = new EventBus()

// ── Helper emitters ──────────────────────────────────────────────

export function emitAgentStarted(agentId: string, pid: number) {
  eventBus.emit({ type: 'agent:started', agentId, payload: { pid }, timestamp: new Date() })
}

export function emitAgentStopped(agentId: string) {
  eventBus.emit({ type: 'agent:stopped', agentId, payload: {}, timestamp: new Date() })
}

export function emitAgentCrashed(agentId: string, exitCode: number | null, signal: string | null) {
  eventBus.emit({ type: 'agent:crashed', agentId, payload: { exitCode, signal }, timestamp: new Date() })
}

export function emitAgentOffline(agentId: string, name?: string, reason?: string) {
  eventBus.emit({ type: 'agent:offline', agentId, payload: { name, reason }, timestamp: new Date() })
}

export function emitAgentRateLimited(agentId: string, retryAfterMs: number) {
  eventBus.emit({ type: 'agent:rate_limited', agentId, payload: { retryAfterMs }, timestamp: new Date() })
}

export function emitAgentActivity(agentId: string, activity: string, detail?: string) {
  eventBus.emit({ type: 'agent:activity', agentId, payload: { activity, detail }, timestamp: new Date() })
}

export function emitAgentLog(agentId: string, level: string, content: string, runId?: string) {
  eventBus.emit({ type: 'agent:log', agentId, payload: { level, content, runId }, timestamp: new Date() })
}

export function emitDocWriting(agentId: string, docPath: string) {
  eventBus.emit({ type: 'doc:writing', agentId, payload: { docPath }, timestamp: new Date() })
}

export function emitDocReady(agentId: string, docPath: string) {
  eventBus.emit({ type: 'doc:ready', agentId, payload: { docPath }, timestamp: new Date() })
}

export function emitTaskCreated(actorId: string, taskId: string, channelId: string) {
  eventBus.emit({ type: 'task:created', agentId: actorId, payload: { taskId, channelId }, timestamp: new Date() })
}

export function emitTaskCompleted(agentId: string, taskId: string, channelId?: string) {
  eventBus.emit({ type: 'task:completed', agentId, payload: { taskId, channelId }, timestamp: new Date() })
}

export function emitTaskAllCompleted(actorId: string, channelId: string) {
  eventBus.emit({ type: 'task:all_completed', agentId: actorId, payload: { channelId }, timestamp: new Date() })
}

export function emitTaskDocAdded(actorId: string, taskId: string, docPath: string) {
  eventBus.emit({ type: 'task:doc_added', agentId: actorId, payload: { taskId, docPath }, timestamp: new Date() })
}

export function emitTaskUpdated(actorId: string, taskId: string, channelId?: string) {
  eventBus.emit({ type: 'task:updated', agentId: actorId, payload: { taskId, channelId }, timestamp: new Date() })
}

export function emitTokenHandoff(
  agentId: string, fromRunId: string, toRunId: string,
  snapshot: Record<string, unknown>
) {
  eventBus.emit({
    type: 'agent:handoff', agentId,
    payload: { fromRunId, toRunId, snapshot },
    timestamp: new Date()
  })
}

export function emitSubagentAction(
  parentRunId: string, subRunId: string, agentId: string,
  action: string, detail: string
) {
  eventBus.emit({
    type: 'subagent:action', agentId,
    payload: { parentRunId, subRunId, action, detail },
    timestamp: new Date()
  })
}
