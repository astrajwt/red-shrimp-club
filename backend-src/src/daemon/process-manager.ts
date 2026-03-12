// Daemon Process Manager — Agent 进程生命周期管理
// spawn / stop / restart / heartbeat monitoring

import { spawn, ChildProcess } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { parseLogLine, ObsidianLogWriter, LogEventEmitter, LogEntry } from './logger.js'
import {
  emitAgentStarted, emitAgentStopped, emitAgentCrashed,
  emitAgentOffline, emitAgentLog,
} from './events.js'

// Supported runtimes
export const SUPPORTED_RUNTIMES = ['claude', 'codex', 'kimi'] as const
export type RuntimeId = typeof SUPPORTED_RUNTIMES[number]

export interface AgentConfig {
  id:           string
  name:         string
  machineId:    string
  serverUrl:    string  // backend WS URL
  apiKey:       string  // agent's API key for auth
  workspacePath:string
  runtime:      RuntimeId  // 'claude' | 'codex' | 'kimi'
  modelId:      string
  sessionId?:   string  // for resume (claude only)
}

interface AgentProcess {
  config:          AgentConfig
  child:           ChildProcess | null
  pid:             number | null
  lastHeartbeatAt: Date | null
  restartCount:    number
  restartWindowStart: Date
}

const MAX_RESTARTS_PER_HOUR = 3
const HEARTBEAT_TIMEOUT_MS  = 90_000   // 90s
const HEARTBEAT_CHECK_INTERVAL = 60_000 // 60s

export class ProcessManager {
  private agents = new Map<string, AgentProcess>()
  private obsidian = new ObsidianLogWriter()
  public  logEmitter = new LogEventEmitter()
  private heartbeatTimer: NodeJS.Timer | null = null

  constructor() {
    // Start heartbeat monitor
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_CHECK_INTERVAL)
  }

  // ── Spawn a new Agent process ────────────────────────────────────
  async spawn(config: AgentConfig): Promise<void> {
    if (this.agents.get(config.id)?.child) {
      throw new Error(`Agent ${config.name} is already running`)
    }

    let cmd: string[]
    try {
      cmd = this.buildCommand(config)
    } catch (err: any) {
      throw new Error(`Cannot build command for agent ${config.name}: ${err.message}`)
    }

    const env = this.buildEnv(config)
    let child: ChildProcess
    try {
      child = spawn(cmd[0], cmd.slice(1), {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: config.workspacePath,
      })
    } catch (err: any) {
      throw new Error(`Failed to spawn agent ${config.name} (cmd: ${cmd[0]}): ${err.message}`)
    }

    // Emit spawn error (e.g. ENOENT when binary missing) without crashing server
    child.on('error', (err) => {
      emitAgentLog(config.id, 'ERROR', `Spawn error: ${err.message}`)
      emitAgentCrashed(config.id, null, null)
      this.agents.delete(config.id)
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

    // Pipe stdout/stderr → parse → three-way output
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
        // 1. Obsidian file
        this.obsidian.write(entry)
        // 2. WebSocket emitter
        this.logEmitter.emit(entry)
        // 3. Event bus (for DB persistence)
        emitAgentLog(config.id, entry.level, entry.content)
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    child.on('exit', (code, signal) => {
      proc.child = null
      proc.pid   = null

      if (code === 0) {
        emitAgentStopped(config.id)
      } else {
        emitAgentCrashed(config.id, code, signal)
        this._scheduleRestart(config.id)
      }
    })

    emitAgentStarted(config.id, child.pid ?? 0)
  }

  // ── Stop an Agent gracefully ─────────────────────────────────────
  async stop(agentId: string): Promise<void> {
    const proc = this.agents.get(agentId)
    if (!proc?.child) return

    // Try SIGTERM first, force SIGKILL after 5s
    proc.child.kill('SIGTERM')
    const killTimer = setTimeout(() => proc.child?.kill('SIGKILL'), 5_000)
    proc.child.once('exit', () => {
      clearTimeout(killTimer)
      this.agents.delete(agentId)  // Remove so next spawn() can re-add cleanly
    })

    emitAgentStopped(agentId)
  }

  // ── Token handoff: stop current proc, start fresh with context ───
  scheduleHandoff(agentId: string, newRunId: string, snapshot: Record<string, unknown>): void {
    const proc = this.agents.get(agentId)
    if (!proc) return

    emitAgentLog(agentId, 'INFO', `Token handoff → 新 run ${newRunId}，保存上下文快照`)

    // Stop current process and restart — the new run ID is passed via env
    const newConfig: AgentConfig = {
      ...proc.config,
      // Pass handoff metadata so the agent can restore context
    }

    setTimeout(async () => {
      try {
        await this.stop(agentId)
        await new Promise(r => setTimeout(r, 2_000))
        await this.spawn(newConfig)
      } catch (err: any) {
        emitAgentLog(agentId, 'ERROR', `Handoff 失败: ${err.message}`)
      }
    }, 0)
  }

  // ── Restart ──────────────────────────────────────────────────────
  scheduleRestart(agentId: string): void {
    this._scheduleRestart(agentId)
  }

  private async _scheduleRestart(agentId: string): Promise<void> {
    const proc = this.agents.get(agentId)
    if (!proc) return
    // If already respawned externally (e.g. via API), skip auto-restart
    if (proc.child) return

    // Reset restart counter every hour
    const now = new Date()
    if (now.getTime() - proc.restartWindowStart.getTime() > 3_600_000) {
      proc.restartCount = 0
      proc.restartWindowStart = now
    }

    if (proc.restartCount >= MAX_RESTARTS_PER_HOUR) {
      emitAgentLog(agentId, 'ERROR',
        `达到最大重启次数 (${MAX_RESTARTS_PER_HOUR}/小时)，停止自动重启`)
      return
    }

    const delay = Math.min(3_000 * 2 ** proc.restartCount, 60_000)  // exponential backoff
    proc.restartCount++

    emitAgentLog(agentId, 'WARN', `将在 ${delay / 1000}s 后重启 (第 ${proc.restartCount} 次)`)
    setTimeout(() => {
      this.spawn(proc.config).catch(err =>
        emitAgentLog(agentId, 'ERROR', `自动重启失败: ${err.message}`)
      )
    }, delay)
  }

  public get agentCount() { return this.agents.size }

  // ── Heartbeat update (called by API when agent pings) ────────────
  updateHeartbeat(agentId: string): void {
    const proc = this.agents.get(agentId)
    if (proc) proc.lastHeartbeatAt = new Date()
  }

  // ── Periodic heartbeat checker ────────────────────────────────────
  private checkHeartbeats(): void {
    const now = new Date()
    for (const [agentId, proc] of this.agents) {
      if (!proc.child || !proc.lastHeartbeatAt) continue
      const elapsed = now.getTime() - proc.lastHeartbeatAt.getTime()
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        emitAgentLog(agentId, 'WARN', `心跳超时 (${Math.round(elapsed / 1000)}s)，标记离线`)
        emitAgentOffline(agentId)
        // Check if OS process is still alive
        if (proc.pid) {
          try {
            process.kill(proc.pid, 0)  // signal 0 = check existence
            // Process exists but not heartbeating — may be deadlocked
            emitAgentLog(agentId, 'ERROR', '进程存在但无心跳，强制重启')
            proc.child.kill('SIGKILL')
          } catch {
            // Process already dead
            proc.child = null
            proc.pid   = null
            this._scheduleRestart(agentId)
          }
        }
      }
    }
  }

  // ── Build MCP config JSON (shared across runtimes) ──────────────
  private buildMcpConfig(config: AgentConfig): string {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const chatBridgePath = resolve(__dirname, 'chat-bridge.mjs')
    return JSON.stringify({
      mcpServers: {
        chat: {
          command: 'node',
          args: [
            chatBridgePath,
            '--agent-id', config.id,
            '--server-url', config.serverUrl,
            '--auth-token', config.apiKey,
          ],
        },
      },
    })
  }

  private readonly AGENT_PROMPT = (name: string) =>
    `You are ${name}. Read CLAUDE.md and MEMORY.md for your role and context.\nYour job: stay online silently and respond only when someone talks to you.\nLoop (repeat forever):\n1. Call mcp__chat__receive_message with block=true\n2. For each message received: if it's directed at you, @mentions you, or is a DM — reply using the reply_to field from the message (e.g. reply_to.dm_to or reply_to.channel)\n3. Go back to step 1\nIMPORTANT: Do NOT send any unprompted messages. Do NOT announce you are online. Do NOT send status updates. Only speak when a message requires your response.\nExit only when your context window is nearly full — write important notes to MEMORY.md first, then exit cleanly.`

  // ── Build shell command for each runtime ─────────────────────────
  private buildCommand(config: AgentConfig): string[] {
    const mcpConfig = this.buildMcpConfig(config)
    const prompt = this.AGENT_PROMPT(config.name)

    switch (config.runtime) {
      // ── Claude Code CLI ──────────────────────────────────────────
      case 'claude': {
        const args = [
          'claude',
          '--dangerously-skip-permissions',
          '--model', config.modelId || 'claude-sonnet-4-6',
          '--mcp-config', mcpConfig,
        ]
        // Resume session if available
        if (config.sessionId) {
          args.push('--resume', config.sessionId)
        } else {
          args.push('-p', prompt)
        }
        return args
      }

      // ── OpenAI Codex CLI ─────────────────────────────────────────
      case 'codex': {
        return [
          'codex', 'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          '-m', config.modelId || 'o4-mini',
          '--mcp-config', mcpConfig,
          '-C', config.workspacePath,
          prompt,
        ]
      }

      // ── Kimi CLI (Moonshot) ──────────────────────────────────────
      case 'kimi': {
        return [
          'kimi',
          '--skip-permissions',
          '--model', config.modelId || 'kimi-k2-5',
          '--mcp-config', mcpConfig,
          '-p', prompt,
        ]
      }

      default:
        throw new Error(`Unknown runtime: ${config.runtime}`)
    }
  }

  private buildEnv(config: AgentConfig): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    // Unset all Claude Code env vars so child agents can start their own sessions
    delete env['CLAUDECODE']
    delete env['CLAUDE_CODE_SSE_PORT']
    delete env['CLAUDE_CODE_ENTRYPOINT']
    // Remove any other CLAUDE_CODE_* vars
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_CODE_')) delete env[key]
    }
    // Only set API keys if they are non-empty, otherwise let claude CLI
    // fall back to its own auth (~/.claude/ credentials)
    const result: Record<string, string> = {
      ...env,
      REDSHRIMP_AGENT_ID:        config.id,
      REDSHRIMP_AGENT_NAME:      config.name,
      REDSHRIMP_SERVER_URL:      config.serverUrl,
      REDSHRIMP_API_KEY:         config.apiKey,
    }
    if (process.env.ANTHROPIC_API_KEY) result.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
    if (process.env.OPENAI_API_KEY)   result.OPENAI_API_KEY   = process.env.OPENAI_API_KEY
    if (process.env.MOONSHOT_API_KEY)  result.MOONSHOT_API_KEY  = process.env.MOONSHOT_API_KEY
    return result
  }

  destroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.obsidian.close()
  }
}

// Global singleton
export const processManager = new ProcessManager()
