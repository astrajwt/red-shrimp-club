// Daemon WebSocket — /daemon/connect?key=<api-key>
// redshrimp-daemon machines connect here to spawn and manage agent processes.
// Protocol (from daemon):  ready | agent:status | agent:activity | agent:session | agent:trajectory | agent:deliver:ack | pong
// Protocol (to daemon):    agent:start | agent:stop | agent:sleep | agent:deliver | ping

import type { FastifyPluginAsync } from 'fastify'
import { createHash } from 'crypto'
import { query, queryOne } from '../db/client.js'
import { machineConnectionManager } from '../daemon/machine-connection.js'
import { emitAgentLog } from '../daemon/events.js'
import { pushThinking } from '../services/thinking-buffer.js'
import { processManager } from '../daemon/process-manager.js'
import { resolveServerUrl } from '../server-url.js'

function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex')
}

export const daemonSocketRoutes: FastifyPluginAsync = async (app) => {
  app.get('/daemon/connect', { websocket: true }, (socket, req) => {
    const { key } = req.query as { key?: string }

    // Buffer messages until setup is complete
    const messageQueue: string[] = []
    let setupDone = false

    // Register message handler IMMEDIATELY (before any async operations)
    // to avoid losing messages sent right after connection
    socket.on('message', (rawData: Buffer | string) => {
      const str = Buffer.isBuffer(rawData) ? rawData.toString() : String(rawData)
      if (!setupDone) {
        messageQueue.push(str)
      } else {
        handleMessage(str)
      }
    })

    // Named handler function (defined after setup)
    let handleMessage = (_str: string) => {}

    // Async setup (runs after message handler is registered)
    const setup = async () => {
      if (!key) {
        socket.close(4001, 'API key required')
        return
      }

      // Verify machine API key
      const machine = await queryOne<{ id: string; server_id: string; name: string }>(
        'SELECT id, server_id, name FROM machines WHERE api_key_hash = $1',
        [hashKey(key)]
      )

      if (!machine) {
        socket.close(4003, 'Invalid API key')
        return
      }

      const machineId = machine.id
      const serverUrl = resolveServerUrl(req)

      // Register connection
      const machineState = machineConnectionManager.add(machineId, machine.server_id, socket as any)
      await query(
        `UPDATE machines SET status = 'online', last_seen_at = NOW() WHERE id = $1`,
        [machineId]
      )
      console.log(`[daemon-ws] Machine "${machine.name}" (${machineId}) connected`)

      // Ping every 30s to keep connection alive
      const pingInterval = setInterval(() => {
        if ((socket as any).readyState === 1 /* OPEN */) {
          socket.send(JSON.stringify({ type: 'ping' }))
        }
      }, 30_000)

      // Define the actual message handler
      handleMessage = async (str: string) => {
        let msg: any
        try {
          msg = JSON.parse(str)
        } catch { return }
        try {

        switch (msg.type) {
          case 'ready': {
            if (msg.hostname || msg.os || msg.daemonVersion) {
              await query(
                `UPDATE machines SET hostname = COALESCE($2, hostname), os = COALESCE($3, os),
                 daemon_version = COALESCE($4, daemon_version) WHERE id = $1`,
                [machineId, msg.hostname ?? null, msg.os ?? null, msg.daemonVersion ?? null]
              )
            }
            machineState.runtimes = msg.runtimes ?? []
            machineState.hostname = msg.hostname
            machineState.os = msg.os
            machineState.daemonVersion = msg.daemonVersion

            // Record already-running agents and sync DB status
            for (const agentId of (msg.runningAgents ?? []) as string[]) {
              machineState.agents.set(agentId, { status: 'active' })
              await query(
                `UPDATE agents SET status = 'running', last_heartbeat_at = NOW() WHERE id = $1`,
                [agentId]
              ).catch(() => {})
            }

            console.log(`[daemon-ws] Machine "${machine.name}" ready. Runtimes: [${machineState.runtimes.join(', ')}]`)
            await startAgentsOnMachine(machineId, machine.server_id, serverUrl, machineState.agents)
            break
          }

          case 'agent:status': {
            const { agentId, status } = msg
            const existing = machineState.agents.get(agentId) ?? { status: 'inactive' }
            existing.status = status
            machineState.agents.set(agentId, existing)

            const dbStatus = status === 'active' ? 'running' : status === 'sleeping' ? 'idle' : 'offline'
            await query(`UPDATE agents SET status = $1 WHERE id = $2`, [dbStatus, agentId])
            if (dbStatus !== 'offline') {
              await query(`UPDATE agents SET last_heartbeat_at = NOW() WHERE id = $1`, [agentId])
            }
            console.log(`[daemon-ws] Agent ${agentId}: ${status} → DB ${dbStatus}`)
            break
          }

          case 'agent:activity': {
            const { agentId, activity, detail } = msg
            await query(
              `UPDATE agents SET activity = $1, activity_detail = $2 WHERE id = $3`,
              [activity ?? null, detail ?? null, agentId]
            ).catch(() => {})
            break
          }

          case 'agent:session': {
            const { agentId, sessionId } = msg
            const existing = machineState.agents.get(agentId) ?? { status: 'inactive' }
            existing.sessionId = sessionId
            machineState.agents.set(agentId, existing)
            await query(`UPDATE agents SET session_id = $1 WHERE id = $2`, [sessionId ?? null, agentId]).catch(() => {})
            break
          }

          case 'agent:deliver:ack':
            break

          case 'agent:trajectory': {
            const { agentId, entries } = msg as {
              agentId: string
              entries: Array<{ kind: string; text?: string; toolName?: string; toolInput?: string; activity?: string; detail?: string }>
            }
            if (!Array.isArray(entries)) break
            for (const entry of entries) {
              let level = 'INFO'
              let content = ''
              if (entry.kind === 'thinking') {
                level = 'INFO'; content = `[thinking] ${entry.text ?? ''}`
                pushThinking(agentId, entry.text ?? '')
              } else if (entry.kind === 'text') {
                level = 'INFO'; content = entry.text ?? ''
              } else if (entry.kind === 'tool_start') {
                level = 'ACTION'; content = `[tool] ${entry.toolName ?? ''}${entry.toolInput ? ': ' + entry.toolInput : ''}`
              } else if (entry.kind === 'status') {
                level = 'INFO'; content = `[status] ${entry.activity ?? ''}${entry.detail ? ' — ' + entry.detail : ''}`
              } else {
                content = JSON.stringify(entry)
              }
              if (content.trim()) {
                emitAgentLog(agentId, level, content)
              }
            }
            break
          }

          case 'pong': {
            // Update last_heartbeat_at for all active agents on this machine
            const activeIds = [...machineState.agents.entries()]
              .filter(([, s]) => s.status === 'active')
              .map(([id]) => id)
            if (activeIds.length > 0) {
              await query(
                `UPDATE agents SET last_heartbeat_at = NOW() WHERE id = ANY($1::uuid[])`,
                [activeIds]
              ).catch(() => {})
            }
            break
          }

          default:
            console.log(`[daemon-ws] Unknown message from ${machine.name}: ${msg.type}`)
        }
        } catch (err: any) {
          console.error(`[daemon-ws] Error handling ${msg?.type} from ${machine.name}:`, err.message)
        }
      }

      // Process buffered messages
      setupDone = true
      for (const queuedMsg of messageQueue) {
        await handleMessage(queuedMsg)
      }
      messageQueue.length = 0

      socket.on('close', async () => {
        clearInterval(pingInterval)
        // Only remove if this socket is still the current connection
        // (avoids race when daemon reconnects before old socket closes)
        const current = machineConnectionManager.get(machineId)
        if (current?.ws === (socket as any)) {
          machineConnectionManager.remove(machineId)
          await query(`UPDATE machines SET status = 'offline' WHERE id = $1`, [machineId])
          // Only mark agents that are actually bound to this machine as offline
          await query(
            `UPDATE agents SET status = 'offline'
             WHERE machine_id = $1 AND status IN ('running', 'idle', 'online')`,
            [machineId]
          ).catch(() => {})
          console.log(`[daemon-ws] Machine "${machine.name}" (${machineId}) disconnected`)
        } else {
          console.log(`[daemon-ws] Stale socket closed for "${machine.name}" (replaced by newer connection)`)
        }
      })

      socket.on('error', (err: Error) => {
        console.error(`[daemon-ws] Machine "${machine.name}" socket error:`, err.message)
      })
    }

    setup().catch((err) => {
      console.error('[daemon-ws] Setup error:', err.message)
      socket.close(1011, 'Internal error')
    })
  })
}

// Start all agents for a server on a connected machine daemon
async function startAgentsOnMachine(
  machineId: string,
  serverId: string,
  serverUrl: string,
  runningAgents: Map<string, { status: string }>
) {
  const agents = await query<{
    id: string; name: string; description: string | null; model_id: string; runtime: string; reasoning_effort: string; session_id: string | null;
  }>(
    `SELECT id, name, description, model_id, runtime, reasoning_effort, session_id FROM agents
     WHERE server_id = $1
       AND (machine_id = $2 OR machine_id IS NULL)
     ORDER BY name`,
    [serverId, machineId]
  )

  if (agents.length === 0) {
    console.log(`[daemon-ws] No agents to start on machine ${machineId}`)
    return
  }

  console.log(`[daemon-ws] Starting ${agents.length} agent(s) on machine ${machineId}`)
  for (const agent of agents) {
    if (processManager.isRunning(agent.id)) {
      await processManager.stop(agent.id).catch(() => {})
      console.log(`[daemon-ws] Stopped local process for ${agent.name} before daemon handoff`)
    }
    // Skip if this daemon already reports it as active
    if (runningAgents.get(agent.id)?.status === 'active') {
      console.log(`[daemon-ws] Agent ${agent.name} already active on this machine, skipping`)
      continue
    }
    // Skip if ANY other connected machine already has this agent active
    const existingMachine = machineConnectionManager.getMachineForAgent(agent.id)
    if (existingMachine && existingMachine !== machineId) {
      console.log(`[daemon-ws] Agent ${agent.name} already active on machine ${existingMachine}, skipping`)
      continue
    }
    machineConnectionManager.startAgent(machineId, agent, serverUrl)
    console.log(`[daemon-ws] Sent agent:start for ${agent.name} (${agent.id})`)
  }
}
