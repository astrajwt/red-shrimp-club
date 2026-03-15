// Daemon Process Manager — Agent 进程生命周期管理
// Aligned with slock daemon logic: spawn / stop / restart / session resume / message delivery

import { spawn, ChildProcess, execSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { mkdir, writeFile, access } from 'fs/promises'
import { parseLogLine, ObsidianLogWriter, LogEventEmitter, LogEntry } from './logger.js'
import {
  emitAgentStarted, emitAgentStopped, emitAgentCrashed,
  emitAgentOffline, emitAgentLog,
} from './events.js'
import { buildInitialMemoryIndex } from './workspace-init.js'
import { query } from '../db/client.js'
import { pushThinking } from '../services/thinking-buffer.js'

// Supported runtimes
export const SUPPORTED_RUNTIMES = ['claude', 'codex', 'kimi'] as const
export type RuntimeId = typeof SUPPORTED_RUNTIMES[number]

export interface AgentConfig {
  id:           string
  name:         string
  machineId:    string
  serverUrl:    string
  apiKey:       string
  workspacePath:string
  runtime:      RuntimeId
  modelId:      string
  reasoningEffort?: string
  sessionId?:   string
}

// Matches slock daemon's AgentProc states
type AgentStatus = 'active' | 'sleeping' | 'inactive'

interface DeliveredMessage {
  channel_name: string
  channel_type: string
  sender_name: string
  sender_type: string
  content: string
  timestamp: string
}

interface AgentProcess {
  config:          AgentConfig
  child:           ChildProcess | null
  pid:             number | null
  sessionId:       string | null         // captured from claude stdout for --resume
  status:          AgentStatus
  lastHeartbeatAt: Date | null
  crashCount:      number                // consecutive crash counter
  prematureExitCount: number             // clean exits that ran < 15s (codex model-refresh bug)
  spawnedAt:       Date | null           // when the child was spawned
  // Notification batching (matches slock daemon)
  pendingNotificationCount: number
  notificationTimer:        ReturnType<typeof setTimeout> | null
  lastDeliveredMessage:     DeliveredMessage | null
}

const HEARTBEAT_TIMEOUT_MS  = 300_000  // 5 min — agents may think/generate for long stretches
const HEARTBEAT_CHECK_INTERVAL = 60_000
const NOTIFICATION_BATCH_MS = 3000
const WAKE_NOTIFICATION_DELAY_MS = 1500
const DEFAULT_KIMI_CLI_MODEL = 'kimi-code/kimi-for-coding'
const LEGACY_KIMI_MODEL = 'kimi-k2-5'

function usesStreamingJsonInput(runtime: RuntimeId): boolean {
  return runtime === 'claude'
}

function supportsStdinNotification(runtime: RuntimeId): boolean {
  return runtime === 'claude'
}

function buildStdinMessage(runtime: RuntimeId, text: string): string {
  if (runtime === 'kimi') {
    return JSON.stringify({ role: 'user', content: text })
  }
  // Claude stream-json stdin format
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

export class ProcessManager {
  private agents = new Map<string, AgentProcess>()
  private obsidian = new ObsidianLogWriter()
  public  logEmitter = new LogEventEmitter()
  private heartbeatTimer: NodeJS.Timer | null = null

  constructor() {
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_CHECK_INTERVAL)
  }

  private persistSessionId(agentId: string, sessionId: string | null): void {
    if (!sessionId?.trim()) return
    query(`UPDATE agents SET session_id = $1 WHERE id = $2`, [sessionId, agentId]).catch(() => {})
  }

  // ── Write to agent's stdin ────────────────────────────────────────
  private writeAgentInput(proc: AgentProcess, text: string): boolean {
    if (!proc.child?.stdin?.writable) return false
    try {
      proc.child.stdin.write(`${buildStdinMessage(proc.config.runtime, text)}\n`)
      return true
    } catch {
      return false
    }
  }

  // ── Message delivery (matches slock daemon deliverMessage) ────────
  deliverMessage(agentId: string, message: DeliveredMessage): void {
    const ap = this.agents.get(agentId)
    if (!ap) return

    ap.pendingNotificationCount++
    ap.lastDeliveredMessage = message

    if (!ap.child || !ap.child.stdin?.writable) {
      // Agent is sleeping — wake it up with the message that triggered the wake (slock-style)
      if (ap.status === 'sleeping') {
        emitAgentLog(agentId, 'INFO', `[唤醒] ${ap.config.name} 从 sleeping 状态被消息唤醒: [${message.channel_type === 'dm' ? 'DM' : '#' + message.channel_name}] @${message.sender_name}: ${message.content.slice(0, 80)}`)
        const resumeConfig = ap.sessionId
          ? { ...ap.config, sessionId: ap.sessionId }
          : ap.config
        // Pass the wake message so the resume prompt includes it inline
        this.spawn(resumeConfig, message).catch(err =>
          emitAgentLog(agentId, 'ERROR', `Wake failed: ${err.message}`)
        )
      }
      return
    }

    if (!supportsStdinNotification(ap.config.runtime)) return

    this.scheduleNotification(agentId)
  }

  private clearNotificationTimer(ap: AgentProcess): void {
    if (ap.notificationTimer) {
      clearTimeout(ap.notificationTimer)
      ap.notificationTimer = null
    }
  }

  private formatMessagePreview(message: DeliveredMessage | null): string {
    if (!message) return ''
    const channel = message.channel_type === 'dm'
      ? `DM:@${message.sender_name}`
      : `#${message.channel_name}`
    const content = (message.content || '').replace(/\s+/g, ' ').trim()
    const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content
    return `Latest: [${channel}] @${message.sender_name}: ${preview}`
  }

  private flushNotification(agentId: string): void {
    const ap = this.agents.get(agentId)
    if (!ap || ap.pendingNotificationCount <= 0) return
    if (!ap.child || !ap.child.stdin?.writable) return

    const count = ap.pendingNotificationCount
    const preview = this.formatMessagePreview(ap.lastDeliveredMessage)
    const detail = preview ? ` ${preview}` : ''
    const notification =
      `\n[System notification: You have ${count} new message(s) waiting. ` +
      `Call receive_message to read them when you're ready.${detail}]\n`

    ap.pendingNotificationCount = 0
    ap.lastDeliveredMessage = null
    this.clearNotificationTimer(ap)

    try {
      this.writeAgentInput(ap, notification)
    } catch {
      // stdin may be closed; unread messages remain in backend storage.
    }
  }

  private scheduleNotification(agentId: string, delayMs = NOTIFICATION_BATCH_MS): void {
    const ap = this.agents.get(agentId)
    if (!ap || ap.notificationTimer) return

    ap.notificationTimer = setTimeout(() => {
      this.flushNotification(agentId)
    }, delayMs)
  }

  // ── Spawn a new Agent process ────────────────────────────────────
  // wakeMessage: the message that triggered the wake (slock-style: agent:start includes wakeMessage)
  // unreadSummary: channel → count map of unread messages while sleeping
  async spawn(config: AgentConfig, wakeMessage?: DeliveredMessage | null, unreadSummary?: Record<string, number>): Promise<void> {
    const existing = this.agents.get(config.id)
    const resumeSessionId = existing?.sessionId ?? config.sessionId ?? undefined
    const effectiveConfig: AgentConfig = resumeSessionId
      ? { ...config, sessionId: resumeSessionId }
      : { ...config, sessionId: undefined }
    if (existing?.child && existing.status === 'active') {
      if (this.isAlive(existing.pid)) {
        emitAgentLog(config.id, 'INFO', `Agent ${config.name} already active (pid ${existing.pid}), skipping`)
        return
      }
      existing.child = null
      existing.pid = null
    }
    // Stop zombie process if exists
    if (existing?.child) {
      existing.child.kill('SIGTERM')
      await new Promise(r => setTimeout(r, 1000))
    }

    // Kill orphan agent runtime + bridge processes from previous backend runs.
    // Bridges are MCP children of the runtime (claude/kimi/codex), so killing the
    // runtime parent also kills its bridges. We find bridges first to locate parents.
    try {
      const bridgeOutput = execSync(
        `pgrep -f "chat-bridge.*--agent-id ${config.id}" 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 3000 }
      ).trim()
      if (bridgeOutput) {
        const bridgePids = bridgeOutput.split('\n').filter(Boolean)
        // Find parent PIDs (the actual claude/kimi/codex processes)
        const parentPids = new Set<string>()
        for (const bp of bridgePids) {
          try {
            const ppid = execSync(`ps -o ppid= -p ${bp} 2>/dev/null || true`, { encoding: 'utf-8', timeout: 1000 }).trim()
            if (ppid && ppid !== '1' && ppid !== String(process.pid)) parentPids.add(ppid)
          } catch { /* ignore */ }
        }
        const allPids = [...parentPids, ...bridgePids]
        if (allPids.length > 0) {
          emitAgentLog(config.id, 'INFO', `[清理] 发现 ${bridgePids.length} 个残留 bridge + ${parentPids.size} 个 runtime 进程，正在清理`)
          execSync(`kill ${allPids.join(' ')} 2>/dev/null || true`, { timeout: 3000 })
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    } catch { /* best effort */ }

    // Ensure workspace exists
    try {
      await mkdir(config.workspacePath, { recursive: true })
    } catch { /* best effort */ }

    // Create MEMORY.md if not exists
    try {
      await access(resolve(config.workspacePath, 'MEMORY.md'))
    } catch {
      try {
        await writeFile(resolve(config.workspacePath, 'MEMORY.md'), buildInitialMemoryIndex({
          agentName: config.name,
          activeContext: 'First startup.',
        }))
      } catch { /* best effort */ }
    }

    // Codex requires a git repo
    if (config.runtime === 'codex') {
      const gitDir = resolve(config.workspacePath, '.git')
      if (!existsSync(gitDir)) {
        try {
          execSync('git init', { cwd: config.workspacePath, stdio: 'pipe' })
          execSync('git add -A && git commit --allow-empty -m "init"', {
            cwd: config.workspacePath,
            stdio: 'pipe',
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: 'redshrimp',
              GIT_AUTHOR_EMAIL: 'redshrimp@local',
              GIT_COMMITTER_NAME: 'redshrimp',
              GIT_COMMITTER_EMAIL: 'redshrimp@local',
            },
          })
        } catch { /* best effort */ }
      }
    }

    const pendingNotifications = existing?.pendingNotificationCount ?? 0
    const launchPrompt = this.buildLaunchPrompt(effectiveConfig, pendingNotifications, wakeMessage, unreadSummary)

    let cmd: string[]
    try {
      cmd = this.buildCommand(effectiveConfig, launchPrompt)
    } catch (err: any) {
      throw new Error(`Cannot build command for agent ${config.name}: ${err.message}`)
    }

    const env = this.buildEnv(effectiveConfig)
    let child: ChildProcess
    try {
      child = spawn(cmd[0], cmd.slice(1), {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: config.workspacePath,
      })
    } catch (err: any) {
      throw new Error(`Failed to spawn agent ${config.name} (cmd: ${cmd[0]}): ${err.message}`)
    }

    emitAgentLog(config.id, 'INFO', `[启动] ${config.name} (${config.runtime}) pid=${child.pid ?? '?'} | cmd=${cmd[0]} model=${config.modelId} session=${effectiveConfig.sessionId ?? 'new'} workspace=${config.workspacePath}`)
    if (wakeMessage) {
      emitAgentLog(config.id, 'INFO', `[唤醒] 触发消息: [${wakeMessage.channel_type === 'dm' ? 'DM' : '#' + wakeMessage.channel_name}] @${wakeMessage.sender_name}: ${wakeMessage.content.slice(0, 100)}`)
    }

    child.on('error', (err) => {
      emitAgentLog(config.id, 'ERROR', `[诊断] 进程启动失败: ${err.message}`)
      emitAgentLog(config.id, 'ERROR', `[诊断] 原因分析: 可能是命令 "${cmd[0]}" 不存在、权限不足或路径错误`)
      emitAgentCrashed(config.id, null, null)
      const ap = this.agents.get(config.id)
      if (ap) {
        ap.status = 'inactive'
        ap.child = null
        ap.pid = null
      }
    })

    const ap: AgentProcess = {
      config: effectiveConfig,
      child,
      pid: child.pid ?? null,
      sessionId: resumeSessionId ?? null,
      status: 'active',
      lastHeartbeatAt: new Date(),
      crashCount: existing?.crashCount ?? 0,
      prematureExitCount: existing?.prematureExitCount ?? 0,
      spawnedAt: new Date(),
      pendingNotificationCount: pendingNotifications,
      notificationTimer: null,
      lastDeliveredMessage: existing?.lastDeliveredMessage ?? null,
    }
    this.agents.set(config.id, ap)

    if (usesStreamingJsonInput(effectiveConfig.runtime)) {
      setTimeout(() => {
        this.writeAgentInput(ap, launchPrompt)
      }, 150)
    }

    // If agent has pending notifications from while it was sleeping, schedule delivery
    if (ap.pendingNotificationCount > 0) {
      this.scheduleNotification(config.id, WAKE_NOTIFICATION_DELAY_MS)
    }

    // Parse stdout — capture session_id for resume and log trajectory
    // Stdout activity = process is alive, update heartbeat (slock-style)
    // Reset crash count after agent has been running stably for 30s
    const spawnedAt = Date.now()
    child.stdout?.on('data', (data: Buffer) => {
      ap.lastHeartbeatAt = new Date()
      if (Date.now() - spawnedAt > 30_000) {
        if (ap.crashCount > 0) ap.crashCount = 0
        if (ap.prematureExitCount > 0) ap.prematureExitCount = 0
      }
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        // Try to parse as JSON (claude --verbose outputs JSON events)
        // Try to parse as JSON (claude/codex --verbose outputs JSON events)
        let isProtocolJson = false
        try {
          const event = JSON.parse(line)
          isProtocolJson = true  // Successfully parsed → internal protocol message
          // Capture session_id from claude init/result events
          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            ap.sessionId = event.session_id
            ap.config.sessionId = event.session_id
            this.persistSessionId(config.id, event.session_id)
          }
          if (event.type === 'result' && event.session_id) {
            ap.sessionId = event.session_id
            ap.config.sessionId = event.session_id
            this.persistSessionId(config.id, event.session_id)
          }
          if (event.session_id && typeof event.session_id === 'string') {
            ap.sessionId = event.session_id
            ap.config.sessionId = event.session_id
            this.persistSessionId(config.id, event.session_id)
          }
        } catch {
          // Not JSON — plain log line
        }

        // Extract useful content from protocol JSON for logging
        if (isProtocolJson) {
          try {
            const event = JSON.parse(line)
            let logContent: string | null = null

            // Claude stream-json: assistant text + thinking
            if (event.type === 'assistant' && event.message?.content) {
              const textParts = event.message.content
                .filter((b: any) => b.type === 'text' && b.text)
                .map((b: any) => b.text)
              if (textParts.length > 0) logContent = textParts.join('\n')
              // Capture thinking blocks for CoT display
              for (const block of event.message.content) {
                if (block.type === 'thinking' && block.thinking) {
                  pushThinking(config.id, block.thinking.slice(0, 4000))
                }
              }
            }
            // Claude stream-json: tool_use
            if (event.type === 'assistant' && event.message?.content) {
              const tools = event.message.content.filter((b: any) => b.type === 'tool_use')
              for (const t of tools) {
                emitAgentLog(config.id, 'INFO', `[tool] ${t.name}`)
              }
            }
            // Codex exec: message with content
            if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string' && event.content.trim()) {
              logContent = event.content.trim()
            }
            // Result summary
            if (event.type === 'result') {
              const cost = event.total_cost_usd ?? event.cost_usd
              const turns = event.num_turns
              const summary = [
                turns ? `${turns} turns` : null,
                cost ? `$${Number(cost).toFixed(4)}` : null,
              ].filter(Boolean).join(', ')
              if (summary) emitAgentLog(config.id, 'INFO', `[result] ${summary}`)
            }

            if (logContent) {
              const truncated = logContent.length > 500 ? logContent.slice(0, 500) + '...' : logContent
              emitAgentLog(config.id, 'INFO', truncated)
            }
          } catch { /* ignore parse errors on second pass */ }
          continue
        }

        const parsed = parseLogLine(line)
        const entry: LogEntry = {
          agentId:   config.id,
          agentName: config.name,
          level:     parsed?.level ?? 'INFO',
          content:   parsed?.content ?? line,
          timestamp: parsed?.ts ?? new Date(),
        }
        this.obsidian.write(entry)
        this.logEmitter.emit(entry)
        emitAgentLog(config.id, entry.level, entry.content)
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        emitAgentLog(config.id, 'WARN', `[stderr] ${text.slice(0, 2000)}`)
      }
    })

    // Exit handling — matches slock daemon logic exactly
    child.on('exit', (code, signal) => {
      const uptimeMs = ap.spawnedAt ? Date.now() - ap.spawnedAt.getTime() : 0
      const uptimeSec = Math.round(uptimeMs / 1000)
      ap.child = null
      ap.pid = null
      this.clearNotificationTimer(ap)

      emitAgentLog(config.id, 'INFO', `[退出] ${config.name} code=${code} signal=${signal ?? 'none'} 运行时间=${uptimeSec}s session=${ap.sessionId ?? 'none'}`)

      if (code === 0 && signal === null) {
        // Detect premature clean exits (agent ran < 15s) — common with Codex model-refresh timeout
        if (uptimeMs < 15_000 && config.runtime === 'codex') {
          ap.prematureExitCount = (ap.prematureExitCount ?? 0) + 1
          emitAgentLog(config.id, 'WARN',
            `[诊断] 异常快速退出 (${uptimeSec}s) — 可能原因: model-refresh超时/API连接失败/config.toml配置冲突`)
          if (ap.prematureExitCount <= 3) {
            const retryDelay = 10_000 * ap.prematureExitCount  // 10s, 20s, 30s
            emitAgentLog(config.id, 'INFO',
              `[决策] 将在 ${retryDelay / 1000}s 后重试 (第${ap.prematureExitCount}/3次)，清除session重新启动`)
            ap.status = 'inactive'
            emitAgentCrashed(config.id, code, signal)
            query(`UPDATE agents SET status = 'error', pid = NULL WHERE id = $1`, [config.id]).catch(() => {})
            setTimeout(() => {
              if (!ap.child) {
                ap.sessionId = null
                ap.config = { ...ap.config, sessionId: undefined }
                this.spawn(ap.config).catch(err =>
                  emitAgentLog(config.id, 'ERROR', `[重启失败] ${err.message}`))
              }
            }, retryDelay)
            return
          } else {
            emitAgentLog(config.id, 'ERROR',
              `[放弃] ${config.name} 连续异常退出 ${ap.prematureExitCount} 次。排查建议: 1) 检查 ~/.codex/config.toml 2) 检查 APIROUTER_API_KEY 3) 检查 moacode.org 连通性`)
            ap.status = 'inactive'
            query(`UPDATE agents SET status = 'error', pid = NULL WHERE id = $1`, [config.id]).catch(() => {})
            emitAgentCrashed(config.id, code, signal)
            return
          }
        }
        ap.prematureExitCount = 0

        // Clean exit — mark sleeping
        emitAgentLog(config.id, 'INFO', `[诊断] 正常退出 → 进入 sleeping 状态，等待下一条消息唤醒。运行时长 ${uptimeSec}s`)
        ap.status = 'sleeping'
        query(`UPDATE agents SET status = 'sleeping', pid = NULL WHERE id = $1`, [config.id]).catch(() => {})
      } else if (signal === 'SIGTERM' || signal === 'SIGKILL' || code === 143 || code === 137) {
        const signalName = signal ?? (code === 143 ? 'SIGTERM' : code === 137 ? 'SIGKILL' : `code ${code}`)
        if (ap.status === 'sleeping') {
          emitAgentLog(config.id, 'INFO', `[诊断] sleeping 状态下收到 ${signalName}，保持 sleeping`)
          return
        }
        if (ap.status === 'inactive') {
          emitAgentLog(config.id, 'INFO', `[停止] ${config.name} 被手动停止 (${signalName})`)
          emitAgentStopped(config.id)
        } else {
          emitAgentLog(config.id, 'WARN', `[诊断] ${config.name} 被 ${signalName} 终止。可能原因: 心跳超时/OOM/外部kill`)
          emitAgentLog(config.id, 'INFO', `[决策] 5s 后自动重启`)
          ap.status = 'inactive'
          emitAgentCrashed(config.id, code, signal)
          setTimeout(() => {
            if (!ap.child) {
              this.spawn(ap.config).catch(err =>
                emitAgentLog(config.id, 'ERROR', `[重启失败] ${err.message}`)
              )
            }
          }, 5_000)
          return
        }
        ap.status = 'inactive'
      } else {
        // Unexpected crash
        ap.crashCount = (ap.crashCount ?? 0) + 1
        const crashReason = code === 1 ? '一般错误(exit 1)' :
          code === 2 ? '参数错误(exit 2)' :
          code === 127 ? '命令不存在(exit 127)' :
          code === 126 ? '权限不足(exit 126)' :
          `未知错误(exit ${code})`
        emitAgentLog(config.id, 'WARN', `[崩溃] ${config.name} — ${crashReason} (第${ap.crashCount}次连续崩溃)`)
        ap.status = 'inactive'
        emitAgentCrashed(config.id, code, signal)

        if (ap.crashCount >= 3 && ap.sessionId) {
          emitAgentLog(config.id, 'WARN', `[决策] 连续崩溃 ${ap.crashCount} 次 → 清除旧session ${ap.sessionId.slice(0, 8)}... 重新开始`)
          ap.sessionId = null
          ap.config = { ...ap.config, sessionId: undefined }
          query(`UPDATE agents SET session_id = NULL WHERE id = $1`, [config.id]).catch(() => {})
        }

        if (ap.crashCount >= 6) {
          emitAgentLog(config.id, 'ERROR', `[放弃] ${config.name} 崩溃 ${ap.crashCount} 次。排查建议: 1) 检查 workspace 路径 2) 检查 CLI 版本 3) 查看 stderr 日志`)
          query(`UPDATE agents SET status = 'error' WHERE id = $1`, [config.id]).catch(() => {})
          return
        }

        const backoffMs = Math.min(5_000 * Math.pow(2, ap.crashCount - 1), 120_000)
        emitAgentLog(config.id, 'INFO', `[决策] ${Math.round(backoffMs / 1000)}s 后重启 (指数退避)`)

        setTimeout(() => {
          if (!ap.child) {
            this.spawn(ap.config).catch(err =>
              emitAgentLog(config.id, 'ERROR', `[重启失败] ${err.message}`)
            )
          }
        }, backoffMs)
      }
    })

    emitAgentStarted(config.id, child.pid ?? 0)
  }

  // ── Stop an Agent gracefully ─────────────────────────────────────
  async stop(agentId: string): Promise<void> {
    const proc = this.agents.get(agentId)
    if (!proc?.child) return

    this.clearNotificationTimer(proc)
    proc.status = 'inactive'
    proc.child.kill('SIGTERM')
    const killTimer = setTimeout(() => proc.child?.kill('SIGKILL'), 5_000)
    proc.child.once('exit', () => {
      clearTimeout(killTimer)
      this.agents.delete(agentId)
    })

    emitAgentStopped(agentId)
  }

  // ── Sleep an Agent (stop but allow wake on message) ──────────────
  async sleep(agentId: string): Promise<void> {
    const proc = this.agents.get(agentId)
    if (!proc?.child) return

    emitAgentLog(agentId, 'INFO', `Sleeping agent ${proc.config.name}`)
    this.clearNotificationTimer(proc)
    proc.child.kill('SIGTERM')
    proc.status = 'sleeping'
  }

  // ── Token handoff: stop current proc, start fresh with context ───
  scheduleHandoff(agentId: string, newRunId: string, snapshot: Record<string, unknown>): void {
    const proc = this.agents.get(agentId)
    if (!proc) return

    emitAgentLog(agentId, 'INFO', `Token handoff → run ${newRunId}`)

    setTimeout(async () => {
      try {
        await this.stop(agentId)
        await new Promise(r => setTimeout(r, 2_000))
        await this.spawn(proc.config)
      } catch (err: any) {
        emitAgentLog(agentId, 'ERROR', `Handoff failed: ${err.message}`)
      }
    }, 0)
  }

  // ── Public restart (for API use) ──────────────────────────────────
  scheduleRestart(agentId: string): void {
    const proc = this.agents.get(agentId)
    if (!proc) return
    if (proc.child) return

    setTimeout(() => {
      this.spawn(proc.config).catch(err =>
        emitAgentLog(agentId, 'ERROR', `Restart failed: ${err.message}`)
      )
    }, 3_000)
  }

  // ── Register a sleeping agent (no process spawned) ──────────────
  // Used on boot to restore sleeping agents in the process-manager map
  // so deliverMessage can wake them on the next incoming message.
  registerSleeping(config: AgentConfig): void {
    if (this.agents.has(config.id)) return  // already registered
    this.agents.set(config.id, {
      config,
      child: null,
      pid: null,
      sessionId: config.sessionId ?? null,
      status: 'sleeping',
      lastHeartbeatAt: null,
      crashCount: 0,
      pendingNotificationCount: 0,
      notificationTimer: null,
      lastDeliveredMessage: null,
    })
  }

  public get agentCount() { return this.agents.size }

  isRunning(agentId: string): boolean {
    const proc = this.agents.get(agentId)
    return !!proc?.child && this.isAlive(proc.pid)
  }

  getStatus(agentId: string): AgentStatus | null {
    return this.agents.get(agentId)?.status ?? null
  }

  // ── Heartbeat update ──────────────────────────────────────────────
  updateHeartbeat(agentId: string): void {
    const proc = this.agents.get(agentId)
    if (proc) proc.lastHeartbeatAt = new Date()
  }

  private checkHeartbeats(): void {
    const now = new Date()
    for (const [agentId, proc] of this.agents) {
      if (!proc.child || !proc.lastHeartbeatAt) continue
      const elapsed = now.getTime() - proc.lastHeartbeatAt.getTime()
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        emitAgentLog(agentId, 'WARN', `[心跳超时] ${proc.config.name} 已 ${Math.round(elapsed / 1000)}s 无响应 (阈值=${HEARTBEAT_TIMEOUT_MS / 1000}s)`)
        emitAgentOffline(agentId)
        if (proc.pid) {
          try {
            process.kill(proc.pid, 0)
            emitAgentLog(agentId, 'ERROR', `[诊断] 进程 pid=${proc.pid} 仍存活但无心跳 → 可能: LLM长时间推理/API卡住/死循环。执行强制终止`)
            proc.child.kill('SIGKILL')
          } catch {
            emitAgentLog(agentId, 'INFO', `[诊断] 进程 pid=${proc.pid} 已不存在 → 安排重启`)
            proc.child = null
            proc.pid = null
            this.scheduleRestart(agentId)
          }
        }
      }
    }
  }

  private isAlive(pid: number | null): boolean {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // ── Build MCP config ──────────────────────────────────────────────
  private getChatBridgePath(): string {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const daemonBridgePath = resolve(__dirname, '../../../daemon-src/dist/chat-bridge.js')
    const localBridgePath = resolve(__dirname, 'chat-bridge.mjs')
    return existsSync(daemonBridgePath) ? daemonBridgePath : localBridgePath
  }

  private buildMcpConfig(config: AgentConfig): string {
    const chatBridgePath = this.getChatBridgePath()
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

  private buildChatBridgeArgs(config: AgentConfig): string[] {
    const chatBridgePath = this.getChatBridgePath()
    return [
      'node',
      chatBridgePath,
      '--agent-id', config.id,
      '--server-url', config.serverUrl,
      '--auth-token', config.apiKey,
    ]
  }

  private buildBootstrapPrompt(name: string): string {
    const vaultRoot = process.env.OBSIDIAN_ROOT?.trim() || '/home/jwt/JwtVault'
    return `You are "${name}", an AI agent in Red Shrimp.

Read \`MEMORY.md\` in your cwd first. It is your editable memory index and the main source of truth for your role, preferences, and active context. Follow any references inside it to other workspace files only as needed.

Communication rules:
- Use MCP chat tools only for communication.
- Do NOT use shell commands to send or receive messages.
- Do NOT output plain text outside tool calls.
- Do NOT announce yourself or send unprompted status updates.
- Write important long-term state back to \`MEMORY.md\` instead of relying on chat history.
- **⚠️ @mention rule（最重要）**: 如果一条消息没有 @你（@${name}），就不做任何事情。无论群聊还是 DM，只响应明确 @你 的消息。如果消息 @了其他 agent 但没有 @你，保持沉默，直接 receive_message(block=true) 继续监听。

Available MCP chat tools:
- \`mcp__chat__receive_message\`
- \`mcp__chat__send_message\`
- \`mcp__chat__list_server\`
- \`mcp__chat__read_history\`
- \`mcp__chat__list_tasks\`
- \`mcp__chat__create_tasks\`
- \`mcp__chat__claim_tasks\`
- \`mcp__chat__unclaim_task\`
- \`mcp__chat__update_task_status\`
- \`mcp__chat__link_task_doc\`
- \`mcp__chat__create_sticky_note\`
- \`mcp__chat__vault_commit\`

Task rules:
- Tasks are explicitly assigned. Do not rely on claim/unclaim as a normal workflow.
- Only update the status of tasks already assigned to you.
- When creating a task, assign it directly to the right agent up front instead of leaving it open.
- \`create_tasks\` accepts the assignee as an agent id, plain name, or @mention; if omitted, the task is assigned to you. You can also pass \`linked_docs\` (array of vault-relative paths) to attach documents when creating tasks.
- Use \`link_task_doc\` to attach a vault document to an existing task. Pass the channel, task_number, and doc_path (vault-relative). Set status to "writing" while working on it, "unread" when ready for review.
- All doc paths must be vault-root-relative (e.g. \`03_knowlage/02_reading_not/xxx.md\`), NOT workspace-relative.
- **Vault 绝对路径**: \`${vaultRoot}\`。读写 vault 文件时用绝对路径：\`${vaultRoot}/{vault相对路径}\`。例如 \`${vaultRoot}/03_knowlage/02_reading_not/xxx.md\`。
- Content routing: 文章→03_knowlage/02_reading_not/, 视频→03_knowlage/01_lecture_note/, 论文→03_knowlage/04_papers/, 调研→03_knowlage/05_surveys/. Do NOT write to your agents/ private dir.
- After writing or updating vault documents, call \`vault_commit\` with a short description to commit changes to git.

Working loop:
1. Read \`MEMORY.md\`.
2. Call \`mcp__chat__receive_message(block=true)\` to listen for work.
3. Reply or take action as needed using \`mcp__chat__send_message\` and task tools.
4. When you finish assigned work, move it to \`in_review\` unless it is truly trivial.
5. After each step, call \`mcp__chat__receive_message(block=true)\` again so you keep listening.

Your process may exit between turns. Make \`receive_message(block=true)\` your last action whenever you are done with the current step.`
  }

  // Slock-style resume prompt: include the wake message inline so the agent knows
  // exactly what work triggered its wake, instead of blindly calling receive_message.
  private buildResumePrompt(
    wakeMessage?: DeliveredMessage | null,
    unreadSummary?: Record<string, number>,
    supportsStdinNotification = true,
  ): string {
    // Case 1: Resume with a specific wake message (slock: agent:start with wakeMessage)
    if (wakeMessage) {
      const channelLabel = wakeMessage.channel_type === 'dm'
        ? `DM:@${wakeMessage.channel_name}`
        : `#${wakeMessage.channel_name}`
      const time = wakeMessage.timestamp ? ` (${wakeMessage.timestamp})` : ''
      const senderPrefix = wakeMessage.sender_type === 'agent' ? '(agent) ' : ''
      const formatted = `[${channelLabel}]${time} ${senderPrefix}@${wakeMessage.sender_name}: ${wakeMessage.content}`

      let prompt = `New message received:\n\n${formatted}`

      // Mention other unread channels
      if (unreadSummary && Object.keys(unreadSummary).length > 0) {
        const otherUnread = Object.entries(unreadSummary).filter(([key]) => key !== channelLabel)
        if (otherUnread.length > 0) {
          prompt += '\n\nYou also have unread messages in other channels:'
          for (const [ch, count] of otherUnread) {
            prompt += `\n- ${ch}: ${count} unread`
          }
          prompt += '\n\nUse read_history to catch up, or respond to the message above first.'
        }
      }

      prompt += '\n\nRespond as appropriate — reply using send_message, or take action as needed. Then call receive_message(block=true) to keep listening.'

      if (supportsStdinNotification) {
        prompt += '\n\nNote: While you are busy, you may receive [System notification: ...] messages. Finish your current step, then call receive_message to check.'
      }
      return prompt
    }

    // Case 2: Resume with unread summary but no specific wake message
    if (unreadSummary && Object.keys(unreadSummary).length > 0) {
      let prompt = 'You have unread messages from while you were offline:'
      for (const [ch, count] of Object.entries(unreadSummary)) {
        prompt += `\n- ${ch}: ${count} unread`
      }
      prompt += '\n\nUse read_history to catch up on important channels, then call receive_message(block=true) to listen for new messages.'
      if (supportsStdinNotification) {
        prompt += '\n\nNote: While you are busy, you may receive [System notification: ...] messages. Finish your current step, then call receive_message to check.'
      }
      return prompt
    }

    // Case 3: Resume with no messages (shouldn't happen often — agent was woken without a message)
    return 'No new messages while you were away. Call mcp__chat__receive_message(block=true) to listen for new messages.'
  }

  private buildLaunchPrompt(
    config: AgentConfig,
    unreadCount: number,
    wakeMessage?: DeliveredMessage | null,
    unreadSummary?: Record<string, number>,
  ): string {
    if (config.sessionId) {
      return this.buildResumePrompt(
        wakeMessage,
        unreadSummary ?? (unreadCount > 0 ? { 'unknown': unreadCount } : undefined),
        supportsStdinNotification(config.runtime),
      )
    }
    return this.buildBootstrapPrompt(config.name)
  }

  // ── Build shell command for each runtime (matches slock daemon) ──
  private buildCommand(config: AgentConfig, prompt: string): string[] {
    const mcpConfig = this.buildMcpConfig(config)

    switch (config.runtime) {
      // ── Claude Code CLI ────────────────────────────────────────────
      case 'claude': {
        const args = [
          'claude',
          '--allow-dangerously-skip-permissions',
          '--dangerously-skip-permissions',
          '--verbose',
          '--output-format', 'stream-json',
          '--input-format', 'stream-json',
          '--mcp-config', mcpConfig,
          '--model', config.modelId || 'sonnet',
        ]
        if (config.sessionId) {
          args.push('--resume', config.sessionId)
        }
        return args
      }

      // ── OpenAI Codex CLI ───────────────────────────────────────────
      case 'codex': {
        const bridgeArgs = this.buildChatBridgeArgs(config)
        const bridgeCommand = bridgeArgs[0]
        const bridgeRest = bridgeArgs.slice(1)
        const codexArgs = [
          'codex', 'exec',
          ...(config.sessionId ? ['resume', config.sessionId] : []),
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          '-c', `mcp_servers.chat.command=${JSON.stringify(bridgeCommand)}`,
          '-c', `mcp_servers.chat.args=${JSON.stringify(bridgeRest)}`,
          '-c', 'mcp_servers.chat.startup_timeout_sec=30',
          '-c', 'mcp_servers.chat.tool_timeout_sec=120',
          '-c', 'mcp_servers.chat.enabled=true',
          '-c', 'mcp_servers.chat.required=true',
        ]
        if (config.modelId) {
          codexArgs.push('-m', config.modelId)
        } else {
          codexArgs.push('-m', 'gpt-5.4')
        }
        if (config.reasoningEffort) {
          codexArgs.push('-c', `model_reasoning_effort=${config.reasoningEffort}`)
        } else {
          codexArgs.push('-c', 'model_reasoning_effort="medium"')
        }
        // Extend model list timeout to avoid "failed to refresh available models" error
        codexArgs.push('-c', 'model_list_timeout_sec=60')
        codexArgs.push(prompt)
        return codexArgs
      }

      // ── Kimi CLI (Moonshot) ────────────────────────────────────────
      case 'kimi': {
        const kimiModel = config.modelId?.trim()
          ? (config.modelId === LEGACY_KIMI_MODEL ? DEFAULT_KIMI_CLI_MODEL : config.modelId)
          : DEFAULT_KIMI_CLI_MODEL
        const kimiArgs = [
          'kimi',
          '--print',
          '--output-format', 'stream-json',
          '--mcp-config', mcpConfig,
        ]
        if (kimiModel) {
          kimiArgs.push('--model', kimiModel)
        }
        if (config.sessionId) {
          kimiArgs.push('--session', config.sessionId)
        }
        kimiArgs.push('-p', prompt)
        return kimiArgs
      }

      default:
        throw new Error(`Unknown runtime: ${config.runtime}`)
    }
  }

  private buildEnv(config: AgentConfig): Record<string, string> {
    const env: Record<string, string> = { ...process.env as Record<string, string> }
    // Clean Claude Code env vars
    delete env['CLAUDECODE']
    delete env['CLAUDE_CODE_SSE_PORT']
    delete env['CLAUDE_CODE_ENTRYPOINT']
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_CODE_')) delete env[key]
    }
    // Remove empty API keys (matches slock daemon)
    for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
                      'OPENAI_API_BASE', 'OPENAI_ORG_ID', 'OPENAI_PROJECT', 'MOONSHOT_API_KEY',
                      'ZHIPU_API_KEY', 'DASHSCOPE_API_KEY']) {
      if (!env[k] || !env[k].trim()) delete env[k]
    }

    env['FORCE_COLOR'] = '0'
    env['REDSHRIMP_AGENT_ID'] = config.id
    env['REDSHRIMP_AGENT_NAME'] = config.name
    env['REDSHRIMP_SERVER_URL'] = config.serverUrl
    env['REDSHRIMP_API_KEY'] = config.apiKey

    if (config.runtime === 'codex') {
      env['NO_COLOR'] = '1'
      // Extend model refresh timeout — moacode.org/apirouter proxy can be slow
      env['CODEX_MODEL_LIST_TIMEOUT'] = '120'
      env['CODEX_REQUEST_TIMEOUT'] = '120'
      // Disable interactive prompts
      env['CODEX_NONINTERACTIVE'] = '1'
      // Skip model list validation — use cached models to avoid startup timeout
      env['CODEX_SKIP_MODEL_VALIDATION'] = '1'

      // For zhipu/dashscope models running through codex runtime,
      // override OPENAI_BASE_URL and OPENAI_API_KEY to point to the correct provider
      const model = config.modelId ?? ''
      if (model.startsWith('glm')) {
        const zhipuKey = process.env.ZHIPU_API_KEY?.trim()
        if (zhipuKey) {
          env['OPENAI_API_KEY'] = zhipuKey
          env['OPENAI_BASE_URL'] = process.env.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4'
        }
      } else if (model.startsWith('qwen') || model.startsWith('codeplan')) {
        const dsKey = process.env.DASHSCOPE_API_KEY?.trim()
        if (dsKey) {
          env['OPENAI_API_KEY'] = dsKey
          env['OPENAI_BASE_URL'] = process.env.DASHSCOPE_BASE_URL ?? 'https://coding.dashscope.aliyuncs.com/v1'
        }
      }

      // Ensure OPENAI_BASE_URL is set for proxy access (common in China)
      if (!env['OPENAI_BASE_URL'] && process.env.OPENAI_BASE_URL?.trim()) {
        env['OPENAI_BASE_URL'] = process.env.OPENAI_BASE_URL.trim()
      }
    }

    return env
  }

  destroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.obsidian.close()
  }
}

// Global singleton
export const processManager = new ProcessManager()
