/**
 * Daemon 日志系统 — 三路日志输出 + Agent 记忆管理
 *
 * 文件位置: backend-src/src/daemon/logger.ts
 * 核心功能:
 *   1. parseLogLine: 解析 Agent 子进程输出的结构化日志行
 *   2. ObsidianLogWriter: 将日志写入 Obsidian vault markdown 文件
 *   3. MemoryWriter: 管理 Agent 的 MEMORY.md 和 handoff 上下文文件
 *   4. LogEventEmitter: 内存中的日志事件发射器，供 Socket.io 订阅
 *
 * 文件结构 (~/JwtVault/agent-memory/):
 *   {agentName}/
 *     MEMORY.md              — Agent 当前工作状态记忆
 *     handoff/{runId}.md     — Token 耗尽时的上下文快照
 *     logs/YYYY-MM-DD.md     — 按日期分割的运行日志
 *
 * 三路输出流程:
 *   Agent stdout → parseLogLine 解析 → ObsidianLogWriter (文件)
 *                                     → LogEventEmitter (WebSocket)
 *                                     → eventBus (DB 持久化)
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

/** 日志级别枚举 */
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'ACTION' | 'FILE' | 'SPAWN' | 'LLM'

/** 日志条目数据结构 */
export interface LogEntry {
  agentId:  string     // Agent UUID
  agentName:string     // Agent 显示名称（用于文件路径）
  runId?:   string     // 可选的 run UUID
  level:    LogLevel   // 日志级别
  content:  string     // 日志内容
  timestamp:Date       // 时间戳
}

/**
 * 结构化日志行正则
 * 期望格式: [2026-03-12T09:34:18Z] [INFO] message content
 * 用于解析 Agent 子进程 stdout 输出
 */
const LOG_PATTERN = /^\[(.+?)\] \[(\w+)\] (.+)$/

/**
 * 解析 Agent 输出的日志行
 * @param line Agent stdout 的一行文本
 * @returns 解析后的日志级别、内容和时间戳，格式不匹配则返回 null
 */
export function parseLogLine(line: string): { level: LogLevel; content: string; ts: Date } | null {
  const m = line.match(LOG_PATTERN)
  if (!m) return null
  return {
    ts:      new Date(m[1]),
    level:   m[2] as LogLevel,
    content: m[3],
  }
}

// ── Obsidian 日志文件写入器 ──────────────────────────────────────

/**
 * Obsidian Vault 日志写入器
 * 职责: 将 Agent 日志追加写入 Obsidian vault 中的 markdown 文件
 *
 * 设计:
 *   - 每个 Agent 每天一个日志文件 (logs/YYYY-MM-DD.md)
 *   - 使用 WriteStream 的 append 模式，避免频繁 open/close
 *   - 文件按 agentName + 日期作为 key 缓存 stream 句柄
 */
export class ObsidianLogWriter {
  /** Obsidian vault 根目录路径 */
  private vaultRoot: string
  /** 已打开的 WriteStream 缓存 (key: "agentName-YYYY-MM-DD") */
  private handles = new Map<string, fs.WriteStream>()

  constructor(vaultRoot = path.join(os.homedir(), 'JwtVault')) {
    this.vaultRoot = vaultRoot
  }

  /** 计算日志文件路径: ~/JwtVault/agent-memory/{agentName}/logs/{date}.md */
  private getPath(agentName: string): string {
    const date = new Date().toISOString().slice(0, 10)
    return path.join(this.vaultRoot, 'agent-memory', agentName, 'logs', `${date}.md`)
  }

  /**
   * 获取或创建指定 Agent 当天的 WriteStream
   * 新文件会自动写入 markdown 标题头
   */
  private getStream(agentName: string): fs.WriteStream {
    const key = `${agentName}-${new Date().toISOString().slice(0, 10)}`
    if (!this.handles.has(key)) {
      const filePath = this.getPath(agentName)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })

      const existed = fs.existsSync(filePath)
      const stream = fs.createWriteStream(filePath, { flags: 'a' })  // append 模式
      if (!existed) {
        const date = new Date().toISOString().slice(0, 10)
        stream.write(`# Agent ${agentName} 日志 — ${date}\n\n`)
      }
      this.handles.set(key, stream)
    }
    return this.handles.get(key)!
  }

  /**
   * 写入一条日志到 markdown 文件
   * 格式: "- [INFO  ] 日志内容"
   */
  write(entry: LogEntry): void {
    const stream = this.getStream(entry.agentName)
    const time   = entry.timestamp.toTimeString().slice(0, 5)
    const badge  = entry.level.padEnd(6)
    stream.write(`- [${badge}] ${entry.content}\n`)
  }

  /** 关闭所有打开的文件流 */
  close(): void {
    for (const stream of this.handles.values()) stream.end()
    this.handles.clear()
  }
}

// ── Agent 记忆写入器 (MEMORY.md + handoff) ──────────────────────

/**
 * Agent 记忆管理器
 * 职责: 管理 Agent 在 Obsidian vault 中的持久化记忆文件
 *
 * 文件结构:
 *   ~/JwtVault/agent-memory/{agentName}/MEMORY.md — 当前工作状态
 *   ~/JwtVault/agent-memory/{agentName}/handoff/{runId}.md — 交接快照
 */
export class MemoryWriter {
  private vaultRoot: string

  constructor(vaultRoot = path.join(os.homedir(), 'JwtVault')) {
    this.vaultRoot = vaultRoot
  }

  /** 获取 Agent 记忆目录路径 */
  private memoryDir(agentName: string): string {
    return path.join(this.vaultRoot, 'agent-memory', agentName)
  }

  /**
   * 写入或覆盖 Agent 的 MEMORY.md
   * @param agentName Agent 名称
   * @param content   markdown 内容
   * @returns 文件绝对路径
   */
  writeMemory(agentName: string, content: string): string {
    const dir = this.memoryDir(agentName)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, 'MEMORY.md')
    fs.writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  /**
   * 读取 Agent 的 MEMORY.md
   * @param agentName Agent 名称
   * @returns markdown 内容，文件不存在则返回 null
   */
  readMemory(agentName: string): string | null {
    const filePath = path.join(this.memoryDir(agentName), 'MEMORY.md')
    try {
      return fs.readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * 写入 handoff 上下文快照
   * 在 Token 耗尽交接时调用，将当前 run 的上下文保存为 markdown 文件
   *
   * @param agentName   Agent 名称
   * @param runId       新 run ID (用作文件名)
   * @param fromRunId   旧 run ID
   * @param tokensUsed  已使用的 token 数
   * @param tokensLimit token 上限
   * @param snapshot    上下文快照键值对（自动格式化为 markdown）
   * @returns 文件绝对路径
   *
   * markdown 格式化规则:
   *   - 数组值 → 列表项
   *   - 对象值 → JSON 代码块
   *   - 其他值 → 纯文本
   */
  writeHandoff(agentName: string, runId: string, fromRunId: string, tokensUsed: number, tokensLimit: number, snapshot: Record<string, unknown>): string {
    const dir = path.join(this.memoryDir(agentName), 'handoff')
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${runId}.md`)
    const now = new Date().toISOString()

    // 将 snapshot 对象格式化为 markdown 内容
    let body = ''
    for (const [key, value] of Object.entries(snapshot)) {
      if (Array.isArray(value)) {
        body += `### ${key}\n`
        for (const item of value) body += `- ${item}\n`
        body += '\n'
      } else if (typeof value === 'object' && value !== null) {
        body += `### ${key}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n\n`
      } else {
        body += `### ${key}\n${value}\n\n`
      }
    }

    const md = `# Handoff — ${agentName}

> Run: ${runId}
> From: ${fromRunId}
> Time: ${now}
> Tokens: ${tokensUsed}/${tokensLimit}

${body}`

    fs.writeFileSync(filePath, md, 'utf-8')
    return filePath
  }
}

// ── 日志事件发射器（内存级，供 WebSocket 订阅） ─────────────────

/** 日志监听器函数签名 */
type LogListener = (entry: LogEntry) => void

/**
 * 日志事件发射器
 * 简单的观察者模式实现，ProcessManager 写入日志时调用 emit()
 * Socket.io 模块通过 on() 订阅后将日志推送给前端
 */
export class LogEventEmitter {
  private listeners: LogListener[] = []

  /** 注册监听器 */
  on(listener: LogListener) { this.listeners.push(listener) }

  /** 移除监听器 */
  off(listener: LogListener) {
    this.listeners = this.listeners.filter(l => l !== listener)
  }

  /** 发射日志事件，通知所有监听器 */
  emit(entry: LogEntry) {
    for (const l of this.listeners) l(entry)
  }
}
