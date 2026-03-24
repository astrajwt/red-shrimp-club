// Red Shrimp Lab — Scheduler
// Responsibilities:
//   1. Run user-defined cron jobs (stored in DB `cron_jobs` table)
//   2. Token exhaustion monitor — compact at >80%, handoff at >90% of limit
//
import cron from 'node-cron'
import { query, queryOne } from '../db/client.js'
import { processManager } from './process-manager.js'
import {
  emitTokenHandoff,
  eventBus,
} from './events.js'
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

// Task reminder: remind agents about stale in_progress / rejected tasks
const TASK_REMINDER_CHECK_MS  = 10 * 60_000   // check every 10 min
const TASK_REMINDER_COOLDOWN_MS = 30 * 60_000  // re-remind per task at most once per 30 min
const TASK_STALE_MS = 30 * 60_000              // task counts as stale after 30 min idle

// ─── Scheduler class ─────────────────────────────────────────────────────────

class Scheduler {
  // node-cron task handles keyed by cron_job.id
  private cronHandles = new Map<string, cron.ScheduledTask>()
  private cronSignatures = new Map<string, string>()

  // Intervals for built-in monitors
  private tokenTimer: NodeJS.Timeout | null = null
  private reviewReminderTimer: NodeJS.Timeout | null = null
  private reviewReminderState = new Map<string, { count: number; sentAt: number }>()
  private taskReminderTimer: NodeJS.Timeout | null = null
  // cooldown: keyed by task id → last reminder sent timestamp
  private taskReminderState = new Map<string, number>()

  // Guard: prevent concurrent handoffs for the same agent
  private handoffInProgress = new Set<string>()
  // Guard: track runs that have already been compacted at 80% (avoid re-compacting every 2min)
  private compactedRuns = new Set<string>()
  // Guard: prevent concurrent compaction for the same agent
  private compactionInProgress = new Set<string>()

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

    // Load & schedule all enabled cron jobs from DB
    await this.reloadCronJobs()

    // Re-sync cron jobs every 5 minutes (picks up DB changes)
    cron.schedule('*/5 * * * *', () => this.reloadCronJobs())

    // Token monitor: every 2 minutes
    this.tokenTimer = setInterval(() => this.checkTokenUsage(), 120_000)

    // Review backlog reminders: disabled
    // this.reviewReminderTimer = setInterval(() => {
    //   void this.checkReviewBacklogReminders()
    // }, REVIEW_REMINDER_CHECK_MS)

    // Task reminders: periodically remind agents about stale in_progress tasks
    this.taskReminderTimer = setInterval(() => {
      void this.checkTaskReminders()
    }, TASK_REMINDER_CHECK_MS)

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
    if (this.taskReminderTimer)   clearInterval(this.taskReminderTimer)
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
        this.cronSignatures.delete(id)
        console.log(`[scheduler] Removed cron job ${id}`)
      }
    }

    // Add or refresh jobs
    for (const job of jobs) {
      const signature = [
        job.agent_id,
        job.cron_expr,
        job.prompt,
        job.channel_id ?? '',
        job.model_override ?? '',
      ].join('::')

      const existing = this.cronHandles.get(job.id)
      const previousSignature = this.cronSignatures.get(job.id)
      if (existing && previousSignature === signature) continue

      if (existing) {
        existing.stop()
        this.cronHandles.delete(job.id)
        this.cronSignatures.delete(job.id)
        console.log(`[scheduler] Rescheduled cron job ${job.id}`)
      }

      if (!cron.validate(job.cron_expr)) {
        console.warn(`[scheduler] Invalid cron expr for job ${job.id}: "${job.cron_expr}"`)
        continue
      }

      const task = cron.schedule(job.cron_expr, () => this.runCronJob(job), {
        timezone: 'Asia/Shanghai',
      })
      this.cronHandles.set(job.id, task)
      this.cronSignatures.set(job.id, signature)
      console.log(`[scheduler] Scheduled job ${job.id} (${job.agent_name}): ${job.cron_expr}`)
    }
  }

  private async runCronJob(job: CronJobRow) {
    console.log(`[scheduler] Running cron job ${job.id} for agent ${job.agent_name}`)

    try {
      const channelId = await this.resolveCronChannel(job)
      const senderId = '00000000-0000-0000-0000-00000000c001'
      const senderName = 'chrono'
      const content = job.prompt.trim()

      if (!content) {
        console.warn(`[scheduler] Cron job ${job.id} skipped: empty prompt`)
        return
      }

      const msg = await createStoredMessage({
        channelId,
        senderId,
        senderType: 'human',
        senderName,
        content,
        mentions: [],
        attachments: [],
        thinking: null,
      })

      console.log(
        `[scheduler] Delivered cron job ${job.id} to channel ${channelId} as message ${msg.id}`
      )
    } catch (err: any) {
      console.error(`[scheduler] Cron job ${job.id} failed:`, err.message)
    }
  }

  private async resolveCronChannel(job: CronJobRow): Promise<string> {
    if (job.channel_id) return job.channel_id

    const context = await queryOne<{
      server_id: string
      owner_user_id: string | null
      all_channel_id: string | null
    }>(
      `SELECT a.server_id,
              owner_member.user_id AS owner_user_id,
              all_channel.id AS all_channel_id
         FROM agents a
         LEFT JOIN server_members owner_member
           ON owner_member.server_id = a.server_id
          AND owner_member.role = 'owner'
         LEFT JOIN channels all_channel
           ON all_channel.server_id = a.server_id
          AND all_channel.name = 'all'
        WHERE a.id = $1
        LIMIT 1`,
      [job.agent_id]
    )

    if (!context?.server_id) {
      throw new Error(`Agent ${job.agent_id} has no server context`)
    }

    if (context.owner_user_id) {
      return this.ensureHumanAgentDm(context.server_id, context.owner_user_id, job.agent_id)
    }

    if (context.all_channel_id) return context.all_channel_id

    throw new Error(`No channel available for cron job ${job.id}`)
  }

  // ─── Token exhaustion monitor ─────────────────────────────────────────────
  // When an active run uses >90% of its token limit, save context snapshot
  // and schedule a handoff to a fresh agent instance.

  private async checkTokenUsage() {
    // ── 80% threshold: compact context (no handoff) ──────────────────────
    const needsCompaction = await query<AgentRunRow & { workspace_path: string | null; model_id: string }>(
      `SELECT ar.*, a.name AS agent_name, a.workspace_path, a.model_id
       FROM agent_runs ar
       JOIN agents a ON a.id = ar.agent_id
       WHERE ar.status = 'running'
         AND ar.tokens_limit > 0
         AND ar.tokens_used::float / ar.tokens_limit > 0.80
         AND ar.tokens_used::float / ar.tokens_limit <= 0.90`
    )

    for (const run of needsCompaction) {
      if (this.compactedRuns.has(run.id)) continue
      if (this.compactionInProgress.has(run.agent_id)) continue
      if (this.handoffInProgress.has(run.agent_id)) continue
      if (!run.workspace_path) continue

      this.compactionInProgress.add(run.agent_id)
      try {
        console.log(`[scheduler] 80% token threshold — compacting context for ${run.agent_name} (${run.tokens_used}/${run.tokens_limit})`)
        await compactAgentContext(run.agent_id, run.agent_name!, run.workspace_path, run.model_id)
        this.compactedRuns.add(run.id)
        console.log(`[scheduler] Context compacted for ${run.agent_name} at 80%`)
      } catch (err: any) {
        console.error(`[scheduler] 80% compaction failed for ${run.agent_name}: ${err.message}`)
      } finally {
        this.compactionInProgress.delete(run.agent_id)
      }
    }

    // ── 90% threshold: handoff (restart with fresh context) ──────────────
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

      // Clean up compaction tracking for this run (it's about to be replaced)
      this.compactedRuns.delete(run.id)

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

  // ─── Task reminder monitor ────────────────────────────────────────────────
  // Periodically finds stale in_progress tasks whose assigned agent is idle,
  // then DMs the agent a reminder (with rejection feedback if present).

  private async checkTaskReminders() {
    interface StaleTaskRow {
      id: string
      number: number
      title: string
      status: string
      review_feedback: string | null
      agent_id: string
      agent_name: string
      agent_status: string
      server_id: string
      owner_user_id: string | null
    }

    const staleThreshold = new Date(Date.now() - TASK_STALE_MS).toISOString()

    const tasks = await query<StaleTaskRow>(
      `SELECT t.id, t.number, t.title, t.status, t.review_feedback,
              a.id AS agent_id, a.name AS agent_name, a.status AS agent_status,
              a.server_id,
              owner_member.user_id AS owner_user_id
         FROM tasks t
         JOIN agents a ON a.id = t.claimed_by_id
         JOIN channels ch ON ch.id = t.channel_id
         JOIN servers s ON s.id = ch.server_id
         LEFT JOIN server_members owner_member
           ON owner_member.server_id = s.id AND owner_member.role = 'owner'
        WHERE t.status = 'in_progress'
          AND t.claimed_by_type = 'agent'
          AND COALESCE(t.review_feedback_at, t.started_at, t.claimed_at, t.created_at) < $1`,
      [staleThreshold]
    )

    const now = Date.now()

    for (const task of tasks) {
      // Skip if we sent a reminder recently (cooldown)
      const lastSent = this.taskReminderState.get(task.id) ?? 0
      if (now - lastSent < TASK_REMINDER_COOLDOWN_MS) continue

      // Only remind sleeping/offline agents — running agents are already working
      if (!['sleeping', 'offline', 'stopped'].includes(task.agent_status)) continue

      // Build reminder message
      let content = `📌 任务提醒：#t${task.number} "${task.title}" 还在 in_progress 状态，请继续完成。`
      if (task.review_feedback) {
        content += `\n\n上次驳回理由：${task.review_feedback}`
      }
      content += `\n\n完成后请将状态改为 in_review，等待人类 review。`

      try {
        // Send reminder as chrono (system) to the task's channel, @mentioning the agent
        // This way: agent receives it via normal delivery, human doesn't see random DMs
        const reminderContent = `@${task.agent_name} ${content}`
        const channelId = task.server_id
          ? (await queryOne<{ id: string }>(
              `SELECT channel_id AS id FROM tasks WHERE id = $1`, [task.id]
            ))?.id ?? null
          : null

        if (!channelId) continue

        // Post as chrono (scheduler system identity)
        await createStoredMessage({
          channelId,
          senderId: '00000000-0000-0000-0000-00000000c001',
          senderType: 'human',
          senderName: 'chrono',
          content: reminderContent,
        })
        this.taskReminderState.set(task.id, now)

        console.log(`[scheduler] Sent task reminder to ${task.agent_name} for #t${task.number}`)
      } catch (err: any) {
        console.error(`[scheduler] Task reminder failed for task ${task.id}: ${err.message}`)
      }
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
      `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [channel.id, userId]
    )
    await query(
      `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
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
