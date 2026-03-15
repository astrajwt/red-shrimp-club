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
      vault_git_url: process.env.VAULT_GIT_URL ?? '',
      skill_path:    process.env.SKILL_PATH ?? '',
      memory_path:   process.env.MEMORY_PATH ?? '',
      feishu_app_id: process.env.FEISHU_APP_ID ?? '',
      feishu_app_secret: !!(process.env.FEISHU_APP_SECRET),
      feishu_verification_token: !!(process.env.FEISHU_VERIFICATION_TOKEN),
      feishu_webhook_base_url: process.env.FEISHU_WEBHOOK_BASE_URL ?? '',
    }
  })

  // ── POST /api/setup/keys — update API keys in .env ────────────────
  app.post('/keys', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = req.body as {
      anthropicKey?: string
      moonshotKey?:  string
      openaiKey?:    string
      obsidianRoot?: string
      vaultGitUrl?:  string
      skillPath?:    string
      memoryPath?:   string
      feishuAppId?: string
      feishuAppSecret?: string
      feishuVerificationToken?: string
      feishuWebhookBaseUrl?: string
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
    if (body.vaultGitUrl !== undefined) {
      env = setEnvVar(env, 'VAULT_GIT_URL', body.vaultGitUrl.trim())
      process.env.VAULT_GIT_URL = body.vaultGitUrl.trim()
    }
    if (body.skillPath !== undefined) {
      env = setEnvVar(env, 'SKILL_PATH', body.skillPath.trim())
      process.env.SKILL_PATH = body.skillPath.trim()
    }
    if (body.memoryPath !== undefined) {
      env = setEnvVar(env, 'MEMORY_PATH', body.memoryPath.trim())
      process.env.MEMORY_PATH = body.memoryPath.trim()
    }
    if (body.feishuAppId !== undefined) {
      env = setEnvVar(env, 'FEISHU_APP_ID', body.feishuAppId.trim())
      process.env.FEISHU_APP_ID = body.feishuAppId.trim()
    }
    if (body.feishuAppSecret !== undefined) {
      env = setEnvVar(env, 'FEISHU_APP_SECRET', body.feishuAppSecret.trim())
      process.env.FEISHU_APP_SECRET = body.feishuAppSecret.trim()
    }
    if (body.feishuVerificationToken !== undefined) {
      env = setEnvVar(env, 'FEISHU_VERIFICATION_TOKEN', body.feishuVerificationToken.trim())
      process.env.FEISHU_VERIFICATION_TOKEN = body.feishuVerificationToken.trim()
    }
    if (body.feishuWebhookBaseUrl !== undefined) {
      env = setEnvVar(env, 'FEISHU_WEBHOOK_BASE_URL', body.feishuWebhookBaseUrl.trim())
      process.env.FEISHU_WEBHOOK_BASE_URL = body.feishuWebhookBaseUrl.trim()
    }

    try {
      fs.writeFileSync(getEnvPath(), env, 'utf8')
    } catch (e) {
      return reply.code(500).send({ error: 'Failed to write .env: ' + (e as Error).message })
    }

    return { ok: true }
  })
}
