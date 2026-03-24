import { query } from '../db/client.js'
import { processManager } from '../daemon/process-manager.js'
import { machineConnectionManager } from '../daemon/machine-connection.js'
import { emitAgentLog } from '../daemon/events.js'
import type { AgentConfig } from '../daemon/process-manager.js'
import { resolveServerUrl } from '../server-url.js'

interface DeliverableMessage {
  channel_name: string
  channel_type: string
  sender_name: string
  sender_type: string
  content: string
  timestamp: string
}

export async function notifyAgentMembers(params: {
  channelId: string
  senderId: string
  senderName: string
  senderType: string
  content: string
  timestamp: string | Date
}): Promise<void> {
  const rows = await query<{
    agent_id: string
    agent_name: string
    role: string
    machine_id: string | null
    status: string
    runtime: string
    model_id: string
    workspace_path: string | null
    reasoning_effort: string | null
    session_id: string | null
    channel_name: string
    channel_type: string
  }>(
    `SELECT a.id AS agent_id,
            a.name AS agent_name,
            a.role,
            a.machine_id,
            a.status,
            a.runtime,
            a.model_id,
            a.workspace_path,
            a.reasoning_effort,
            a.session_id,
            c.name AS channel_name,
            c.type AS channel_type
       FROM channel_members cm
       JOIN agents a ON a.id = cm.agent_id
       JOIN channels c ON c.id = cm.channel_id
      WHERE cm.channel_id = $1
        AND a.id != $2`,
    [params.channelId, params.senderId]
  )

  if (rows.length === 0) return

  const message: DeliverableMessage = {
    channel_name: rows[0].channel_name,
    channel_type: rows[0].channel_type,
    sender_name: params.senderName,
    sender_type: params.senderType,
    content: params.content,
    timestamp: typeof params.timestamp === 'string'
      ? params.timestamp
      : params.timestamp.toISOString(),
  }

  // @mention detection: check which agents are explicitly mentioned
  // Use [\w-]+ to match agent names with hyphens (e.g. Brandeis-codex, Sable-infer)
  const mentionPattern = /@([\w-]+)/g
  const mentions = [...params.content.matchAll(mentionPattern)].map(m => m[1].toLowerCase())
  const agentNames = new Set(rows.map(r => r.agent_name.toLowerCase()))
  const mentionedAgents = new Set(mentions.filter(m => agentNames.has(m)))
  const hasAtAll = mentions.includes('all')

  for (const row of rows) {
    const isDM = row.channel_type === 'dm'
    const isMentioned = isDM || hasAtAll || mentionedAgents.has(row.agent_name.toLowerCase())

    // Non-DM channels: if not @mentioned (and no @all), completely skip — agent won't see this message
    if (!isMentioned) {
      continue
    }

    const pmStatus = processManager.getStatus(row.agent_id)

    // Always deliver to @mentioned/DM agents
    const connectedMachineId = machineConnectionManager.getMachineForAgent(row.agent_id)
    if (connectedMachineId) {
      emitAgentLog(row.agent_id, 'INFO', `[投递] 通过远程机器 ${connectedMachineId} 投递消息给 ${row.agent_name}`)
      machineConnectionManager.deliverMessage(connectedMachineId, row.agent_id, message)
      continue
    }

    // Build spawn config helper (shared by local and machine-assigned paths)
    const buildConfig = (): AgentConfig => ({
      id: row.agent_id,
      name: row.agent_name,
      machineId: row.machine_id ?? 'local',
      serverUrl: resolveServerUrl(),
      apiKey: `agent_${row.agent_id}_${Date.now()}`,
      workspacePath: row.workspace_path ?? process.cwd(),
      runtime: row.runtime as AgentConfig['runtime'],
      modelId: row.model_id,
      reasoningEffort: row.reasoning_effort ?? undefined,
      sessionId: row.session_id ?? undefined,
      role: row.role ?? undefined,
    })

    if (!row.machine_id) {
      if (pmStatus === null) {
        // Agent not in process manager — always try to spawn when @mentioned
        // (covers 'sleeping', 'error', 'inactive', etc. — explicit @mention = intent to wake)
        emitAgentLog(row.agent_id, 'INFO', `[投递] ${row.agent_name} 未在进程管理器中 (DB status=${row.status}) → 注册并启动`)
        await processManager.spawn(buildConfig(), message).catch((err) => {
          emitAgentLog(row.agent_id, 'ERROR', `[投递] ${row.agent_name} 启动失败: ${err.message}`)
        })
        continue
      }
      emitAgentLog(row.agent_id, 'INFO', `[投递] 本地投递消息给 ${row.agent_name} (pm_status=${pmStatus})`)
      processManager.deliverMessage(row.agent_id, message)
    } else {
      // Machine assigned but not connected via WebSocket — fall back to local process manager
      const connectedRemotely = false // already checked above via machineConnectionManager
      if (pmStatus === null) {
        emitAgentLog(row.agent_id, 'INFO', `[投递] ${row.agent_name} 机器 ${row.machine_id} 未连接 (DB status=${row.status})，本地启动`)
        await processManager.spawn(buildConfig(), message).catch((err) => {
          emitAgentLog(row.agent_id, 'ERROR', `[投递] ${row.agent_name} 启动失败: ${err.message}`)
        })
      } else if (pmStatus) {
        emitAgentLog(row.agent_id, 'INFO', `[投递] 本地投递消息给 ${row.agent_name} (pm_status=${pmStatus})`)
        processManager.deliverMessage(row.agent_id, message)
      }
    }
  }
}
