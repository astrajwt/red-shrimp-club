import { query, queryOne } from '../db/client.js'

export interface HierarchyAgentRecord {
  id: string
  name: string
  server_id: string
  parent_agent_id: string | null
}

export interface AgentDelegationContext {
  agent: HierarchyAgentRecord
  agentsById: Map<string, HierarchyAgentRecord>
  descendantIds: Set<string>
  hasReports: boolean
}

function normalizeAgentRef(value?: string | null): string {
  return value?.trim().replace(/^@+/, '').toLowerCase() ?? ''
}

function buildAgentsById(agents: HierarchyAgentRecord[]) {
  return new Map(agents.map(agent => [agent.id, agent]))
}

function findAgentByRef(agents: HierarchyAgentRecord[], rawRef?: string | null): HierarchyAgentRecord | null {
  const ref = rawRef?.trim()
  if (!ref) return null

  const byId = agents.find(agent => agent.id === ref)
  if (byId) return byId

  const normalized = normalizeAgentRef(ref)
  if (!normalized) return null
  return agents.find(agent => normalizeAgentRef(agent.name) === normalized) ?? null
}

function collectDescendantIds(agents: HierarchyAgentRecord[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, HierarchyAgentRecord[]>()
  for (const agent of agents) {
    if (!agent.parent_agent_id) continue
    const siblings = childrenByParent.get(agent.parent_agent_id) ?? []
    siblings.push(agent)
    childrenByParent.set(agent.parent_agent_id, siblings)
  }

  const descendants = new Set<string>()
  const stack = [...(childrenByParent.get(rootId) ?? [])]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || descendants.has(current.id)) continue
    descendants.add(current.id)
    stack.push(...(childrenByParent.get(current.id) ?? []))
  }
  return descendants
}

export async function resolveServerScopedAgent(serverId: string, rawAgentId?: string | null) {
  const agentRef = rawAgentId?.trim()
  if (!agentRef) throw new Error('assigneeAgentId is required')

  const agents = await query<HierarchyAgentRecord>(
    `SELECT id, name, server_id, parent_agent_id
     FROM agents
     WHERE server_id = $1`,
    [serverId]
  )
  const agent = findAgentByRef(agents, agentRef)
  if (!agent) throw new Error(`Assignee agent not found in this server: ${agentRef}`)
  return agent
}

export async function loadAgentDelegationContext(agentId: string): Promise<AgentDelegationContext> {
  const agent = await queryOne<HierarchyAgentRecord>(
    `SELECT id, name, server_id, parent_agent_id
     FROM agents
     WHERE id = $1`,
    [agentId]
  )
  if (!agent) throw new Error('Agent not found')

  const agents = await query<HierarchyAgentRecord>(
    `SELECT id, name, server_id, parent_agent_id
     FROM agents
     WHERE server_id = $1`,
    [agent.server_id]
  )

  const descendantIds = collectDescendantIds(agents, agent.id)
  return {
    agent,
    agentsById: buildAgentsById(agents),
    descendantIds,
    hasReports: descendantIds.size > 0,
  }
}

export function resolveDelegatedAssignee(
  ctx: AgentDelegationContext,
  rawAssigneeId?: string | null,
  fieldLabel = 'assignee_agent_id'
): HierarchyAgentRecord {
  const assigneeRef = rawAssigneeId?.trim()
  if (!assigneeRef) return ctx.agent

  const assignee = findAgentByRef([...ctx.agentsById.values()], assigneeRef)
  if (!assignee) {
    throw new Error(`Assignee agent not found in this server: ${assigneeRef}`)
  }
  return assignee
}
