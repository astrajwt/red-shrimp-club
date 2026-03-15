// Auth routes — /api/auth
// POST /login  POST /register  POST /logout  POST /refresh  GET /me

import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID, createHash } from 'crypto'
import { z } from 'zod'
import { query, queryOne } from '../db/client.js'

function normalizeIdentity(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return trimmed
  return trimmed.includes('@') ? trimmed : `${trimmed}@local.dev`
}

const LoginSchema = z.object({
  identity: z.string().trim().min(1).max(200),
})

const RegisterSchema = z.object({
  name:  z.string().trim().min(1).max(100),
  email: z.string().min(1).max(200).transform(normalizeIdentity),
})

const ACCESS_TOKEN_EXP  = '15m'
const REFRESH_TOKEN_EXP = 60 * 60 * 24 * 30  // 30 days in seconds

export const authRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/auth/register ──────────────────────────────────────
  app.post('/register', async (req, reply) => {
    const parsed = RegisterSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid registration input',
        details: parsed.error.flatten(),
      })
    }
    const body = parsed.data

    // Check email not taken
    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [body.email])
    if (existing) return reply.code(409).send({ error: 'Email already registered' })

    const hash = await bcrypt.hash(randomUUID(), 12)
    const [user] = await query<{ id: string; name: string; email: string }>(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, name, email, email_verified, role, created_at`,
      [body.name, body.email, hash]
    )

    // Create default server for this user
    const slug = body.name.toLowerCase().replace(/\s+/g, '-') + '-' + randomUUID().slice(0, 6)
    const [server] = await query<{ id: string }>(
      `INSERT INTO servers (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
      [body.name + "'s workspace", slug, user.id]
    )
    await query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [server.id, user.id]
    )

    // Create #all channel
    await query(
      `INSERT INTO channels (server_id, name, description) VALUES ($1, 'all', 'General channel for all members')`,
      [server.id]
    )

    const { accessToken, refreshToken } = await issueTokens(app, user.id)
    return { accessToken, refreshToken, user }
  })

  // ── POST /api/auth/login ─────────────────────────────────────────
  app.post('/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid login input',
        details: parsed.error.flatten(),
      })
    }
    const body = parsed.data
    const normalizedIdentity = normalizeIdentity(body.identity)
    const loweredIdentity = body.identity.trim().toLowerCase()

    const user = await queryOne<{
      id: string; name: string; email: string; password_hash: string;
      email_verified: boolean; role: string;
    }>(
      `SELECT * FROM users
       WHERE email = $1
          OR lower(name) = $2
       LIMIT 1`,
      [normalizedIdentity, loweredIdentity]
    )

    if (!user) return reply.code(401).send({ error: 'Account not found' })

    const { accessToken, refreshToken } = await issueTokens(app, user.id)
    const { password_hash: _, ...safeUser } = user
    return { accessToken, refreshToken, user: safeUser }
  })

  // ── POST /api/auth/refresh ───────────────────────────────────────
  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = req.body as { refreshToken?: string }
    if (!refreshToken) return reply.code(400).send({ error: 'refreshToken required' })

    const hash = hashToken(refreshToken)
    const stored = await queryOne<{ user_id: string; expires_at: string }>(
      'SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = $1', [hash]
    )
    if (!stored || new Date(stored.expires_at) < new Date()) {
      return reply.code(401).send({ error: 'Invalid or expired refresh token' })
    }

    // Rotate refresh token
    await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash])
    const tokens = await issueTokens(app, stored.user_id)
    return tokens
  })

  // ── POST /api/auth/logout ────────────────────────────────────────
  app.post('/logout', async (req) => {
    const { refreshToken } = req.body as { refreshToken?: string }
    if (refreshToken) {
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)])
    }
    return { ok: true }
  })

  // ── GET /api/auth/me ─────────────────────────────────────────────
  app.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    const user = await queryOne(
      'SELECT id, name, email, email_verified, role, created_at FROM users WHERE id = $1',
      [(req.user as { sub: string }).sub]
    )
    if (!user) throw app.httpErrors.notFound('User not found')
    return user
  })
}

// ── Helpers ──────────────────────────────────────────────────────

async function issueTokens(app: any, userId: string) {
  const accessToken  = app.jwt.sign({ sub: userId }, { expiresIn: ACCESS_TOKEN_EXP })
  const refreshToken = randomUUID() + '-' + randomUUID()

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '${REFRESH_TOKEN_EXP} seconds')`,
    [userId, hashToken(refreshToken)]
  )
  return { accessToken, refreshToken }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
