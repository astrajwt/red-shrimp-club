import type { FastifyPluginAsync } from 'fastify'
import { importSkillRepo, listSharedSkills } from '../services/shared-skills.js'

export const skillRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [app.authenticate] }, async () => {
    return listSharedSkills()
  })

  app.post('/import-repo', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = req.body as {
      name?: string
      repoUrl?: string
      branch?: string
      skillPath?: string
      valuePath?: string
      localPath?: string
    }

    try {
      const result = await importSkillRepo({
        name: body.name,
        repoUrl: body.repoUrl,
        branch: body.branch,
        skillPath: body.skillPath,
        valuePath: body.valuePath,
        localPath: body.localPath,
      })
      return { ok: true, ...result }
    } catch (err: any) {
      return reply.code(400).send({ error: err.message ?? 'Skill repo import failed' })
    }
  })
}
