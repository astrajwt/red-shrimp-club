import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { query, queryOne } from '../db/client.js'

const AGENT_PROJECT_BLOCK_START = '<!-- redshrimp:project-context:start -->'
const AGENT_PROJECT_BLOCK_END = '<!-- redshrimp:project-context:end -->'
const DONOVAN_PROJECT_BLOCK_START = '<!-- redshrimp:project-registry:start -->'
const DONOVAN_PROJECT_BLOCK_END = '<!-- redshrimp:project-registry:end -->'

type ProjectRow = {
  id: string
  server_id: string
  slug: string
  name: string
  summary: string | null
  owner_agent_id: string | null
  owner_agent_name: string | null
  maintained_by_agent_id: string | null
  maintained_by_agent_name: string | null
  default_machine_id: string | null
  default_machine_name: string | null
  default_machine_hostname: string | null
  created_at: string
  updated_at: string
}

type ProjectLocationRow = {
  id: string
  project_id: string
  machine_id: string | null
  machine_name: string | null
  machine_hostname: string | null
  machine_label: string | null
  root_path: string
  notes: string | null
  is_primary: boolean
  created_at: string
  updated_at: string
}

type ProjectAssignmentRow = {
  id: string
  project_id: string
  agent_id: string
  agent_name: string
  agent_role: string | null
  responsibility: string | null
  is_owner: boolean
  created_at: string
  updated_at: string
}

export type ProjectLocation = ProjectLocationRow
export type ProjectAssignment = ProjectAssignmentRow

export type ProjectRecord = ProjectRow & {
  locations: ProjectLocation[]
  assignments: ProjectAssignment[]
}

type AgentWorkspaceRow = {
  id: string
  name: string
  role: string | null
  workspace_path: string | null
  current_project_id: string | null
}

function slugifyProject(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'project'
}

function replaceManagedBlock(content: string, startMarker: string, endMarker: string, blockBody: string) {
  const block = `${startMarker}\n${blockBody.trim()}\n${endMarker}`
  const start = content.indexOf(startMarker)
  const end = content.indexOf(endMarker)

  if (start !== -1 && end !== -1 && end > start) {
    return `${content.slice(0, start).trimEnd()}\n\n${block}\n${content.slice(end + endMarker.length).trimStart()}`.trimEnd() + '\n'
  }

  return `${content.trimEnd()}\n\n${block}\n`
}

async function writeWorkspaceFile(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
}

async function readWorkspaceMemory(path: string) {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return '# Agent\n\n## Role\n\n## Key Knowledge\n\n## Active Context\n'
  }
}

function machineDisplay(location: ProjectLocation) {
  return location.machine_hostname || location.machine_name || location.machine_label || 'unmapped machine'
}

function renderProjectRegistry(projects: ProjectRecord[]) {
  const lines = [
    '# Project Registry',
    '',
    'Donovan maintains the canonical mapping between project names, machine roots, and responsible agents.',
    '',
  ]

  if (projects.length === 0) {
    lines.push('- No projects registered yet.')
    lines.push('')
    return lines.join('\n')
  }

  for (const project of projects) {
    lines.push(`## ${project.name}`)
    lines.push(`- slug: ${project.slug}`)
    lines.push(`- owner: ${project.owner_agent_name ?? 'unassigned'}`)
    lines.push(`- maintained by: ${project.maintained_by_agent_name ?? 'Donovan'}`)
    if (project.summary?.trim()) lines.push(`- summary: ${project.summary.trim()}`)

    const locations = project.locations.length > 0
      ? project.locations.map(location => {
        const suffix = location.notes?.trim() ? ` (${location.notes.trim()})` : ''
        return `- ${location.is_primary ? '[primary] ' : ''}${machineDisplay(location)} -> ${location.root_path}${suffix}`
      })
      : ['- no machine/path mapping yet']
    lines.push('- locations:')
    lines.push(...locations.map(line => `  ${line}`))

    const assignments = project.assignments.length > 0
      ? project.assignments.map(assignment => {
        const suffix = assignment.responsibility?.trim() ? ` (${assignment.responsibility.trim()})` : ''
        const ownerTag = assignment.is_owner ? ' [owner]' : ''
        return `- ${assignment.agent_name}${ownerTag}${suffix}`
      })
      : ['- no assigned agents yet']
    lines.push('- people:')
    lines.push(...assignments.map(line => `  ${line}`))
    lines.push('')
  }

  return lines.join('\n')
}

function renderAgentProjectContext(agent: AgentWorkspaceRow, projects: ProjectRecord[]) {
  const assignedProjects = projects.filter(project =>
    project.assignments.some(assignment => assignment.agent_id === agent.id) || project.id === agent.current_project_id
  )
  const currentProject = assignedProjects.find(project => project.id === agent.current_project_id) ?? assignedProjects[0] ?? null

  const lines = [
    '# Project Context',
    '',
    `Agent: ${agent.name}`,
    '',
    '## Current Project',
  ]

  if (!currentProject) {
    lines.push('- none assigned yet')
  } else {
    const primaryLocation = currentProject.locations.find(location => location.is_primary) ?? currentProject.locations[0] ?? null
    lines.push(`- name: ${currentProject.name}`)
    lines.push(`- owner: ${currentProject.owner_agent_name ?? 'unassigned'}`)
    lines.push(`- machine: ${primaryLocation ? machineDisplay(primaryLocation) : 'unmapped machine'}`)
    lines.push(`- root path: ${primaryLocation?.root_path ?? 'unset'}`)
  }

  lines.push('')
  lines.push('## Assigned Projects')
  if (assignedProjects.length === 0) {
    lines.push('- none')
    lines.push('')
    return lines.join('\n')
  }

  for (const project of assignedProjects) {
    lines.push(`### ${project.name}`)
    const assignment = project.assignments.find(item => item.agent_id === agent.id) ?? null
    lines.push(`- responsibility: ${assignment?.responsibility?.trim() || 'not specified'}`)
    lines.push(`- owner: ${project.owner_agent_name ?? 'unassigned'}`)
    if (project.summary?.trim()) lines.push(`- summary: ${project.summary.trim()}`)
    lines.push('- locations:')
    if (project.locations.length === 0) {
      lines.push('  - no machine/path mapping yet')
    } else {
      for (const location of project.locations) {
        const suffix = location.notes?.trim() ? ` (${location.notes.trim()})` : ''
        lines.push(`  - ${location.is_primary ? '[primary] ' : ''}${machineDisplay(location)} -> ${location.root_path}${suffix}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}

export async function ensureProjectRegistrySchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      slug VARCHAR(80) NOT NULL,
      name VARCHAR(160) NOT NULL,
      summary TEXT,
      owner_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
      maintained_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
      default_machine_id UUID REFERENCES machines(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, slug)
    )
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS project_locations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      machine_id UUID REFERENCES machines(id) ON DELETE SET NULL,
      machine_label TEXT,
      root_path TEXT NOT NULL,
      notes TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, root_path)
    )
  `)
  await query(`
    CREATE TABLE IF NOT EXISTS project_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      responsibility TEXT,
      is_owner BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (project_id, agent_id)
    )
  `)
  await query(`
    ALTER TABLE agents
    ADD COLUMN IF NOT EXISTS current_project_id UUID REFERENCES projects(id) ON DELETE SET NULL
  `).catch(() => {})
}

export async function resolveMachineReference(serverId: string, rawRef?: string | null) {
  const ref = rawRef?.trim()
  if (!ref) return null

  return queryOne<{ id: string; name: string; hostname: string | null }>(
    `SELECT id, name, hostname
     FROM machines
     WHERE server_id = $1
       AND (
         id::text = $2
         OR LOWER(name) = LOWER($2)
         OR LOWER(COALESCE(hostname, '')) = LOWER($2)
       )
     LIMIT 1`,
    [serverId, ref]
  )
}

export async function resolveAgentReference(serverId: string, rawRef?: string | null) {
  const ref = rawRef?.trim()
  if (!ref) return null
  const normalized = ref.replace(/^@+/, '')

  return queryOne<{ id: string; name: string; role: string | null }>(
    `SELECT id, name, role
     FROM agents
     WHERE server_id = $1
       AND (
         id::text = $2
         OR LOWER(name) = LOWER($3)
       )
     LIMIT 1`,
    [serverId, ref, normalized]
  )
}

export async function listProjectsForServer(serverId: string): Promise<ProjectRecord[]> {
  await ensureProjectRegistrySchema()

  const projects = await query<ProjectRow>(
    `SELECT p.id, p.server_id, p.slug, p.name, p.summary,
            p.owner_agent_id, owner_agent.name AS owner_agent_name,
            p.maintained_by_agent_id, maintainer.name AS maintained_by_agent_name,
            p.default_machine_id, default_machine.name AS default_machine_name,
            default_machine.hostname AS default_machine_hostname,
            p.created_at, p.updated_at
     FROM projects p
     LEFT JOIN agents owner_agent ON owner_agent.id = p.owner_agent_id
     LEFT JOIN agents maintainer ON maintainer.id = p.maintained_by_agent_id
     LEFT JOIN machines default_machine ON default_machine.id = p.default_machine_id
     WHERE p.server_id = $1
     ORDER BY p.updated_at DESC, p.name ASC`,
    [serverId]
  )

  if (projects.length === 0) return []

  const projectIds = projects.map(project => project.id)
  const locations = await query<ProjectLocationRow>(
    `SELECT pl.id, pl.project_id, pl.machine_id, machine.name AS machine_name,
            machine.hostname AS machine_hostname, pl.machine_label, pl.root_path,
            pl.notes, pl.is_primary, pl.created_at, pl.updated_at
     FROM project_locations pl
     LEFT JOIN machines machine ON machine.id = pl.machine_id
     WHERE pl.project_id = ANY($1::uuid[])
     ORDER BY pl.is_primary DESC, pl.updated_at DESC, pl.root_path ASC`,
    [projectIds]
  )
  const assignments = await query<ProjectAssignmentRow>(
    `SELECT pa.id, pa.project_id, pa.agent_id, agent.name AS agent_name,
            agent.role AS agent_role, pa.responsibility, pa.is_owner,
            pa.created_at, pa.updated_at
     FROM project_assignments pa
     JOIN agents agent ON agent.id = pa.agent_id
     WHERE pa.project_id = ANY($1::uuid[])
     ORDER BY pa.is_owner DESC, pa.updated_at DESC, agent.name ASC`,
    [projectIds]
  )

  return projects.map(project => ({
    ...project,
    locations: locations.filter(location => location.project_id === project.id),
    assignments: assignments.filter(assignment => assignment.project_id === project.id),
  }))
}

export async function upsertProject(args: {
  serverId: string
  id?: string | null
  name: string
  slug?: string | null
  summary?: string | null
  ownerAgentId?: string | null
  maintainedByAgentId?: string | null
  defaultMachineId?: string | null
}) {
  await ensureProjectRegistrySchema()

  const name = args.name.trim()
  const slug = slugifyProject(args.slug?.trim() || name)

  if (args.id?.trim()) {
    const [updated] = await query<ProjectRow>(
      `UPDATE projects
       SET slug = $2,
           name = $3,
           summary = $4,
           owner_agent_id = $5,
           maintained_by_agent_id = $6,
           default_machine_id = $7,
           updated_at = NOW()
       WHERE id = $1 AND server_id = $8
       RETURNING id, server_id, slug, name, summary, owner_agent_id, NULL::text AS owner_agent_name,
                 maintained_by_agent_id, NULL::text AS maintained_by_agent_name,
                 default_machine_id, NULL::text AS default_machine_name,
                 NULL::text AS default_machine_hostname, created_at, updated_at`,
      [
        args.id,
        slug,
        name,
        args.summary?.trim() || null,
        args.ownerAgentId ?? null,
        args.maintainedByAgentId ?? null,
        args.defaultMachineId ?? null,
        args.serverId,
      ]
    )
    return updated
  }

  const [project] = await query<ProjectRow>(
    `INSERT INTO projects (server_id, slug, name, summary, owner_agent_id, maintained_by_agent_id, default_machine_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (server_id, slug)
     DO UPDATE SET
       name = EXCLUDED.name,
       summary = EXCLUDED.summary,
       owner_agent_id = EXCLUDED.owner_agent_id,
       maintained_by_agent_id = EXCLUDED.maintained_by_agent_id,
       default_machine_id = EXCLUDED.default_machine_id,
       updated_at = NOW()
     RETURNING id, server_id, slug, name, summary, owner_agent_id, NULL::text AS owner_agent_name,
               maintained_by_agent_id, NULL::text AS maintained_by_agent_name,
               default_machine_id, NULL::text AS default_machine_name,
               NULL::text AS default_machine_hostname, created_at, updated_at`,
    [
      args.serverId,
      slug,
      name,
      args.summary?.trim() || null,
      args.ownerAgentId ?? null,
      args.maintainedByAgentId ?? null,
      args.defaultMachineId ?? null,
    ]
  )
  return project
}

export async function upsertProjectLocation(projectId: string, args: {
  machineId?: string | null
  machineLabel?: string | null
  rootPath: string
  notes?: string | null
  isPrimary?: boolean
}) {
  const rootPath = args.rootPath.trim()
  if (args.isPrimary) {
    await query(`UPDATE project_locations SET is_primary = FALSE, updated_at = NOW() WHERE project_id = $1`, [projectId])
  }

  const [location] = await query<ProjectLocationRow>(
    `INSERT INTO project_locations (project_id, machine_id, machine_label, root_path, notes, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, root_path)
     DO UPDATE SET
       machine_id = EXCLUDED.machine_id,
       machine_label = EXCLUDED.machine_label,
       notes = EXCLUDED.notes,
       is_primary = EXCLUDED.is_primary,
       updated_at = NOW()
     RETURNING id, project_id, machine_id, NULL::text AS machine_name, NULL::text AS machine_hostname,
               machine_label, root_path, notes, is_primary, created_at, updated_at`,
    [
      projectId,
      args.machineId ?? null,
      args.machineLabel?.trim() || null,
      rootPath,
      args.notes?.trim() || null,
      Boolean(args.isPrimary),
    ]
  )

  if (args.isPrimary) {
    await query(
      `UPDATE projects
       SET default_machine_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [projectId, args.machineId ?? null]
    )
  }

  return location
}

export async function upsertProjectAssignment(projectId: string, args: {
  agentId: string
  responsibility?: string | null
  isOwner?: boolean
  setCurrent?: boolean
}) {
  const [assignment] = await query<ProjectAssignmentRow>(
    `INSERT INTO project_assignments (project_id, agent_id, responsibility, is_owner)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, agent_id)
     DO UPDATE SET
       responsibility = EXCLUDED.responsibility,
       is_owner = EXCLUDED.is_owner,
       updated_at = NOW()
     RETURNING id, project_id, agent_id, NULL::varchar AS agent_name, NULL::varchar AS agent_role,
               responsibility, is_owner, created_at, updated_at`,
    [
      projectId,
      args.agentId,
      args.responsibility?.trim() || null,
      Boolean(args.isOwner),
    ]
  )

  if (args.isOwner) {
    await query(`UPDATE projects SET owner_agent_id = $2, updated_at = NOW() WHERE id = $1`, [projectId, args.agentId])
  }

  if (args.setCurrent) {
    await setAgentCurrentProject(args.agentId, projectId)
  }

  return assignment
}

export async function setAgentCurrentProject(agentId: string, projectId: string | null) {
  await query(`UPDATE agents SET current_project_id = $2 WHERE id = $1`, [agentId, projectId])
}

export async function syncProjectRegistryMemory(serverId: string) {
  await ensureProjectRegistrySchema()

  const [projects, agents] = await Promise.all([
    listProjectsForServer(serverId),
    query<AgentWorkspaceRow>(
      `SELECT id, name, role, workspace_path, current_project_id
       FROM agents
       WHERE server_id = $1`,
      [serverId]
    ),
  ])

  const donovan = agents.find(agent => agent.name.trim().toLowerCase() === 'donovan' && agent.workspace_path)
  if (donovan?.workspace_path) {
    const registryPath = join(donovan.workspace_path, 'notes', 'project-registry.md')
    const memoryPath = join(donovan.workspace_path, 'MEMORY.md')
    await mkdir(join(donovan.workspace_path, 'notes'), { recursive: true })
    await writeWorkspaceFile(registryPath, renderProjectRegistry(projects))
    const originalMemory = await readWorkspaceMemory(memoryPath)
    const updatedMemory = replaceManagedBlock(
      originalMemory,
      DONOVAN_PROJECT_BLOCK_START,
      DONOVAN_PROJECT_BLOCK_END,
      [
        '## Project Registry',
        '- Read `notes/project-registry.md` for the canonical machine/project/path ownership mapping.',
        `- Registered projects: ${projects.length}.`,
        '- Keep this mapping current when humans mention a project name, machine nickname, or ownership change.',
      ].join('\n')
    )
    await writeWorkspaceFile(memoryPath, updatedMemory)
  }

  for (const agent of agents) {
    if (!agent.workspace_path) continue
    const contextPath = join(agent.workspace_path, 'notes', 'project-context.md')
    const memoryPath = join(agent.workspace_path, 'MEMORY.md')
    await mkdir(join(agent.workspace_path, 'notes'), { recursive: true })
    await writeWorkspaceFile(contextPath, renderAgentProjectContext(agent, projects))
    const originalMemory = await readWorkspaceMemory(memoryPath)
    const currentProject = projects.find(project => project.id === agent.current_project_id)
    const updatedMemory = replaceManagedBlock(
      originalMemory,
      AGENT_PROJECT_BLOCK_START,
      AGENT_PROJECT_BLOCK_END,
      [
        '## Project Context',
        '- Read `notes/project-context.md` for the current machine/project mapping and workspace roots.',
        `- Current project: ${currentProject?.name ?? 'none assigned yet'}.`,
        `- Current machine: ${currentProject?.locations.find(location => location.is_primary)?.machine_hostname
          || currentProject?.locations.find(location => location.is_primary)?.machine_name
          || currentProject?.locations.find(location => location.is_primary)?.machine_label
          || 'unset'}.`,
      ].join('\n')
    )
    await writeWorkspaceFile(memoryPath, updatedMemory)
  }
}
