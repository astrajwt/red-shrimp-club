// HeartbeatChecker — 基于 nanobot 设计的两阶段心跳系统
// Phase 1 (MVP): 直接检查 HEARTBEAT.md 中的 - [ ] checkbox
// Phase 2: 加 LLM 决策层（便宜模型判断 skip/run）

import { readFile } from 'fs/promises'
import { join } from 'path'
import { query } from '../db/client.js'
import { emitAgentLog } from './events.js'

interface AgentRow {
  id: string
  name: string
  workspace_path: string
  heartbeat_interval_minutes: number
  last_heartbeat_check: Date | null
}

export class HeartbeatChecker {
  private timer: NodeJS.Timeout | null = null
  private readonly checkIntervalMs: number

  constructor(checkIntervalMs = 30 * 60 * 1000) {
    this.checkIntervalMs = checkIntervalMs
  }

  start() {
    // Run once immediately on start, then on interval
    this.tick()
    this.timer = setInterval(() => this.tick(), this.checkIntervalMs)
    console.log(`[heartbeat] Checker started (every ${this.checkIntervalMs / 60000}min)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // Allow manual trigger (e.g. from API)
  async triggerNow(agentId?: string) {
    await this.tick(agentId)
  }

  private async tick(filterAgentId?: string) {
    try {
      const agents = await query<AgentRow>(
        `SELECT id, name, workspace_path, heartbeat_interval_minutes
         FROM agents
         WHERE workspace_path IS NOT NULL
           AND status NOT IN ('error')
           ${filterAgentId ? 'AND id = $1' : ''}`,
        filterAgentId ? [filterAgentId] : []
      )

      for (const agent of agents) {
        try {
          await this.checkAgent(agent)
        } catch (err: any) {
          console.error(`[heartbeat] Check failed for ${agent.name}: ${err.message}`)
        }
      }
    } catch (err: any) {
      console.error('[heartbeat] tick error:', err.message)
    }
  }

  private async checkAgent(agent: AgentRow) {
    const heartbeatPath = join(agent.workspace_path, 'HEARTBEAT.md')

    let content: string
    try {
      content = await readFile(heartbeatPath, 'utf-8')
    } catch {
      return // File doesn't exist, skip silently
    }

    // Phase 1: simple check — any unchecked items?
    const pendingItems = content
      .split('\n')
      .filter(l => /^- \[ \]/.test(l.trim()))

    if (pendingItems.length === 0) return

    const summary = pendingItems.map(l => l.replace(/^- \[ \]\s*/, '').trim()).join('; ')
    emitAgentLog(agent.id, 'INFO',
      `[heartbeat] ${pendingItems.length} pending task(s): ${summary}`)

    // Record that we checked
    await query(
      `UPDATE agents SET last_heartbeat_at = NOW() WHERE id = $1`,
      [agent.id]
    )

    // Note: actual spawn happens via CronRunner or manual trigger
    // HeartbeatChecker just detects and logs — ProcessManager decides if/when to spawn
    // This avoids duplicate spawns if agent is already running
    console.log(`[heartbeat] Agent ${agent.name} has ${pendingItems.length} pending heartbeat task(s)`)
  }
}

export const heartbeatChecker = new HeartbeatChecker()
