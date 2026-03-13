// Red Shrimp Lab — Scheduler
// Responsibilities:
//   1. Run user-defined cron jobs (stored in DB `cron_jobs` table)
//   2. Heartbeat monitor — detect offline agents (>90s no ping)
//   3. Token exhaustion monitor — trigger handoff at >90% of limit
//
// Inspired by nanobot's HEARTBEAT.md pattern: a lightweight "nervous system"
// that watches all agents and takes corrective action without human input.

import cron from 'node-cron'
import { query, queryOne } from '../db/client.js'
import { processManager } from './process-manager.js'
import {
  emitAgentOffline,
  emitTokenHandoff,
  eventBus,
} from './events.js'
import { llmClient } from './llm-client.js'
import { heartbeatChecker } from './heartbeat-checker.js'
import { machineConnectionManager } from './machine-connection.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CronJobRow {
  id: string
  agent_id: string
  agent_name: string
  cron_expr: string
  prompt: string
  channel_id: string | null
  model_override: string | null
  enabled: boolean
}

interface AgentRunRow {
  id: string
  agent_id: string
  tokens_used: number
  tokens_limit: number
  status: string
  context_snapshot: Record<string, unknown> | null
}

// ─── Scheduler class ─────────────────────────────────────────────────────────

class Scheduler {
  // node-cron task handles keyed by cron_job.id
  private cronHandles = new Map<string, cron.ScheduledTask>()

  // Intervals for built-in monitors
  private heartbeatTimer: NodeJS.Timeout | null = null
  private tokenTimer: NodeJS.Timeout | null = null

  // ── Wire process-manager event → DB status updates ───────────────────────
  private wireEventListeners() {
    eventBus.on('agent:started', async (e) => {
      await query(`UPDATE agents SET status = 'running', pid = $2, last_heartbeat_at = NOW() WHERE id = $1`, [e.agentId, e.payload.pid ?? null])
    })
    eventBus.on('agent:stopped', async (e) => {
      await query(`UPDATE agents SET status = 'offline', pid = NULL WHERE id = $1`, [e.agentId])
    })
    eventBus.on('agent:crashed', async (e) => {
      await query(`UPDATE agents SET status = 'crashed', pid = NULL WHERE id = $1`, [e.agentId])
    })
    eventBus.on('agent:offline', async (e) => {
      await query(`UPDATE agents SET status = 'offline', pid = NULL WHERE id = $1`, [e.agentId])
    })
  }

  // ── Start all subsystems ───────────────────────────────────────────────────
  async start() {
    console.log('[scheduler] Starting...')

    // Wire event listeners before auto-starting agents
    this.wireEventListeners()

    // Auto-start agents that were previously running (local machine only)
    await this.autoStartAgents()

    // Start HEARTBEAT.md file-based heartbeat checker (nanobot-style)
    heartbeatChecker.start()

    // Load & schedule all enabled cron jobs from DB
    await this.reloadCronJobs()

    // Re-sync cron jobs every 5 minutes (picks up DB changes)
    cron.schedule('*/5 * * * *', () => this.reloadCronJobs())

    // Heartbeat monitor: every 60 seconds
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 60_000)

    // Token monitor: every 2 minutes
    this.tokenTimer = setInterval(() => this.checkTokenUsage(), 120_000)

    console.log('[scheduler] Running.')
  }

  // ── Auto-start local agents on boot ───────────────────────────────────────
  private async autoStartAgents() {
    const agents = await query<{
      id: string; name: string; runtime: string; model_id: string;
      workspace_path: string | null; machine_id: string | null; pid: number | null;
    }>(
      `SELECT id, name, runtime, model_id, workspace_path, machine_id, pid
       FROM agents
       WHERE status IN ('running', 'online', 'starting')
         AND (machine_id IS NULL)
       ORDER BY created_at`
    )

    if (agents.length === 0) return
    console.log(`[scheduler] Auto-starting ${agents.length} local agent(s)...`)

    const serverUrl = process.env.SERVER_URL
      ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 3001}`

    for (const agent of agents) {
      // If a PID is recorded, check if that process is still alive — skip if so
      if (agent.pid) {
        try {
          process.kill(agent.pid, 0)  // signal 0 = existence check only
          console.log(`[scheduler] Agent ${agent.name} still alive (pid ${agent.pid}), skipping spawn`)
          continue
        } catch {
          // Process is dead, proceed to re-spawn
        }
      }

      // Skip if a remote daemon machine is already managing this agent
      const remoteMachine = machineConnectionManager.getMachineForAgent(agent.id)
      if (remoteMachine) {
        console.log(`[scheduler] Agent ${agent.name} managed by remote machine ${remoteMachine}, skipping local spawn`)
        continue
      }

      try {
        const apiKey = `agent_${agent.id}_${Date.now()}`
        await processManager.spawn({
          id:            agent.id,
          name:          agent.name,
          machineId:     'local',
          serverUrl,
          apiKey,
          workspacePath: agent.workspace_path ?? process.cwd(),
          runtime:       agent.runtime,
          modelId:       agent.model_id,
        })
        console.log(`[scheduler] Auto-started: ${agent.name}`)
      } catch (err: any) {
        console.error(`[scheduler] Failed to auto-start ${agent.name}: ${err.message}`)
        await query(`UPDATE agents SET status = 'offline', pid = NULL WHERE id = $1`, [agent.id])
      }
    }
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  stop() {
    for (const [id, task] of this.cronHandles) {
      task.stop()
      this.cronHandles.delete(id)
    }
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.tokenTimer)    clearInterval(this.tokenTimer)
    console.log('[scheduler] Stopped.')
  }

  // ─── Cron job management ──────────────────────────────────────────────────

  async reloadCronJobs() {
    const jobs = await query<CronJobRow>(
      `SELECT cj.*, a.name AS agent_name
       FROM cron_jobs cj
       JOIN agents a ON a.id = cj.agent_id
       WHERE cj.enabled = true`
    )

    const activeIds = new Set(jobs.map(j => j.id))

    // Remove stale handles (jobs disabled or deleted)
    for (const [id, task] of this.cronHandles) {
      if (!activeIds.has(id)) {
        task.stop()
        this.cronHandles.delete(id)
        console.log(`[scheduler] Removed cron job ${id}`)
      }
    }

    // Add new jobs
    for (const job of jobs) {
      if (this.cronHandles.has(job.id)) continue  // already running

      if (!cron.validate(job.cron_expr)) {
        console.warn(`[scheduler] Invalid cron expr for job ${job.id}: "${job.cron_expr}"`)
        continue
      }

      const task = cron.schedule(job.cron_expr, () => this.runCronJob(job), {
        timezone: 'Asia/Shanghai',
      })
      this.cronHandles.set(job.id, task)
      console.log(`[scheduler] Scheduled job ${job.id} (${job.agent_name}): ${job.cron_expr}`)
    }
  }

  private async runCronJob(job: CronJobRow) {
    console.log(`[scheduler] Running cron job ${job.id} for agent ${job.agent_name}`)

    try {
      // Create a run record for this scheduled invocation
      const [run] = await query(
        `INSERT INTO agent_runs (agent_id, status)
         VALUES ($1, 'running') RETURNING id`,
        [job.agent_id]
      )

      // Dispatch to LLM with the job's prompt
      const response = await llmClient.complete({
        model: job.model_override ?? undefined,
        prompt: job.prompt,
        agentId: job.agent_id,
        runId: run.id,
      })

      // If a channelId is set, post the response as an agent message
      if (job.channel_id && response.text) {
        await this.postMessage(job.agent_id, job.channel_id, response.text)
      }

      await query(
        `UPDATE agent_runs SET status = 'completed', tokens_used = $1, ended_at = NOW()
         WHERE id = $2`,
        [response.tokensUsed, run.id]
      )
    } catch (err: any) {
      console.error(`[scheduler] Cron job ${job.id} failed:`, err.message)
    }
  }

  // ─── Heartbeat monitor ────────────────────────────────────────────────────

  private async checkHeartbeats() {
    // Agents that are 'running' but haven't pinged in >90 seconds
    const stale = await query<{ id: string; name: string }>(
      `SELECT id, name FROM agents
       WHERE status = 'running'
         AND last_heartbeat_at < NOW() - INTERVAL '90 seconds'`
    )

    for (const agent of stale) {
      console.warn(`[scheduler] Agent ${agent.name} (${agent.id}) heartbeat timeout — marking offline`)

      await query(
        `UPDATE agents SET status = 'offline' WHERE id = $1`,
        [agent.id]
      )

      emitAgentOffline(agent.id, agent.name, 'heartbeat_timeout')

      // Attempt auto-restart via process manager
      processManager.scheduleRestart(agent.id)
    }
  }

  // ─── Token exhaustion monitor ─────────────────────────────────────────────
  // When an active run uses >90% of its token limit, save context snapshot
  // and schedule a handoff to a fresh agent instance.

  private async checkTokenUsage() {
    const exhausted = await query<AgentRunRow>(
      `SELECT ar.*, a.name AS agent_name
       FROM agent_runs ar
       JOIN agents a ON a.id = ar.agent_id
       WHERE ar.status = 'running'
         AND ar.tokens_limit > 0
         AND ar.tokens_used::float / ar.tokens_limit > 0.90`
    )

    for (const run of exhausted) {
      console.log(`[scheduler] Token handoff triggered for run ${run.id} (${run.tokens_used}/${run.tokens_limit})`)

      await this.triggerHandoff(run)
    }
  }

  private async triggerHandoff(run: AgentRunRow) {
    // Mark current run as 'handoff'
    await query(
      `UPDATE agent_runs
       SET status = 'handoff', ended_at = NOW()
       WHERE id = $1`,
      [run.id]
    )

    // Fetch current context snapshot
    const snapshot = run.context_snapshot ?? {}

    // Create successor run linked to same agent
    const [newRun] = await query(
      `INSERT INTO agent_runs (agent_id, parent_run_id, tokens_limit, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [run.agent_id, run.id, run.tokens_limit]
    )

    emitTokenHandoff(run.agent_id, run.id, newRun.id, snapshot)

    // Signal process manager to restart with fresh context
    processManager.scheduleHandoff(run.agent_id, newRun.id, snapshot)
  }

  // ─── Helper: post a message to a channel as an agent ──────────────────────

  private async postMessage(agentId: string, channelId: string, content: string) {
    const agent = await queryOne<{ name: string }>(
      'SELECT name FROM agents WHERE id = $1', [agentId]
    )
    const agentName = agent?.name ?? 'agent'

    const seqRow = await queryOne<{ last_seq: string }>(
      `INSERT INTO channel_sequences (channel_id, last_seq) VALUES ($1, 1)
       ON CONFLICT (channel_id) DO UPDATE SET last_seq = channel_sequences.last_seq + 1
       RETURNING last_seq`,
      [channelId]
    )
    const seq = Number(seqRow?.last_seq ?? 1)

    await query(
      `INSERT INTO messages (channel_id, sender_id, sender_type, sender_name, content, seq)
       VALUES ($1, $2, 'agent', $3, $4, $5)`,
      [channelId, agentId, agentName, content, seq]
    )
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const scheduler = new Scheduler()
