// Agents routes — /api/agents
// GET    /              list agents in server
// POST   /              create agent
// GET    /:id           get agent detail
// PATCH  /:id/activity  update activity status
// POST   /:id/start     start agent (calls daemon)
// POST   /:id/stop      stop agent
// POST   /:id/heartbeat agent heartbeat ping
// GET    /:id/logs      get agent logs (paginated)
// GET    /servers        list servers for current user

import type { FastifyPluginAsync } from 'fastify'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import { cp, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { query, queryOne } from '../db/client.js'
import { processManager, SUPPORTED_RUNTIMES } from '../daemon/process-manager.js'
import type { AgentConfig, RuntimeId } from '../daemon/process-manager.js'
import { initAgentWorkspace, refreshAgentWorkspace } from '../daemon/workspace-init.js'
import { llmClient } from '../daemon/llm-client.js'
import { compactAgentContext } from '../services/context-compaction.js'
import { machineConnectionManager } from '../daemon/machine-connection.js'
import { resolveServerUrl } from '../server-url.js'
import { isWorkspaceInsideAgentsBase, resolveAgentsBaseDir, resolveAgentWorkspacePath } from '../services/agent-workspace.js'

async function readWorkspaceDoc(workspacePath: string | null, relativePath: string) {
  const docPath = join(workspacePath ?? '', relativePath)
  if (!workspacePath) {
    return { path: docPath, content: '', updatedAt: null }
  }

  try {
    const [content, info] = await Promise.all([
      readFile(docPath, 'utf-8'),
      stat(docPath),
    ])
    return { path: docPath, content, updatedAt: info.mtime.toISOString() }
  } catch {
    return { path: docPath, content: '', updatedAt: null }
  }
}

type FrontmatterValue = string | string[]

function stripQuotes(value: string) {
  return value.replace(/^['"]|['"]$/g, '').trim()
}

function parseInlineList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(',')
    .map(part => stripQuotes(part.trim()))
    .filter(Boolean)
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, FrontmatterValue>
  body: string
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { frontmatter: {}, body: content }

  const block = match[1]
  const frontmatter: Record<string, FrontmatterValue> = {}
  const lines = block.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue

    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!entry) continue

    const key = entry[1].toLowerCase()
    const rawValue = entry[2].trim()

    if (!rawValue) {
      const items: string[] = []
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1]
        const listItem = nextLine.match(/^\s*-\s+(.*)$/)
        if (!listItem) break
        items.push(stripQuotes(listItem[1].trim()))
        index += 1
      }
      if (items.length > 0) frontmatter[key] = items
      continue
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      frontmatter[key] = parseInlineList(rawValue)
      continue
    }

    frontmatter[key] = stripQuotes(rawValue)
  }

  return { frontmatter, body: content.slice(match[0].length) }
}

function frontmatterArrayValue(value: FrontmatterValue | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function frontmatterStringValue(value: FrontmatterValue | undefined): string | null {
  if (!value) return null
  return Array.isArray(value) ? value[0] ?? null : value
}

function defaultModelForRuntime(runtime: RuntimeId): string {
  switch (runtime) {
    case 'codex':
      return 'gpt-5.4'
    case 'kimi':
      return 'kimi-code/kimi-for-coding'
    case 'gemini':
      return 'gemini-2.5-flash'
    case 'claude':
    default:
      return 'claude-sonnet-4-6'
  }
}

function normalizeAgentModelId(modelId: string | undefined, _runtime?: string): string | undefined {
  const trimmed = modelId?.trim()
  if (!trimmed) return undefined
  return trimmed
}

function defaultProviderForRuntime(runtime: RuntimeId): string {
  switch (runtime) {
    case 'codex':
      return 'openai'
    case 'kimi':
      return 'moonshot'
    case 'gemini':
      return 'google'
    case 'claude':
    default:
      return 'anthropic'
  }
}

type AgentEdgeBlueprint = {
  from: string
  to: string
  relation_kind: string
  relation_layer: 'tree' | 'graph'
  label: string
}

const DEFAULT_AGENT_EDGE_BLUEPRINTS: AgentEdgeBlueprint[] = [
  { from: 'Donovan', to: 'Donovan-codex', relation_kind: 'assistant', relation_layer: 'tree', label: 'codex copilot' },
  { from: 'Donovan', to: 'Donovan-gemini', relation_kind: 'assistant', relation_layer: 'tree', label: 'gemini copilot' },
  { from: 'Brandeis', to: 'Brandeis-codex', relation_kind: 'assistant', relation_layer: 'tree', label: 'codex executor' },
  { from: 'Brandeis', to: 'Brandeis-gemini', relation_kind: 'assistant', relation_layer: 'tree', label: 'gemini executor' },
  { from: 'Akara', to: 'Akara-codex', relation_kind: 'assistant', relation_layer: 'tree', label: 'codex reviewer' },
  { from: 'Sable-infer', to: 'Sable-kimi', relation_kind: 'assistant', relation_layer: 'tree', label: 'kimi worker' },
  { from: 'Corin-kernel', to: 'Corin-kimi', relation_kind: 'assistant', relation_layer: 'tree', label: 'kimi worker' },
  { from: 'Vega-train', to: 'Vega-kimi', relation_kind: 'assistant', relation_layer: 'tree', label: 'kimi worker' },
  { from: 'Nova-arch', to: 'Nova-kimi', relation_kind: 'assistant', relation_layer: 'tree', label: 'kimi worker' },
  { from: 'Donovan', to: 'Brandeis', relation_kind: 'delegates', relation_layer: 'graph', label: 'execution pipeline' },
  { from: 'Donovan', to: 'Akara', relation_kind: 'delegates', relation_layer: 'graph', label: 'review pipeline' },
  { from: 'Brandeis', to: 'Sable-infer', relation_kind: 'manages', relation_layer: 'graph', label: 'inference lane' },
  { from: 'Brandeis', to: 'Corin-kernel', relation_kind: 'manages', relation_layer: 'graph', label: 'kernel lane' },
  { from: 'Brandeis', to: 'Vega-train', relation_kind: 'manages', relation_layer: 'graph', label: 'training lane' },
  { from: 'Brandeis', to: 'Nova-arch', relation_kind: 'manages', relation_layer: 'graph', label: 'architecture lane' },
  { from: 'Brandeis', to: 'Rhea-test', relation_kind: 'manages', relation_layer: 'graph', label: 'test lane' },
]

async function ensureAgentEdgesSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS agent_edges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      from_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      to_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      relation_kind VARCHAR(32) NOT NULL,
      relation_layer VARCHAR(16) NOT NULL DEFAULT 'graph',
      label TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (relation_layer IN ('tree', 'graph')),
      CHECK (from_agent_id <> to_agent_id)
    )
  `).catch(() => {})
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_edges_unique_relation
      ON agent_edges (server_id, from_agent_id, to_agent_id, relation_kind)
  `).catch(() => {})
  await query(`
    CREATE INDEX IF NOT EXISTS agent_edges_server_from_idx
      ON agent_edges (server_id, from_agent_id)
  `).catch(() => {})
  await query(`
    CREATE INDEX IF NOT EXISTS agent_edges_server_to_idx
      ON agent_edges (server_id, to_agent_id)
  `).catch(() => {})
}

async function seedDefaultAgentEdges(serverId: string) {
  const agents = await query<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE server_id = $1`,
    [serverId]
  )
  if (agents.length === 0) return

  const idByName = new Map(agents.map(agent => [agent.name.toLowerCase(), agent.id]))

  for (const edge of DEFAULT_AGENT_EDGE_BLUEPRINTS) {
    const fromId = idByName.get(edge.from.toLowerCase())
    const toId = idByName.get(edge.to.toLowerCase())
    if (!fromId || !toId) continue

    await query(
      `INSERT INTO agent_edges
         (server_id, from_agent_id, to_agent_id, relation_kind, relation_layer, label, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (server_id, from_agent_id, to_agent_id, relation_kind) DO NOTHING`,
      [
        serverId,
        fromId,
        toId,
        edge.relation_kind,
        edge.relation_layer,
        edge.label,
        JSON.stringify({ seeded: true }),
      ]
    ).catch(() => {})
  }
}

function providerForModel(modelId: string): string {
  if (modelId.startsWith('claude')) return 'anthropic'
  if (modelId.startsWith('gemini')) return 'google'
  if (modelId.startsWith('moonshot') || modelId.startsWith('kimi')) return 'moonshot'
  if (modelId.startsWith('glm')) return 'zhipu'
  if (modelId.startsWith('qwen') || modelId.startsWith('codeplan')) return 'dashscope'
  return 'openai'
}

function runtimeForModel(modelId: string): RuntimeId {
  const provider = providerForModel(modelId)
  if (provider === 'anthropic') return 'claude'
  if (provider === 'google') return 'gemini'
  if (provider === 'moonshot') return 'kimi'
  return 'codex'
}

const DEFAULT_TEAM_CONTEXT = '红虾俱乐部 (Red Shrimp Lab) — multi-agent collaboration system. Team includes human users and AI agents communicating via mcp__chat tools.'

export const agentRoutes: FastifyPluginAsync = async (app) => {
  await query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS note TEXT').catch(() => {})
  await ensureAgentEdgesSchema()
  const agentsBaseDir = resolveAgentsBaseDir()

  if (process.env.OBSIDIAN_ROOT?.trim()) {
    await mkdir(agentsBaseDir, { recursive: true }).catch(() => {})
    const rows = await query<{ id: string; name: string; workspace_path: string | null }>(
      'SELECT id, name, workspace_path FROM agents'
    ).catch(() => [])

    for (const row of rows) {
      const desiredPath = resolveAgentWorkspacePath(row.name)
      const currentPath = row.workspace_path?.trim()
      if (currentPath && isWorkspaceInsideAgentsBase(currentPath, agentsBaseDir) && currentPath === desiredPath) continue

      if (currentPath && currentPath !== desiredPath) {
        await cp(currentPath, desiredPath, { recursive: true, force: false }).catch(() => {})
      }

      await query(
        'UPDATE agents SET workspace_path = $2 WHERE id = $1',
        [row.id, desiredPath]
      ).catch(() => {})
    }
  }

  type AgentControlRow = {
    id: string
    name: string
    description: string | null
    runtime: string
    model_id: string
    machine_id: string | null
    workspace_path: string | null
    session_id: string | null
    reasoning_effort: string | null
    role: string | null
    custom_api_key: string | null
    custom_base_url: string | null
  }

  const readAgentControlRow = async (id: string) =>
    queryOne<AgentControlRow>(
      `SELECT id, name, description, runtime, model_id, machine_id, workspace_path, session_id, reasoning_effort, role, custom_api_key, custom_base_url
       FROM agents
       WHERE id = $1`,
      [id]
    )

  const stopAgentInstance = async (agentId: string) => {
    const daemonMachine = machineConnectionManager.getMachineForAgent(agentId)
    if (daemonMachine) {
      machineConnectionManager.stopAgent(daemonMachine, agentId)
    }
    try {
      await processManager.stop(agentId)
    } catch {
      // The agent may be daemon-backed or already stopped.
    }
    await query(`UPDATE agents SET status = 'offline', activity = NULL WHERE id = $1`, [agentId])
  }

  const resolveMachineName = async (machineId: string | null): Promise<string | undefined> => {
    if (!machineId) return process.env.MACHINE_NAME?.trim() || undefined
    const row = await queryOne<{ name: string }>('SELECT name FROM machines WHERE id = $1', [machineId])
    return row?.name || process.env.MACHINE_NAME?.trim() || undefined
  }

  const startAgentInstance = async (agent: AgentControlRow, serverUrl: string, forceRestart = false) => {
    const connectedMachines = machineConnectionManager.getAll()
    let targetMachineId: string | undefined

    if (agent.machine_id) {
      targetMachineId = agent.machine_id
    } else if (connectedMachines.length > 0) {
      const existingMachine = machineConnectionManager.getMachineForAgent(agent.id)
      if (existingMachine && !forceRestart) {
        await query(
          `UPDATE agents SET status = 'running', last_heartbeat_at = COALESCE(last_heartbeat_at, NOW()) WHERE id = $1`,
          [agent.id]
        )
        return { ok: true, alreadyRunning: true, message: `Agent ${agent.name} is already running on daemon` }
      }
      for (const m of connectedMachines) {
        if (m.runtimes.includes(agent.runtime)) {
          targetMachineId = m.machineId
          break
        }
      }
    }

    const connectedTargetMachine = targetMachineId ? machineConnectionManager.get(targetMachineId) : undefined

    if (targetMachineId && connectedTargetMachine) {
      machineConnectionManager.startAgent(targetMachineId, agent as any, serverUrl)
      await query(`UPDATE agents SET status = 'starting' WHERE id = $1`, [agent.id])
      return { ok: true, message: `Agent ${agent.name} starting on daemon ${targetMachineId}` }
    }

    if (agent.machine_id && targetMachineId && !connectedTargetMachine) {
      // Fallback: if the assigned machine is not connected, try to run locally
      // This is common when the machine daemon disconnected but we're on the same host
      if (!processManager.isRunning(agent.id)) {
        const apiKey = `agent_${agent.id}_${Date.now()}`
        const config: AgentConfig = {
          id:            agent.id,
          name:          agent.name,
          machineId:     agent.machine_id ?? 'local',
          machineName:   await resolveMachineName(agent.machine_id),
          serverUrl,
          apiKey,
          workspacePath: agent.workspace_path ?? process.cwd(),
          runtime:       agent.runtime,
          modelId:       agent.model_id,
          reasoningEffort: agent.reasoning_effort ?? undefined,
          sessionId:     agent.session_id ?? undefined,
          role:          agent.role ?? undefined,
          customApiKey:  agent.custom_api_key ?? undefined,
          customBaseUrl: agent.custom_base_url ?? undefined,
        }
        await processManager.spawn(config)
        await query(`UPDATE agents SET status = 'starting' WHERE id = $1`, [agent.id])
        return { ok: true, message: `Machine ${targetMachineId} not connected — starting ${agent.name} locally as fallback` }
      }
    }

    if (processManager.isRunning(agent.id) && !forceRestart) {
      await query(
        `UPDATE agents SET status = 'running', last_heartbeat_at = COALESCE(last_heartbeat_at, NOW()) WHERE id = $1`,
        [agent.id]
      )
      return { ok: true, alreadyRunning: true, message: `Agent ${agent.name} is already running` }
    }

    const apiKey = `agent_${agent.id}_${Date.now()}`
    const config: AgentConfig = {
      id:            agent.id,
      name:          agent.name,
      machineId:     agent.machine_id ?? 'local',
      machineName:   await resolveMachineName(agent.machine_id),
      serverUrl,
      apiKey,
      workspacePath: agent.workspace_path ?? process.cwd(),
      runtime:       agent.runtime,
      modelId:       agent.model_id,
      reasoningEffort: agent.reasoning_effort ?? undefined,
      sessionId:     agent.session_id ?? undefined,
      role:          agent.role ?? undefined,
      customApiKey:  agent.custom_api_key ?? undefined,
      customBaseUrl: agent.custom_base_url ?? undefined,
    }

    await processManager.spawn(config)
    await query(`UPDATE agents SET status = 'starting' WHERE id = $1`, [agent.id])
    return { ok: true, message: `Agent ${agent.name} starting locally` }
  }

  // ── GET /api/agents ───────────────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const { serverId } = req.query as { serverId?: string }
    const caller = req.user as { sub: string }

    const agents = await query(
      `SELECT a.id, a.name, a.description, a.note, a.model_provider, a.model_id,
              a.runtime, a.reasoning_effort, a.status, a.activity, a.activity_detail,
              a.last_heartbeat_at, a.workspace_path, a.created_at,
              a.role, a.parent_agent_id, a.machine_id, a.current_project_id,
              a.custom_base_url,
              (a.custom_api_key IS NOT NULL) AS has_custom_key,
              m.name AS machine_name, m.hostname AS machine_hostname, m.status AS machine_status,
              p.name AS current_project_name, p.slug AS current_project_slug
       FROM agents a
       LEFT JOIN machines m ON m.id = a.machine_id
       LEFT JOIN projects p ON p.id = a.current_project_id
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE ($2::uuid IS NULL OR a.server_id = $2::uuid)
       ORDER BY CASE a.role
         WHEN 'coordinator' THEN 0
         WHEN 'ops' THEN 1
         WHEN 'tech-lead' THEN 2
         ELSE 3
       END, a.name`,
      [caller.sub, serverId ?? null]
    )
    return agents
  })

  // ── GET /api/agents/hierarchy ────────────────────────────────────
  app.get('/hierarchy', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.query as { serverId?: string }
    const caller = req.user as { sub: string }

    const server = serverId
      ? await queryOne<{ id: string }>(
        `SELECT s.id
         FROM servers s
         JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
         WHERE s.id = $2`,
        [caller.sub, serverId]
      )
      : await queryOne<{ id: string }>(
        `SELECT s.id
         FROM servers s
         JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
         ORDER BY s.created_at
         LIMIT 1`,
        [caller.sub]
      )

    if (!server) return reply.code(404).send({ error: 'Server not found' })

    await seedDefaultAgentEdges(server.id)

    const nodes = await query(
      `SELECT a.id, a.name, a.description, a.note, a.model_provider, a.model_id,
              a.runtime, a.reasoning_effort, a.status, a.activity, a.activity_detail,
              a.last_heartbeat_at, a.workspace_path, a.created_at,
              a.role, a.parent_agent_id, a.machine_id, a.current_project_id,
              a.custom_base_url,
              (a.custom_api_key IS NOT NULL) AS has_custom_key,
              m.name AS machine_name, m.hostname AS machine_hostname, m.status AS machine_status,
              p.name AS current_project_name, p.slug AS current_project_slug
       FROM agents a
       LEFT JOIN machines m ON m.id = a.machine_id
       LEFT JOIN projects p ON p.id = a.current_project_id
       WHERE a.server_id = $1
       ORDER BY CASE a.role
         WHEN 'coordinator' THEN 0
         WHEN 'tech-lead' THEN 1
         WHEN 'ops' THEN 2
         ELSE 3
       END, a.name`,
      [server.id]
    )

    const edges = await query<{
      id: string
      from_agent_id: string
      to_agent_id: string
      relation_kind: string
      relation_layer: 'tree' | 'graph'
      label: string | null
      metadata: Record<string, unknown> | null
    }>(
      `SELECT id, from_agent_id, to_agent_id, relation_kind, relation_layer, label, metadata
       FROM agent_edges
       WHERE server_id = $1
       ORDER BY
         CASE relation_layer WHEN 'tree' THEN 0 ELSE 1 END,
         CASE relation_kind
           WHEN 'assistant' THEN 0
           WHEN 'delegates' THEN 1
           WHEN 'manages' THEN 2
           ELSE 9
         END,
         created_at`,
      [server.id]
    )

    const treeTargets = new Set(
      edges
        .filter(edge => edge.relation_layer === 'tree')
        .map(edge => edge.to_agent_id)
    )
    const roots = nodes
      .filter((node: any) => !treeTargets.has(node.id))
      .map((node: any) => node.id)

    return {
      serverId: server.id,
      nodes,
      edges,
      roots,
    }
  })

  // ── POST /api/agents ──────────────────────────────────────────────
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    let { serverId, machineId, name, description, role, modelId, modelProvider, runtime, workspacePath, systemPrompt, parentAgentId, reasoningEffort, customApiKey, customBaseUrl } =
      req.body as {
        serverId?: string; machineId?: string; name: string; description?: string;
        role?: string; modelId?: string; modelProvider?: string;
        runtime?: string; workspacePath?: string; systemPrompt?: string;
        parentAgentId?: string; reasoningEffort?: string;
        customApiKey?: string; customBaseUrl?: string;
      }

    if (!name?.trim()) return reply.code(400).send({ error: 'name required' })

    const requestedRuntime = runtime?.trim()
    const resolvedModelId = normalizeAgentModelId(modelId, requestedRuntime)
    const resolvedRuntime = (resolvedModelId ? runtimeForModel(resolvedModelId) : (runtime ?? 'codex')) as RuntimeId
    if (!SUPPORTED_RUNTIMES.includes(resolvedRuntime)) {
      return reply.code(400).send({ error: `Unsupported runtime: ${runtime}. Supported: ${SUPPORTED_RUNTIMES.join(', ')}` })
    }

    // Auto-resolve serverId from user's primary server if not provided
    if (!serverId) {
      const server = await queryOne<{ id: string }>(
        `SELECT s.id FROM servers s
         JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
         LIMIT 1`,
        [caller.sub]
      )
      if (!server) return reply.code(400).send({ error: 'No server found for user' })
      serverId = server.id
    }

    machineId = machineId?.trim() || undefined
    if (!machineId) {
      return reply.code(400).send({ error: 'machineId required. Create/connect a machine first, then choose it when creating the agent.' })
    }

    const machine = await queryOne<{ id: string }>(
      `SELECT m.id
       FROM machines m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.user_id = $1
       WHERE m.id = $2 AND m.server_id = $3`,
      [caller.sub, machineId, serverId]
    )
    if (!machine) {
      return reply.code(400).send({ error: 'Machine not found in current server' })
    }

    // Auto-assign workspace path if not provided
    // Default: ~/JwtVault/00_hub/agents/<name>  (vault-based memory)
    const resolvedWorkspace = workspacePath?.trim()
      || resolveAgentWorkspacePath(name)

    // If parentAgentId not provided, default to the first coordinator/ops agent in this server.
    if (!parentAgentId) {
      const manager = await queryOne<{ id: string }>(
        `SELECT id
         FROM agents
         WHERE server_id = $1
           AND role IN ('coordinator', 'ops')
         ORDER BY CASE role WHEN 'coordinator' THEN 0 WHEN 'ops' THEN 1 ELSE 2 END, created_at
         LIMIT 1`,
        [serverId]
      )
      if (manager) parentAgentId = manager.id
    }

    const [agent] = await query(
      `INSERT INTO agents
         (server_id, machine_id, name, description, model_id, model_provider, runtime, workspace_path, role, parent_agent_id, reasoning_effort, custom_api_key, custom_base_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        serverId, machineId ?? null, name.trim(), description ?? null,
        resolvedModelId ?? defaultModelForRuntime(resolvedRuntime),
        resolvedModelId ? providerForModel(resolvedModelId) : defaultProviderForRuntime(resolvedRuntime),
        resolvedRuntime,
        resolvedWorkspace,
        role ?? 'general',
        parentAgentId ?? null,
        reasoningEffort?.trim() || 'medium',
        customApiKey?.trim() || null,
        customBaseUrl?.trim() || null,
      ]
    )

    // Add agent to server's #all channel
    const allChannel = await queryOne<{ id: string }>(
      `SELECT id FROM channels WHERE server_id = $1 AND name = 'all' LIMIT 1`,
      [serverId]
    )
    if (allChannel) {
      await query(
        `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [allChannel.id, agent.id]
      )
    }

    // Initialize workspace with MEMORY / KNOWLEDGE / notes / CLAUDE / HEARTBEAT
    const serverUrl = resolveServerUrl(req)
    const machineName = await resolveMachineName(machineId ?? null)
    initAgentWorkspace(resolvedWorkspace, {
      agentId:      agent.id,
      agentName:    agent.name,
      description:  agent.description ?? null,
      role:         (role as any) ?? 'general',
      modelId:      agent.model_id,
      serverUrl,
      channelName:  '#all',
      teamContext:  DEFAULT_TEAM_CONTEXT,
      customPrompt: systemPrompt ?? undefined,
      machineName,
    }).catch(err => console.error(`[workspace] Init failed for ${agent.name}:`, err.message))

    return { agent }
  })

  // ── POST /api/agents/refresh-core-workspaces ─────────────────────
  app.post('/refresh-core-workspaces', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { restart = true, serverId } = req.body as { restart?: boolean; serverId?: string }
    const serverUrl = resolveServerUrl(req)

    const agents = await query<AgentControlRow & { role: string; server_id: string; status: string }>(
      `SELECT a.id, a.server_id, a.name, a.description, a.role, a.runtime, a.model_id, a.machine_id,
              a.workspace_path, a.session_id, a.reasoning_effort, a.status
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE ($2::uuid IS NULL OR a.server_id = $2::uuid)
       ORDER BY CASE a.role
         WHEN 'coordinator' THEN 0
         WHEN 'tech-lead' THEN 1
         WHEN 'ops' THEN 2
         ELSE 9
       END, a.name`,
      [caller.sub, serverId ?? null]
    )

    const results: Array<{ agentId: string; name: string; role: string; refreshed: boolean; restarted: boolean; message?: string; error?: string }> = []

    for (const agent of agents) {
      try {
        const workspacePath = agent.workspace_path?.trim() || resolveAgentWorkspacePath(agent.name)
        const wasRunning = processManager.isRunning(agent.id) || ['running', 'starting', 'online', 'sleeping'].includes(agent.status)

        if (restart && wasRunning) {
          await stopAgentInstance(agent.id)
          await new Promise(resolve => setTimeout(resolve, 150))
        }

        await refreshAgentWorkspace(workspacePath, {
          agentId: agent.id,
          agentName: agent.name,
          description: agent.description ?? null,
          role: agent.role as any,
          modelId: agent.model_id,
          serverUrl,
          channelName: '#all',
          teamContext: DEFAULT_TEAM_CONTEXT,
          machineName: await resolveMachineName(agent.machine_id ?? null),
        })

        await query('UPDATE agents SET workspace_path = $2 WHERE id = $1', [agent.id, workspacePath]).catch(() => {})

        let restarted = false
        if (restart && wasRunning) {
          const started = await startAgentInstance(agent, serverUrl, true)
          restarted = !!started.ok
        }

        results.push({
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          refreshed: true,
          restarted,
          message: restart && wasRunning ? 'workspace refreshed and agent restarted' : 'workspace refreshed',
        })
      } catch (err: any) {
        results.push({
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          refreshed: false,
          restarted: false,
          error: err.message ?? 'Refresh failed',
        })
      }
    }

    return {
      ok: results.every(item => item.refreshed),
      count: results.length,
      results,
    }
  })

  // ── POST /api/agents/reconnect-all ───────────────────────────────
  app.post('/reconnect-all', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const agents = await query<AgentControlRow>(
      `SELECT a.id, a.name, a.description, a.runtime, a.model_id, a.machine_id,
              a.workspace_path, a.session_id, a.reasoning_effort
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       ORDER BY a.name`,
      [caller.sub]
    )

    const results: Array<{ agentId: string; name: string; ok: boolean; message?: string; error?: string }> = []

    for (const agent of agents) {
      try {
        await stopAgentInstance(agent.id)
        await new Promise(resolve => setTimeout(resolve, 150))
        const started = await startAgentInstance(agent, resolveServerUrl(req), true)
        if (!started.ok) {
          results.push({
            agentId: agent.id,
            name: agent.name,
            ok: false,
            error: started.error ?? started.message ?? 'Reconnect failed',
          })
          continue
        }
        results.push({
          agentId: agent.id,
          name: agent.name,
          ok: true,
          message: started.message,
        })
      } catch (err: any) {
        results.push({
          agentId: agent.id,
          name: agent.name,
          ok: false,
          error: err?.message ?? 'Reconnect failed',
        })
      }
    }

    return {
      ok: results.every(result => result.ok),
      count: results.length,
      results,
    }
  })

  // ── PATCH /api/agents/:id/note ───────────────────────────────────
  app.patch('/:id/note', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { note } = req.body as { note?: string | null }

    const agent = await queryOne<{ id: string }>(
      `SELECT a.id
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE a.id = $2`,
      [caller.sub, id]
    )
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const normalizedNote = note?.trim() ? note.trim() : null
    const [updated] = await query(
      `UPDATE agents SET note = $1 WHERE id = $2 RETURNING id, note`,
      [normalizedNote, id]
    )
    return { agent: updated }
  })

  // ── GET /api/agents/:id ───────────────────────────────────────────
  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await queryOne(
      `SELECT a.*, m.name AS machine_name, m.hostname AS machine_hostname, m.status AS machine_status,
              p.name AS current_project_name, p.slug AS current_project_slug
       FROM agents a
       LEFT JOIN machines m ON m.id = a.machine_id
       LEFT JOIN projects p ON p.id = a.current_project_id
       WHERE a.id = $1`,
      [id]
    )
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    return agent
  })

  // ── GET /api/agents/:id/memory ────────────────────────────────────
  app.get('/:id/memory', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const agent = await queryOne<{ workspace_path: string | null }>(
      `SELECT a.workspace_path
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE a.id = $2`,
      [caller.sub, id]
    )

    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const [memory, knowledge, notesIndex] = await Promise.all([
      readWorkspaceDoc(agent.workspace_path, 'MEMORY.md'),
      readWorkspaceDoc(agent.workspace_path, 'KNOWLEDGE.md'),
      readWorkspaceDoc(agent.workspace_path, 'notes/README.md'),
    ])

    return {
      path: memory.path,
      content: memory.content,
      updatedAt: memory.updatedAt,
      workspacePath: agent.workspace_path,
      memory,
      knowledge,
      notesIndex,
    }
  })

  // ── GET /api/agents/:id/authored-docs ───────────────────────────
  app.get('/:id/authored-docs', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const agent = await queryOne<{ id: string; name: string }>(
      `SELECT a.id, a.name
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE a.id = $2`,
      [caller.sub, id]
    )

    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const authorMention = `@${agent.name}`.toLowerCase()
    const docs: Array<{
      path: string
      title: string
      author: string[]
      date: string | null
      type: string | null
      tags: string[]
      youtube: string | null
      source: string | null
      updatedAt: string | null
    }> = []

    const scanDir = (dir: string, relDir = '') => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

        const absolutePath = join(dir, entry.name)
        const relativePath = relDir ? join(relDir, entry.name) : entry.name

        if (entry.isDirectory()) {
          scanDir(absolutePath, relativePath)
          continue
        }

        if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue

        try {
          const content = readFileSync(absolutePath, 'utf-8')
          const { frontmatter } = parseFrontmatter(content)
          const authors = frontmatterArrayValue(frontmatter.author)
          if (!authors.some(author => author.toLowerCase().includes(authorMention))) continue

          docs.push({
            path: relativePath,
            title: frontmatterStringValue(frontmatter.title) ?? basename(relativePath, '.md'),
            author: authors,
            date: frontmatterStringValue(frontmatter.date),
            type: frontmatterStringValue(frontmatter.type),
            tags: frontmatterArrayValue(frontmatter.tags),
            youtube: frontmatterStringValue(frontmatter.youtube),
            source: frontmatterStringValue(frontmatter.source),
            updatedAt: statSync(absolutePath).mtime.toISOString(),
          })
        } catch {
          // Skip unreadable files.
        }
      }
    }

    scanDir(vaultRoot)

    docs.sort((left, right) => {
      const leftDate = left.date ? Date.parse(left.date) : 0
      const rightDate = right.date ? Date.parse(right.date) : 0
      if (leftDate !== rightDate) return rightDate - leftDate
      return left.title.localeCompare(right.title)
    })

    return { docs }
  })

  // ── GET /api/agents/:id/todos ─────────────────────────────────────
  app.get('/:id/todos', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const agent = await queryOne<{ id: string }>(
      `SELECT a.id
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE a.id = $2`,
      [caller.sub, id]
    )

    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const todos = await query(
      `SELECT t.id,
              t.channel_id,
              c.name AS channel_name,
              t.title,
              t.number,
              t.status,
              t.claimed_by_id,
              t.claimed_by_name,
              t.claimed_at,
              t.completed_at,
              t.created_at,
              COALESCE(
                json_agg(
                  DISTINCT jsonb_build_object(
                    'id', td.id,
                    'doc_path', td.doc_path,
                    'doc_name', td.doc_name,
                    'status', td.status
                  )
                ) FILTER (WHERE td.id IS NOT NULL),
                '[]'
              ) AS docs
       FROM tasks t
       JOIN channels c ON c.id = t.channel_id
       LEFT JOIN task_documents td ON td.task_id = t.id
       WHERE t.claimed_by_id = $1
       GROUP BY t.id, c.name
       ORDER BY
         CASE t.status
           WHEN 'claimed' THEN 0
           WHEN 'in_progress' THEN 1
           WHEN 'reviewing' THEN 2
           WHEN 'open' THEN 3
           WHEN 'completed' THEN 4
           ELSE 5
         END,
         t.number`,
      [id]
    )

    return { todos }
  })

  // ── PATCH /api/agents/:id/activity ───────────────────────────────
  app.patch('/:id/activity', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const { activity, activityDetail } = req.body as {
      activity: string; activityDetail?: string
    }

    const [agent] = await query(
      `UPDATE agents SET activity = $1, activity_detail = $2 WHERE id = $3 RETURNING id, activity, activity_detail`,
      [activity, activityDetail ?? null, id]
    )
    return { agent }
  })

  // ── PATCH /api/agents/:id/model ─────────────────────────────────
  app.patch('/:id/model', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const { modelId } = req.body as { modelId: string }
    if (!modelId?.trim()) return { error: 'modelId required' }
    const provider = providerForModel(modelId)
    const [agent] = await query(
      `UPDATE agents SET model_id = $1, model_provider = $2 WHERE id = $3 RETURNING id, model_id, model_provider`,
      [modelId.trim(), provider, id]
    )
    return { agent }
  })

  // ── POST /api/agents/:id/start ────────────────────────────────────
  app.post('/:id/start', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await readAgentControlRow(id)

    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const started = await startAgentInstance(agent, resolveServerUrl(req))
    if (!started.ok) return reply.code(409).send(started)
    return started
  })

  // ── POST /api/agents/:id/stop ─────────────────────────────────────
  app.post('/:id/stop', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    await stopAgentInstance(id)
    return { ok: true }
  })

  // ── POST /api/agents/:id/restart ──────────────────────────────────
  // Stop the agent (if running), then immediately start it fresh.
  app.post('/:id/restart', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await readAgentControlRow(id)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    await stopAgentInstance(id)
    // Brief pause to let process fully terminate
    await new Promise(resolve => setTimeout(resolve, 200))
    const started = await startAgentInstance(agent, resolveServerUrl(req), true)
    if (!started.ok) return reply.code(409).send(started)
    return started
  })

  // ── POST /api/agents/:id/heartbeat ────────────────────────────────
  // Called by the Agent process itself every 30s
  app.post('/:id/heartbeat', async (req) => {
    const { id } = req.params as { id: string }
    const { tokenUsage } = req.body as { tokenUsage?: number }

    await query(
      `UPDATE agents SET last_heartbeat_at = NOW() WHERE id = $1`,
      [id]
    )

    // Track token usage for handoff threshold monitoring
    if (tokenUsage !== undefined) {
      await query(
        `UPDATE agent_runs SET tokens_used = $1
         WHERE agent_id = $2 AND status = 'running'
         ORDER BY started_at DESC LIMIT 1`,
        [tokenUsage, id]
      )
    }

    return { ok: true }
  })
  // ── POST /api/agents/:id/reset-context ───────────────────────────
  // Summarize current context into MEMORY.md, then stop the agent so it
  // restarts fresh with the condensed memory on next start.
  app.post('/:id/reset-context', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const agent = await queryOne<{
      id: string; name: string; workspace_path: string | null; model_id: string;
    }>('SELECT id, name, workspace_path, model_id FROM agents WHERE id = $1', [id])
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const result = await compactAgentContext(
      agent.id, agent.name, agent.workspace_path ?? '', agent.model_id
    )

    // Stop the agent process (it will reload from fresh MEMORY.md on next start)
    try { await processManager.stop(id) } catch { /* already stopped */ }
    await query(`UPDATE agents SET status = 'offline', activity = NULL WHERE id = $1`, [id])

    return { ok: true, tokensUsed: result.tokensUsed }
  })

  // ── DELETE /api/agents/:id ────────────────────────────────────────
  app.delete('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    // Verify ownership (agent must belong to caller's server)
    const rows = await query(
      `SELECT a.id, a.workspace_path, a.status FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
       WHERE a.id = $2`,
      [caller.sub, id]
    )
    if (!rows.length) return reply.code(404).send({ error: 'not found' })

    const agent = rows[0] as { id: string; workspace_path: string | null; status: string }

    // Stop if running
    try { await processManager.stop(id) } catch { /* already stopped */ }

    // Delete DB records (logs and runs cascade via FK)
    await query(`DELETE FROM agent_logs WHERE agent_id = $1`, [id])
    await query(`DELETE FROM agent_runs WHERE agent_id = $1`, [id])
    await query(`DELETE FROM agents WHERE id = $1`, [id])

    return { ok: true }
  })

  // ── GET /api/agents/:id/logs ──────────────────────────────────────
  app.get('/:id/logs', { preHandler: [app.authenticate] }, async (req) => {
    const { id } = req.params as { id: string }
    const { limit = '100', before } = req.query as { limit?: string; before?: string }

    const lim = Math.min(Number(limit), 500)
    let rows

    if (before) {
      rows = await query(
        `SELECT * FROM agent_logs WHERE agent_id = $1 AND created_at < $2
         ORDER BY created_at DESC LIMIT $3`,
        [id, before, lim]
      )
    } else {
      rows = await query(
        `SELECT * FROM agent_logs WHERE agent_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [id, lim]
      )
    }

    return { logs: rows.reverse() }
  })
}
