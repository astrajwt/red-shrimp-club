import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import {
  ensureProjectRegistrySchema,
  listProjectsForServer,
  setAgentCurrentProject,
  syncProjectRegistryMemory,
  upsertProject,
  upsertProjectAssignment,
  upsertProjectLocation,
} from '../services/project-registry.js'

export const projectRoutes: FastifyPluginAsync = async (app) => {
  await ensureProjectRegistrySchema()
  const servers = await query<{ server_id: string }>(`SELECT DISTINCT server_id FROM agents`)
  for (const server of servers) {
    await syncProjectRegistryMemory(server.server_id).catch(() => {})
  }

  const resolveServerId = async (userId: string, requestedServerId?: string | null) => {
    if (requestedServerId?.trim()) {
      const server = await queryOne<{ id: string }>(
        `SELECT s.id
         FROM servers s
         JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
         WHERE s.id = $2
         LIMIT 1`,
        [userId, requestedServerId.trim()]
      )
      return server?.id ?? null
    }

    const server = await queryOne<{ id: string }>(
      `SELECT s.id
       FROM servers s
       JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
       LIMIT 1`,
      [userId]
    )
    return server?.id ?? null
  }

  const resolveProjectForUser = async (userId: string, projectId: string) =>
    queryOne<{ id: string; server_id: string; name: string }>(
      `SELECT p.id, p.server_id, p.name
       FROM projects p
       JOIN server_members sm ON sm.server_id = p.server_id AND sm.user_id = $1
       WHERE p.id = $2`,
      [userId, projectId]
    )

  app.get('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { serverId } = req.query as { serverId?: string }
    const resolvedServerId = await resolveServerId(caller.sub, serverId)
    if (!resolvedServerId) return reply.code(400).send({ error: 'No accessible server found' })

    return {
      projects: await listProjectsForServer(resolvedServerId),
    }
  })

  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const body = req.body as {
      id?: string
      serverId?: string
      name?: string
      slug?: string
      summary?: string | null
      ownerAgentId?: string | null
      maintainedByAgentId?: string | null
      defaultMachineId?: string | null
      currentAgentId?: string | null
      locations?: Array<{
        machineId?: string | null
        machineLabel?: string | null
        rootPath: string
        notes?: string | null
        isPrimary?: boolean
      }>
      assignments?: Array<{
        agentId: string
        responsibility?: string | null
        isOwner?: boolean
        setCurrent?: boolean
      }>
    }

    const resolvedServerId = await resolveServerId(caller.sub, body.serverId)
    if (!resolvedServerId) return reply.code(400).send({ error: 'No accessible server found' })

    let existingName: string | null = null
    if (body.id?.trim()) {
      const existing = await resolveProjectForUser(caller.sub, body.id.trim())
      if (!existing) return reply.code(404).send({ error: 'Project not found' })
      existingName = existing.name
    }

    const projectName = body.name?.trim() || existingName
    if (!projectName) return reply.code(400).send({ error: 'name required' })

    const maintainedByAgentId = body.maintainedByAgentId?.trim()
      || (await queryOne<{ id: string }>(
        `SELECT id
         FROM agents
         WHERE server_id = $1 AND LOWER(name) = 'donovan'
         LIMIT 1`,
        [resolvedServerId]
      ))?.id
      || null

    const project = await upsertProject({
      id: body.id?.trim() || null,
      serverId: resolvedServerId,
      name: projectName,
      slug: body.slug?.trim() || null,
      summary: body.summary ?? null,
      ownerAgentId: body.ownerAgentId?.trim() || null,
      maintainedByAgentId,
      defaultMachineId: body.defaultMachineId?.trim() || null,
    })

    for (const location of body.locations ?? []) {
      if (!location.rootPath?.trim()) continue
      await upsertProjectLocation(project.id, {
        machineId: location.machineId?.trim() || null,
        machineLabel: location.machineLabel?.trim() || null,
        rootPath: location.rootPath,
        notes: location.notes ?? null,
        isPrimary: location.isPrimary,
      })
    }

    for (const assignment of body.assignments ?? []) {
      if (!assignment.agentId?.trim()) continue
      await upsertProjectAssignment(project.id, {
        agentId: assignment.agentId.trim(),
        responsibility: assignment.responsibility ?? null,
        isOwner: assignment.isOwner,
        setCurrent: assignment.setCurrent,
      })
    }

    if (body.currentAgentId?.trim()) {
      await setAgentCurrentProject(body.currentAgentId.trim(), project.id)
    }

    await syncProjectRegistryMemory(resolvedServerId)

    return {
      project: (await listProjectsForServer(resolvedServerId)).find(item => item.id === project.id) ?? project,
    }
  })

  app.post('/:id/locations', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const body = req.body as {
      machineId?: string | null
      machineLabel?: string | null
      rootPath?: string
      notes?: string | null
      isPrimary?: boolean
    }

    const project = await resolveProjectForUser(caller.sub, id)
    if (!project) return reply.code(404).send({ error: 'Project not found' })
    if (!body.rootPath?.trim()) return reply.code(400).send({ error: 'rootPath required' })

    await upsertProjectLocation(project.id, {
      machineId: body.machineId?.trim() || null,
      machineLabel: body.machineLabel?.trim() || null,
      rootPath: body.rootPath,
      notes: body.notes ?? null,
      isPrimary: body.isPrimary,
    })
    await syncProjectRegistryMemory(project.server_id)

    return {
      project: (await listProjectsForServer(project.server_id)).find(item => item.id === project.id),
    }
  })

  app.post('/:id/assignments', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const body = req.body as {
      agentId?: string
      responsibility?: string | null
      isOwner?: boolean
      setCurrent?: boolean
    }

    const project = await resolveProjectForUser(caller.sub, id)
    if (!project) return reply.code(404).send({ error: 'Project not found' })
    if (!body.agentId?.trim()) return reply.code(400).send({ error: 'agentId required' })

    await upsertProjectAssignment(project.id, {
      agentId: body.agentId.trim(),
      responsibility: body.responsibility ?? null,
      isOwner: body.isOwner,
      setCurrent: body.setCurrent,
    })
    await syncProjectRegistryMemory(project.server_id)

    return {
      project: (await listProjectsForServer(project.server_id)).find(item => item.id === project.id),
    }
  })

  app.post('/:id/set-current-agent', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const body = req.body as { agentId?: string }

    const project = await resolveProjectForUser(caller.sub, id)
    if (!project) return reply.code(404).send({ error: 'Project not found' })
    if (!body.agentId?.trim()) return reply.code(400).send({ error: 'agentId required' })

    await setAgentCurrentProject(body.agentId.trim(), project.id)
    await syncProjectRegistryMemory(project.server_id)

    return {
      project: (await listProjectsForServer(project.server_id)).find(item => item.id === project.id),
    }
  })
}
