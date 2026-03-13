/**
 * Daemon 进程管理器 — AI Agent 子进程的生命周期管理
 *
 * 文件位置: backend-src/src/daemon/process-manager.ts
 * 核心功能:
 *   1. spawn: 将 Agent 作为子进程启动 (child_process.spawn)
 *   2. stop: 优雅停止 Agent (SIGTERM → 5s 超时 → SIGKILL)
 *   3. scheduleHandoff: Token 耗尽时执行上下文交接（停旧启新）
 *   4. 自动重启: 进程崩溃后指数退避重启 (3s→6s→12s→...→60s)，每小时最多 3 次
 *   5. 心跳监控: 每 60s 检查一次，超过 90s 无心跳则标记离线并尝试重启
 *
 * 设计模式: 类似 systemd 的进程守护，为每个 Agent 维护状态和重启策略
 * 日志输出: Agent 的 stdout/stderr 经过解析后同时写入 Obsidian 文件、WebSocket 和事件总线
 */

import { spawn, ChildProcess } from 'child_process'
import { parseLogLine, ObsidianLogWriter, LogEventEmitter, LogEntry } from './logger.js'
import {
  emitAgentStarted, emitAgentStopped, emitAgentCrashed,
  emitAgentOffline, emitAgentLog,
} from './events.js'

/**
 * Agent 启动配置
 * 包含启动子进程所需的全部信息
 */
export interface AgentConfig {
  id:              string   // Agent UUID
  name:            string   // Agent 显示名称
  machineId:       string   // 部署机器标识（当前为单机）
  serverUrl:       string   // 后端 WebSocket URL，Agent 连回服务器用
  apiKey:          string   // Agent 会话临时 API Key
  workspacePath:   string   // Agent 工作目录（cwd）
  runtime:         string   // 运行时类型: 'claude' | 'custom'
  modelId:         string   // 使用的 LLM 模型 ID
  handoffFilePath?:string   // 上一个 run 的 handoff markdown 文件路径（用于恢复上下文）
}

/**
 * Agent 进程运行时状态
 * 每个运行中的 Agent 在内存中维护一个此对象
 */
interface AgentProcess {
  config:          AgentConfig       // 启动配置
  child:           ChildProcess | null  // Node.js 子进程句柄
  pid:             number | null     // 操作系统进程 ID
  lastHeartbeatAt: Date | null       // 最后一次心跳时间
  restartCount:    number            // 当前窗口内的重启次数
  restartWindowStart: Date           // 重启计数窗口起始时间
}

/** 每小时最大自动重启次数，防止无限重启循环 */
const MAX_RESTARTS_PER_HOUR = 3
/** 心跳超时阈值（90 秒无心跳则判定离线） */
const HEARTBEAT_TIMEOUT_MS  = 90_000
/** 心跳检查间隔（每 60 秒扫描一次） */
const HEARTBEAT_CHECK_INTERVAL = 60_000

/**
 * 进程管理器类
 * 职责: 管理所有 Agent 子进程的启停、日志收集、心跳监控、崩溃恢复
 * 全局单例，由 processManager 导出
 */
export class ProcessManager {
  /** agentId → AgentProcess 映射表 */
  private agents = new Map<string, AgentProcess>()
  /** Obsidian vault 日志文件写入器 */
  private obsidian = new ObsidianLogWriter()
  /** 日志事件发射器，供 Socket.io 订阅后推送给前端 */
  public  logEmitter = new LogEventEmitter()
  /** 心跳检查定时器句柄 */
  private heartbeatTimer: NodeJS.Timer | null = null

  constructor() {
    // 构造时即启动心跳监控循环
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_CHECK_INTERVAL)
  }

  // ── 启动 Agent 子进程 ──────────────────────────────────────────
  /**
   * 根据配置 spawn 一个新的 Agent 子进程
   * @param config Agent 启动配置
   * @throws 如果该 Agent 已在运行则抛出错误
   *
   * 流程:
   *   1. 根据 runtime 类型构建命令行参数
   *   2. spawn 子进程，将 stdout/stderr pipe 出来
   *   3. 注册日志解析回调（三路输出: Obsidian + WebSocket + 事件总线）
   *   4. 注册 exit 回调（正常退出通知停止，异常退出触发自动重启）
   */
  async spawn(config: AgentConfig): Promise<void> {
    if (this.agents.get(config.id)?.child) {
      throw new Error(`Agent ${config.name} is already running`)
    }

    const cmd  = this.buildCommand(config)
    const env  = this.buildEnv(config)
    const child = spawn(cmd[0], cmd.slice(1), {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],  // 不接收 stdin，pipe stdout 和 stderr
      cwd: config.workspacePath,
    })

    const proc: AgentProcess = {
      config,
      child,
      pid: child.pid ?? null,
      lastHeartbeatAt: new Date(),
      restartCount: 0,
      restartWindowStart: new Date(),
    }
    this.agents.set(config.id, proc)

    // 日志处理回调：解析 Agent 输出的每一行，分发到三路输出
    const onData = (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        const parsed = parseLogLine(line)
        const entry: LogEntry = {
          agentId:   config.id,
          agentName: config.name,
          level:     parsed?.level ?? 'INFO',
          content:   parsed?.content ?? line,
          timestamp: parsed?.ts ?? new Date(),
        }
        // 三路输出:
        this.obsidian.write(entry)                              // 1. Obsidian markdown 文件
        this.logEmitter.emit(entry)                             // 2. WebSocket 推送
        emitAgentLog(config.id, entry.level, entry.content)     // 3. 事件总线（DB 持久化）
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    // 进程退出处理
    child.on('exit', (code, signal) => {
      proc.child = null
      proc.pid   = null

      if (code === 0) {
        // 正常退出
        emitAgentStopped(config.id)
      } else {
        // 异常退出，触发自动重启
        emitAgentCrashed(config.id, code, signal)
        this._scheduleRestart(config.id)
      }
    })

    emitAgentStarted(config.id, child.pid ?? 0)
  }

  // ── 优雅停止 Agent ───────────────────────────────────────────────
  /**
   * 停止指定 Agent 进程
   * 策略: 先发 SIGTERM 让进程自行清理，5 秒后仍未退出则 SIGKILL 强杀
   * @param agentId Agent UUID
   */
  async stop(agentId: string): Promise<void> {
    const proc = this.agents.get(agentId)
    if (!proc?.child) return

    proc.child.kill('SIGTERM')
    const killTimer = setTimeout(() => proc.child?.kill('SIGKILL'), 5_000)
    proc.child.once('exit', () => clearTimeout(killTimer))

    emitAgentStopped(agentId)
  }

  // ── Token 耗尽交接 ──────────────────────────────────────────────
  /**
   * Token 用量达到阈值时，停止当前进程并启动新进程继续工作
   * @param agentId        Agent UUID
   * @param newRunId       新 run 的 ID
   * @param handoffFilePath handoff 上下文 markdown 文件路径
   *
   * 流程: 停止旧进程 → 等待 2 秒 → 用新配置（含 handoff 文件）启动新进程
   */
  scheduleHandoff(agentId: string, newRunId: string, handoffFilePath: string): void {
    const proc = this.agents.get(agentId)
    if (!proc) return

    emitAgentLog(agentId, 'INFO', `Token handoff → 新 run ${newRunId}，handoff 文件: ${handoffFilePath}`)

    // 在原配置基础上附加 handoff 文件路径，新进程可读取此文件恢复上下文
    const newConfig: AgentConfig = {
      ...proc.config,
      handoffFilePath,
    }

    setTimeout(async () => {
      await this.stop(agentId)
      await new Promise(r => setTimeout(r, 2_000))  // 等待进程完全退出
      await this.spawn(newConfig)
    }, 0)
  }

  // ── 重启调度 ────────────────────────────────────────────────────
  /** 外部调用入口：安排一次自动重启 */
  scheduleRestart(agentId: string): void {
    this._scheduleRestart(agentId)
  }

  /**
   * 内部重启逻辑
   * 算法: 指数退避 (3s × 2^n)，上限 60s，每小时重置计数器
   * 超过 MAX_RESTARTS_PER_HOUR 次则放弃自动重启
   */
  private async _scheduleRestart(agentId: string): Promise<void> {
    const proc = this.agents.get(agentId)
    if (!proc) return

    // 每小时重置重启计数窗口
    const now = new Date()
    if (now.getTime() - proc.restartWindowStart.getTime() > 3_600_000) {
      proc.restartCount = 0
      proc.restartWindowStart = now
    }

    // 超过最大重启次数则停止
    if (proc.restartCount >= MAX_RESTARTS_PER_HOUR) {
      emitAgentLog(agentId, 'ERROR',
        `达到最大重启次数 (${MAX_RESTARTS_PER_HOUR}/小时)，停止自动重启`)
      return
    }

    // 指数退避: 3s, 6s, 12s, 24s, 48s, 60s(上限)
    const delay = Math.min(3_000 * 2 ** proc.restartCount, 60_000)
    proc.restartCount++

    emitAgentLog(agentId, 'WARN', `将在 ${delay / 1000}s 后重启 (第 ${proc.restartCount} 次)`)
    setTimeout(() => this.spawn(proc.config), delay)
  }

  /** 当前管理的 Agent 总数 */
  public get agentCount() { return this.agents.size }

  // ── 心跳更新 ────────────────────────────────────────────────────
  /**
   * 更新 Agent 的最后心跳时间
   * 由 Agent 通过 HTTP API 每 30s 调用一次
   */
  updateHeartbeat(agentId: string): void {
    const proc = this.agents.get(agentId)
    if (proc) proc.lastHeartbeatAt = new Date()
  }

  // ── 心跳超时检查（定时器回调） ──────────────────────────────────
  /**
   * 每 60 秒扫描所有运行中的 Agent，检测心跳是否超时
   * 超时策略:
   *   - 进程仍存活但无心跳 → 可能死锁，SIGKILL 强杀
   *   - 进程已死 → 清理状态并安排重启
   */
  private checkHeartbeats(): void {
    const now = new Date()
    for (const [agentId, proc] of this.agents) {
      if (!proc.child || !proc.lastHeartbeatAt) continue
      const elapsed = now.getTime() - proc.lastHeartbeatAt.getTime()
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        emitAgentLog(agentId, 'WARN', `心跳超时 (${Math.round(elapsed / 1000)}s)，标记离线`)
        emitAgentOffline(agentId)
        // 通过 signal 0 检查操作系统进程是否仍存活
        if (proc.pid) {
          try {
            process.kill(proc.pid, 0)  // signal 0 不发信号，仅检查进程存在性
            // 进程存在但不心跳 → 可能死锁，强制杀死
            emitAgentLog(agentId, 'ERROR', '进程存在但无心跳，强制重启')
            proc.child.kill('SIGKILL')
          } catch {
            // kill(pid, 0) 抛异常说明进程已死
            proc.child = null
            proc.pid   = null
            this._scheduleRestart(agentId)
          }
        }
      }
    }
  }

  // ── 构建启动命令 ──────────────────────────────────────────────
  /**
   * 根据 runtime 类型构建子进程的命令行参数
   * 目前仅支持 'claude' runtime
   */
  private buildCommand(config: AgentConfig): string[] {
    if (config.runtime === 'claude') {
      return ['claude', '--agent',
        '--server-url', config.serverUrl,
        '--api-key',    config.apiKey,
        '--workspace',  config.workspacePath,
      ]
    }
    throw new Error(`Unknown runtime: ${config.runtime}`)
  }

  /**
   * 构建子进程的环境变量
   * 继承父进程环境变量，并注入 Agent 专用变量（SLOCK_* 前缀）
   * 如果有 handoff 文件，通过 SLOCK_HANDOFF_FILE 传递给新进程
   */
  private buildEnv(config: AgentConfig): Record<string, string> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SLOCK_AGENT_ID:        config.id,
      SLOCK_AGENT_NAME:      config.name,
      SLOCK_SERVER_URL:      config.serverUrl,
      SLOCK_API_KEY:         config.apiKey,
      ANTHROPIC_API_KEY:     process.env.ANTHROPIC_API_KEY ?? '',
      MOONSHOT_API_KEY:      process.env.MOONSHOT_API_KEY  ?? '',
    }
    if (config.handoffFilePath) {
      env.SLOCK_HANDOFF_FILE = config.handoffFilePath
    }
    return env
  }

  /** 销毁管理器，清理定时器和文件句柄 */
  destroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.obsidian.close()
  }
}

/** 全局单例进程管理器 */
export const processManager = new ProcessManager()
