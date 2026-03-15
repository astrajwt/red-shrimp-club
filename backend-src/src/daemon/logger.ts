// Daemon Logger — 三路日志输出
// 1. 数据库 agent_logs 表
// 2. Obsidian markdown 文件 ~/JwtVault/00_hub/agents/<name>/logs/YYYY-MM-DD.md
// 3. WebSocket 推送给前端

import fs from 'fs'
import path from 'path'
import os from 'os'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'ACTION' | 'FILE' | 'SPAWN' | 'LLM'

export interface LogEntry {
  agentId:  string
  agentName:string
  runId?:   string
  level:    LogLevel
  content:  string
  timestamp:Date
}

// Regex to parse structured log lines from Agent stdout
// Expected format: [2026-03-12T09:34:18Z] [INFO] message content
const LOG_PATTERN = /^\[(.+?)\] \[(\w+)\] (.+)$/

export function parseLogLine(line: string): { level: LogLevel; content: string; ts: Date } | null {
  const m = line.match(LOG_PATTERN)
  if (!m) return null
  return {
    ts:      new Date(m[1]),
    level:   m[2] as LogLevel,
    content: m[3],
  }
}

// ── Obsidian file writer ──────────────────────────────────────────
export class ObsidianLogWriter {
  private vaultRoot: string
  private handles = new Map<string, fs.WriteStream>()

  constructor(vaultRoot = process.env.OBSIDIAN_ROOT?.trim() || path.join(os.homedir(), 'JwtVault')) {
    this.vaultRoot = vaultRoot
  }

  private getPath(agentName: string): string {
    const date = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
    return path.join(this.vaultRoot, '00_hub', 'agents', agentName, 'logs', `${date}.md`)
  }

  private getStream(agentName: string): fs.WriteStream {
    const key = `${agentName}-${new Date().toISOString().slice(0, 10)}`
    if (!this.handles.has(key)) {
      const filePath = this.getPath(agentName)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })

      // Write header if new file
      const existed = fs.existsSync(filePath)
      const stream = fs.createWriteStream(filePath, { flags: 'a' })
      if (!existed) {
        const date = new Date().toISOString().slice(0, 10)
        stream.write(`# Agent ${agentName} 日志 — ${date}\n\n`)
      }
      this.handles.set(key, stream)
    }
    return this.handles.get(key)!
  }

  write(entry: LogEntry): void {
    const stream = this.getStream(entry.agentName)
    const time   = entry.timestamp.toISOString().slice(11, 19)  // HH:MM:SS
    const badge  = entry.level.padEnd(6)
    stream.write(`- [${time}] [${badge}] ${entry.content}\n`)
  }

  close(): void {
    for (const stream of this.handles.values()) stream.end()
    this.handles.clear()
  }
}

// ── In-memory log buffer for WebSocket broadcast ──────────────────
type LogListener = (entry: LogEntry) => void

export class LogEventEmitter {
  private listeners: LogListener[] = []

  on(listener: LogListener) { this.listeners.push(listener) }

  off(listener: LogListener) {
    this.listeners = this.listeners.filter(l => l !== listener)
  }

  emit(entry: LogEntry) {
    for (const l of this.listeners) l(entry)
  }
}
