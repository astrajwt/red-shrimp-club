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
  emitTokenHandoff,
  eventBus,
} from './events.js'
import { llmClient } from './llm-client.js'
import { heartbeatChecker } from './heartbeat-checker.js'
import { machineConnectionManager } from './machine-connection.js'
import { resolveServerUrl } from '../server-url.js'
import { createStoredMessage } from '../services/message-store.js'
import { compactAgentContext } from '../services/context-compaction.js'

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
  agent_name?: string
  tokens_used: number
  tokens_limit: number
  status: string
  context_snapshot: Record<string, unknown> | null
}

interface ReviewReminderRow {
  server_id: string
  owner_user_id: string
  owner_name: string
  akara_id: string
  reviewing_count: number | string
}

const REVIEW_REMINDER_CHECK_MS = 5 * 60_000
const REVIEW_REMINDER_COOLDOWN_MS = 30 * 60_000

// ─── Scheduler class ─────────────────────────────────────────────────────────

class Scheduler {
  // node-cron task handles keyed by cron_job.id
  private cronHandles = new Map<string, cron.ScheduledTask>()

  // Intervals for built-in monitors
  private tokenTimer: NodeJS.Timeout | null = null
  private reviewReminderTimer: NodeJS.Timeout | null = null
  private reviewReminderState = new Map<string, { count: number; sentAt: number }>()

  // Guard: prevent concurrent handoffs for the same agent
  private handoffInProgress = new Set<string>()

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

    // Token monitor: every 2 minutes
    this.tokenTimer = setInterval(() => this.checkTokenUsage(), 120_000)

    // Review backlog reminders: every 5 minutes, Akara DMs the owner on changes
    this.reviewReminderTimer = setInterval(() => {
      void this.checkReviewBacklogReminders()
    }, REVIEW_REMINDER_CHECK_MS)

    console.log('[scheduler] Running.')
  }

  // ── Auto-start local agents on boot ───────────────────────────────────────
  // Slock-style: only truly running agents get restarted. Sleeping agents stay
  // sleeping and will wake on the next delivered message.
  private async autoStartAgents() {
    // First: register sleeping agents in process-manager so deliverMessage can wake them
    const sleepingAgents = await query<{
      id: string; name: string; runtime: string; model_id: string;
      workspace_path: string | null; machine_id: string | null;
      reasoning_effort: string | null; session_id: string | null;
    }>(
      `SELECT id, name, runtime, model_id, workspace_path, machine_id, reasoning_effort, session_id
       FROM agents
       WHERE status = 'sleeping'
       ORDER BY created_at`
    )

    const serverUrl = resolveServerUrl()

    for (const agent of sleepingAgents) {
      // Register in process-manager as sleeping (no process spawned)
      processManager.registerSleeping({
        id:            agent.id,
        name:          agent.name,
        machineId:     'local',
        serverUrl,
        apiKey:        `agent_${agent.id}_${Date.now()}`,
        workspacePath: agent.workspace_path ?? process.cwd(),
        runtime:       agent.runtime as any,
        modelId:       agent.model_id,
        reasoningEffort: agent.reasoning_effort ?? undefined,
        sessionId:     agent.session_id ?? undefined,
      })
      console.log(`[scheduler] Registered sleeping agent: ${agent.name} (will wake on message)`)
    }

    // Then: auto-start agents that were actually running (had an active process)
    const agents = await query<{
      id: string; name: string; runtime: string; model_id: string;
      workspace_path: string | null; machine_id: string | null; pid: number | null;
      reasoning_effort: string | null; session_id: string | null;
    }>(
      `SELECT id, name, runtime, model_id, workspace_path, machine_id, pid, reasoning_effort, session_id
       FROM agents
       WHERE status IN ('running', 'online', 'starting', 'offline')
       ORDER BY created_at`
    )

    if (agents.length === 0 && sleepingAgents.length === 0) return
    if (agents.length > 0) console.log(`[scheduler] Auto-starting ${agents.length} local agent(s)...`)

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
          reasoningEffort: agent.reasoning_effort ?? undefined,
          sessionId:     agent.session_id ?? undefined,
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
    if (this.tokenTimer)    clearInterval(this.tokenTimer)
    if (this.reviewReminderTimer) clearInterval(this.reviewReminderTimer)
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
      // Skip if handoff already in progress for this agent
      if (this.handoffInProgress.has(run.agent_id)) {
        console.log(`[scheduler] Handoff already in progress for agent ${run.agent_id}, skipping`)
        continue
      }

      console.log(`[scheduler] Token handoff triggered for run ${run.id} (${run.tokens_used}/${run.tokens_limit})`)
      await this.triggerHandoff(run)
    }
  }

  private async triggerHandoff(run: AgentRunRow) {
    this.handoffInProgress.add(run.agent_id)
    try {
      await this._doHandoff(run)
    } finally {
      this.handoffInProgress.delete(run.agent_id)
    }
  }

  private async _doHandoff(run: AgentRunRow) {
    // Persist context to MEMORY.md before handoff
    try {
      const agent = await queryOne<{
        name: string; workspace_path: string | null; model_id: string
      }>(
        'SELECT name, workspace_path, model_id FROM agents WHERE id = $1',
        [run.agent_id]
      )
      if (agent?.workspace_path) {
        console.log(`[scheduler] Compacting context for ${agent.name} before handoff...`)
        await compactAgentContext(
          run.agent_id, agent.name, agent.workspace_path, agent.model_id
        )
        console.log(`[scheduler] Context compacted for ${agent.name}`)
      }
    } catch (err: any) {
      console.error(`[scheduler] Context compaction failed for run ${run.id}: ${err.message}`)
    }

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

  private async checkReviewBacklogReminders() {
    const rows = await query<ReviewReminderRow>(
      `SELECT s.id AS server_id,
              owner_member.user_id AS owner_user_id,
              owner_user.name AS owner_name,
              akara.id AS akara_id,
              (
                SELECT COUNT(*)::int
                FROM tasks t
                JOIN channels c ON c.id = t.channel_id
                WHERE c.server_id = s.id
                  AND t.status = 'reviewing'
              ) AS reviewing_count
       FROM servers s
       JOIN server_members owner_member
         ON owner_member.server_id = s.id
        AND owner_member.role = 'owner'
       JOIN users owner_user ON owner_user.id = owner_member.user_id
       JOIN LATERAL (
         SELECT a.id
         FROM agents a
         WHERE a.server_id = s.id
           AND LOWER(a.name) = 'akara'
         ORDER BY a.created_at
         LIMIT 1
       ) akara ON true`
    )

    for (const row of rows) {
      const reviewingCount = Number(row.reviewing_count ?? 0)
      const stateKey = `${row.server_id}:${row.owner_user_id}`

      if (reviewingCount <= 0) {
        this.reviewReminderState.delete(stateKey)
        continue
      }

      const previous = this.reviewReminderState.get(stateKey)
      const now = Date.now()
      const shouldSend = !previous
        || previous.count !== reviewingCount
        || now - previous.sentAt >= REVIEW_REMINDER_COOLDOWN_MS

      if (!shouldSend) continue

      const dmChannelId = await this.ensureHumanAgentDm(row.server_id, row.owner_user_id, row.akara_id)
      await this.postMessage(
        row.akara_id,
        dmChannelId,
        `还有 ${reviewingCount} 件 task 在 review，等你处理。`
      )

      this.reviewReminderState.set(stateKey, {
        count: reviewingCount,
        sentAt: now,
      })
    }
  }

  private async ensureHumanAgentDm(serverId: string, userId: string, agentId: string) {
    const existing = await queryOne<{ id: string }>(
      `SELECT c.id
       FROM channels c
       JOIN channel_members human_member
         ON human_member.channel_id = c.id
        AND human_member.user_id = $2
       JOIN channel_members agent_member
         ON agent_member.channel_id = c.id
        AND agent_member.agent_id = $3
       WHERE c.server_id = $1
         AND c.type = 'dm'
       LIMIT 1`,
      [serverId, userId, agentId]
    )
    if (existing?.id) return existing.id

    const [channel] = await query<{ id: string }>(
      `INSERT INTO channels (server_id, name, type)
       VALUES ($1, $2, 'dm')
       RETURNING id`,
      [serverId, `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
    )

    await query(
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)`,
      [channel.id, userId]
    )
    await query(
      `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2)`,
      [channel.id, agentId]
    )

    return channel.id
  }

  // ─── Helper: post a message to a channel as an agent ──────────────────────

  private async postMessage(agentId: string, channelId: string, content: string) {
    const agent = await queryOne<{ name: string }>(
      'SELECT name FROM agents WHERE id = $1', [agentId]
    )
    const agentName = agent?.name ?? 'agent'
    await createStoredMessage({
      channelId,
      senderId: agentId,
      senderType: 'agent',
      senderName: agentName,
      content,
    })
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const scheduler = new Scheduler()
