/**
 * Daemon 事件总线 — 统一事件分发中心
 *
 * 文件位置: backend-src/src/daemon/events.ts
 * 核心功能:
 *   1. 定义所有 Daemon 事件类型（Agent 生命周期、文档状态、任务状态等）
 *   2. 实现发布/订阅模式的事件总线，支持按类型订阅和通配符订阅
 *   3. 提供语义化的 emit 辅助函数，简化各模块的事件发送
 *
 * 架构位置:
 *   ProcessManager / Scheduler 等模块通过此总线发出事件
 *   → index.ts 中注册的通配符监听器将事件桥接到 Socket.io
 *   → 前端 WebSocket 客户端接收事件并更新 UI
 */

/** 所有支持的 Daemon 事件类型 */
export type DaemonEventType =
  | 'agent:started'       // Agent 进程已启动
  | 'agent:stopped'       // Agent 进程已停止
  | 'agent:crashed'       // Agent 进程崩溃
  | 'agent:offline'       // Agent 心跳超时，标记离线
  | 'agent:rate_limited'  // Agent 遭遇 LLM 限流
  | 'agent:handoff'       // Token 耗尽交接
  | 'agent:activity'      // Agent 活动状态变更
  | 'agent:log'           // Agent 日志条目
  | 'doc:writing'         // Agent 正在撰写文档
  | 'doc:ready'           // 文档撰写完成，待审阅
  | 'task:completed'      // 任务已完成
  | 'task:updated'        // 任务状态更新
  | 'subagent:action'     // 子 Agent 动作（Agent 树结构中的子节点）

/** 事件数据结构 */
export interface DaemonEvent {
  type:      DaemonEventType          // 事件类型
  agentId:   string                   // 关联的 Agent UUID
  payload:   Record<string, unknown>  // 事件负载数据
  timestamp: Date                     // 事件发生时间
}

/** 事件监听器函数签名 */
type EventListener = (event: DaemonEvent) => void

/**
 * 事件总线类
 * 实现简单的发布/订阅模式，支持:
 *   - 按事件类型订阅 (如 on('agent:started', fn))
 *   - 通配符订阅 (on('*', fn))，接收所有类型的事件
 *   - 返回取消订阅函数
 */
class EventBus {
  /** 事件类型 → 监听器数组的映射表 */
  private listeners = new Map<DaemonEventType | '*', EventListener[]>()

  /**
   * 注册事件监听器
   * @param type     事件类型，'*' 表示监听所有事件
   * @param listener 回调函数
   * @returns        取消订阅函数
   */
  on(type: DaemonEventType | '*', listener: EventListener): () => void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
    return () => this.off(type, listener)
  }

  /** 移除事件监听器 */
  off(type: DaemonEventType | '*', listener: EventListener): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter(l => l !== listener))
  }

  /**
   * 发出事件
   * 先通知类型特定监听器，再通知通配符监听器
   */
  emit(event: DaemonEvent): void {
    const specific = this.listeners.get(event.type) ?? []
    for (const l of specific) l(event)
    const wildcard = this.listeners.get('*') ?? []
    for (const l of wildcard) l(event)
  }
}

/** 全局单例事件总线 */
export const eventBus = new EventBus()

// ── 语义化事件发射辅助函数 ──────────────────────────────────────
// 以下函数封装了各种事件的 payload 构建，供其他模块调用

/** Agent 进程启动成功 */
export function emitAgentStarted(agentId: string, pid: number) {
  eventBus.emit({ type: 'agent:started', agentId, payload: { pid }, timestamp: new Date() })
}

/** Agent 进程正常停止 */
export function emitAgentStopped(agentId: string) {
  eventBus.emit({ type: 'agent:stopped', agentId, payload: {}, timestamp: new Date() })
}

/** Agent 进程崩溃退出，携带退出码和信号 */
export function emitAgentCrashed(agentId: string, exitCode: number | null, signal: string | null) {
  eventBus.emit({ type: 'agent:crashed', agentId, payload: { exitCode, signal }, timestamp: new Date() })
}

/** Agent 心跳超时或其他原因离线 */
export function emitAgentOffline(agentId: string, name?: string, reason?: string) {
  eventBus.emit({ type: 'agent:offline', agentId, payload: { name, reason }, timestamp: new Date() })
}

/** Agent 遭遇 LLM 限流，携带建议等待时间 */
export function emitAgentRateLimited(agentId: string, retryAfterMs: number) {
  eventBus.emit({ type: 'agent:rate_limited', agentId, payload: { retryAfterMs }, timestamp: new Date() })
}

/** Agent 活动状态变更（如 "正在编码"、"正在分析" 等） */
export function emitAgentActivity(agentId: string, activity: string, detail?: string) {
  eventBus.emit({ type: 'agent:activity', agentId, payload: { activity, detail }, timestamp: new Date() })
}

/** Agent 日志条目（同时用于 DB 持久化和前端展示） */
export function emitAgentLog(agentId: string, level: string, content: string, runId?: string) {
  eventBus.emit({ type: 'agent:log', agentId, payload: { level, content, runId }, timestamp: new Date() })
}

/** Agent 开始撰写文档 */
export function emitDocWriting(agentId: string, docPath: string) {
  eventBus.emit({ type: 'doc:writing', agentId, payload: { docPath }, timestamp: new Date() })
}

/** 文档撰写完成 */
export function emitDocReady(agentId: string, docPath: string) {
  eventBus.emit({ type: 'doc:ready', agentId, payload: { docPath }, timestamp: new Date() })
}

/** 任务完成 */
export function emitTaskCompleted(agentId: string, taskId: string) {
  eventBus.emit({ type: 'task:completed', agentId, payload: { taskId }, timestamp: new Date() })
}

/**
 * Token 耗尽交接事件
 * @param agentId         Agent UUID
 * @param fromRunId       旧 run ID
 * @param toRunId         新 run ID
 * @param handoffFilePath Obsidian vault 中的 handoff markdown 文件路径
 */
export function emitTokenHandoff(
  agentId: string, fromRunId: string, toRunId: string,
  handoffFilePath: string
) {
  eventBus.emit({
    type: 'agent:handoff', agentId,
    payload: { fromRunId, toRunId, handoffFilePath },
    timestamp: new Date()
  })
}

/**
 * 子 Agent 动作事件（用于 Agent 树结构的可视化）
 * @param parentRunId 父 run ID
 * @param subRunId    子 run ID
 * @param agentId     Agent UUID
 * @param action      动作类型
 * @param detail      动作详情
 */
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
