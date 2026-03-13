// Setup routes — /api/setup
// Onboarding configuration: API keys, machine registration

import type { FastifyPluginAsync } from 'fastify'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Path to .env file (backend-src/.env)
function getEnvPath(): string {
  return path.resolve(__dirname, '../../.env')
}

function readEnv(): string {
  const p = getEnvPath()
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

function setEnvVar(content: string, key: string, value: string): string {
  const regex = new RegExp(`^${key}=.*$`, 'm')
  if (regex.test(content)) {
    return content.replace(regex, `${key}=${value}`)
  }
  return content + `\n${key}=${value}`
}

export const setupRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/setup/keys — return which keys are set (masked) ──────
  app.get('/keys', { preHandler: [app.authenticate] }, async () => {
    return {
      anthropic: !!(process.env.ANTHROPIC_API_KEY),
      moonshot:  !!(process.env.MOONSHOT_API_KEY),
      openai:    !!(process.env.OPENAI_API_KEY),
      obsidian_root: process.env.OBSIDIAN_ROOT ?? '',
    }
  })

  // ── POST /api/setup/keys — update API keys in .env ────────────────
  app.post('/keys', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = req.body as {
      anthropicKey?: string
      moonshotKey?:  string
      openaiKey?:    string
      obsidianRoot?: string
    }

    let env = readEnv()

    if (body.anthropicKey !== undefined) {
      env = setEnvVar(env, 'ANTHROPIC_API_KEY', body.anthropicKey.trim())
      process.env.ANTHROPIC_API_KEY = body.anthropicKey.trim()
    }
    if (body.moonshotKey !== undefined) {
      env = setEnvVar(env, 'MOONSHOT_API_KEY', body.moonshotKey.trim())
      process.env.MOONSHOT_API_KEY = body.moonshotKey.trim()
    }
    if (body.openaiKey !== undefined) {
      env = setEnvVar(env, 'OPENAI_API_KEY', body.openaiKey.trim())
      process.env.OPENAI_API_KEY = body.openaiKey.trim()
    }
    if (body.obsidianRoot !== undefined && body.obsidianRoot.trim()) {
      env = setEnvVar(env, 'OBSIDIAN_ROOT', body.obsidianRoot.trim())
      process.env.OBSIDIAN_ROOT = body.obsidianRoot.trim()
    }

    try {
      fs.writeFileSync(getEnvPath(), env, 'utf8')
    } catch (e) {
      return reply.code(500).send({ error: 'Failed to write .env: ' + (e as Error).message })
    }

    return { ok: true }
  })
}
