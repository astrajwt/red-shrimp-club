// Machine Connection Manager
// Tracks active redshrimp-daemon WebSocket connections and provides
// commands: agent:start/stop/sleep/deliver, workspace ops, ping

import type { WebSocket } from '@fastify/websocket'

interface AgentState {
  status: 'active' | 'sleeping' | 'inactive'
  sessionId?: string
}

export interface MachineState {
  machineId: string
  ws: WebSocket
  serverId: string
  hostname?: string
  os?: string
  daemonVersion?: string
  runtimes: string[]               // e.g. ['claude', 'codex']
  agents: Map<string, AgentState>
}

class MachineConnectionManager {
  private machines = new Map<string, MachineState>()

  add(machineId: string, serverId: string, ws: WebSocket): MachineState {
    const state: MachineState = {
      machineId,
      serverId,
      ws,
      runtimes: [],
      agents: new Map(),
    }
    this.machines.set(machineId, state)
    return state
  }

  remove(machineId: string) {
    this.machines.delete(machineId)
  }

  get(machineId: string): MachineState | undefined {
    return this.machines.get(machineId)
  }

  send(machineId: string, msg: unknown) {
    const state = this.machines.get(machineId)
    if (state?.ws.readyState === 1 /* OPEN */) {
      state.ws.send(JSON.stringify(msg))
    }
  }

  /** Send agent:start to daemon — starts or resumes an agent */
  startAgent(machineId: string, agent: {
    id: string; name: string; description?: string | null;
    model_id: string; runtime: string; reasoning_effort?: string; session_id?: string | null;
  }, serverUrl: string) {
    const state = this.machines.get(machineId)
    if (!state) return

    const existingState = state.agents.get(agent.id)
    const config: Record<string, unknown> = {
      name: agent.name,
      displayName: agent.name,
      description: agent.description ?? undefined,
      model: agent.model_id,
      runtime: agent.runtime || 'claude',
      reasoningEffort: agent.reasoning_effort || undefined,
      serverUrl,
    }
    const resumeSessionId = existingState?.sessionId || agent.session_id || undefined
    if (resumeSessionId) {
      config.sessionId = resumeSessionId
    }

    this.send(machineId, { type: 'agent:start', agentId: agent.id, config })
  }

  /** Stop agent gracefully */
  stopAgent(machineId: string, agentId: string) {
    this.send(machineId, { type: 'agent:stop', agentId })
  }

  /** Hibernate agent — kill process but keep session resumable */
  sleepAgent(machineId: string, agentId: string) {
    this.send(machineId, { type: 'agent:sleep', agentId })
  }

  /** Deliver a new message to an agent (wakes sleeping agents too) */
  deliverMessage(machineId: string, agentId: string, message: {
    channel_name: string; channel_type: string;
    sender_name: string; sender_type: string;
    content: string; timestamp: string;
  }) {
    const seq = Date.now()
    this.send(machineId, { type: 'agent:deliver', agentId, message, seq })
  }

  /** Reset agent workspace files */
  resetWorkspace(machineId: string, agentId: string) {
    this.send(machineId, { type: 'agent:reset-workspace', agentId })
  }

  /** List agent workspace file tree */
  listWorkspace(machineId: string, agentId: string, dirPath = '.') {
    this.send(machineId, { type: 'agent:workspace:list', agentId, dirPath })
  }

  /** Read a file from agent workspace */
  readWorkspaceFile(machineId: string, agentId: string, path: string, requestId: string) {
    this.send(machineId, { type: 'agent:workspace:read', agentId, path, requestId })
  }

  /** Scan all agent workspaces on machine */
  scanWorkspaces(machineId: string) {
    this.send(machineId, { type: 'machine:workspace:scan' })
  }

  /** Find which machine (if any) is responsible for an agent */
  getMachineForAgent(agentId: string): string | undefined {
    for (const [machineId, state] of this.machines) {
      if (state.agents.has(agentId)) return machineId
    }
    return undefined
  }

  /** Get runtimes available on a machine */
  getRuntimes(machineId: string): string[] {
    return this.machines.get(machineId)?.runtimes ?? []
  }

  /** Get all runtimes across all connected machines */
  getAllRuntimes(): string[] {
    const set = new Set<string>()
    for (const state of this.machines.values()) {
      for (const r of state.runtimes) set.add(r)
    }
    return [...set]
  }

  getAll(): MachineState[] {
    return [...this.machines.values()]
  }
}

export const machineConnectionManager = new MachineConnectionManager()
