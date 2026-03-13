/**
 * 认证路由 — /api/auth
 *
 * 文件位置: backend-src/src/routes/auth.ts
 * 核心功能:
 *   POST /register — 用户注册（自动创建 server + #all 频道）
 *   POST /login    — 用户登录（邮箱+密码）
 *   POST /refresh  — 刷新令牌（轮转 refresh token）
 *   POST /logout   — 用户登出（删除 refresh token）
 *   GET  /me       — 获取当前用户信息
 *
 * 认证机制:
 *   - Access Token: JWT，15 分钟有效期
 *   - Refresh Token: 随机 UUID，30 天有效期，SHA256 哈希后存入 DB
 *   - 密码: bcrypt 加盐哈希（cost=12）
 */

import type { FastifyPluginAsync } from 'fastify'
import bcrypt from 'bcryptjs'
import { randomUUID, createHash } from 'crypto'
import { z } from 'zod'
import { query, queryOne } from '../db/client.js'

/** 登录请求参数校验 */
const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(6),
})

/** 注册请求参数校验 */
const RegisterSchema = z.object({
  name:     z.string().min(1).max(100),
  email:    z.string().email(),
  password: z.string().min(6),
})

/** Access Token 有效期 (15 分钟) */
const ACCESS_TOKEN_EXP  = '15m'
/** Refresh Token 有效期 (30 天，单位秒) */
const REFRESH_TOKEN_EXP = 60 * 60 * 24 * 30

export const authRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/auth/register ──────────────────────────────────────
  /**
   * 用户注册
   * 流程:
   *   1. 校验参数 → 检查邮箱唯一性
   *   2. 密码 bcrypt 哈希 → 创建用户记录
   *   3. 自动创建个人 server 和默认 #all 频道
   *   4. 签发 access + refresh token
   */
  app.post('/register', async (req, reply) => {
    const body = RegisterSchema.parse(req.body)

    // 检查邮箱是否已被注册
    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [body.email])
    if (existing) return reply.code(409).send({ error: 'Email already registered' })

    const hash = await bcrypt.hash(body.password, 12)  // cost=12 的 bcrypt 哈希
    const [user] = await query<{ id: string; name: string; email: string }>(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, name, email, email_verified, role, created_at`,
      [body.name, body.email, hash]
    )

    // 为新用户创建默认 server（工作空间）
    const slug = body.name.toLowerCase().replace(/\s+/g, '-') + '-' + randomUUID().slice(0, 6)
    const [server] = await query<{ id: string }>(
      `INSERT INTO servers (name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id`,
      [body.name + "'s workspace", slug, user.id]
    )
    await query(
      `INSERT INTO server_members (server_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [server.id, user.id]
    )

    // 创建默认 #all 通用频道
    await query(
      `INSERT INTO channels (server_id, name, description) VALUES ($1, 'all', 'General channel for all members')`,
      [server.id]
    )

    const { accessToken, refreshToken } = await issueTokens(app, user.id)
    return { accessToken, refreshToken, user }
  })

  // ── POST /api/auth/login ─────────────────────────────────────────
  /**
   * 用户登录
   * 流程: 查询用户 → bcrypt 比对密码 → 签发 token
   * 安全: 错误信息统一为 "Invalid credentials"，不区分邮箱不存在和密码错误
   */
  app.post('/login', async (req, reply) => {
    const body = LoginSchema.parse(req.body)

    const user = await queryOne<{
      id: string; name: string; email: string; password_hash: string;
      email_verified: boolean; role: string;
    }>('SELECT * FROM users WHERE email = $1', [body.email])

    if (!user) return reply.code(401).send({ error: 'Invalid credentials' })
    const valid = await bcrypt.compare(body.password, user.password_hash)
    if (!valid) return reply.code(401).send({ error: 'Invalid credentials' })

    const { accessToken, refreshToken } = await issueTokens(app, user.id)
    // 从响应中排除 password_hash 字段
    const { password_hash: _, ...safeUser } = user
    return { accessToken, refreshToken, user: safeUser }
  })

  // ── POST /api/auth/refresh ───────────────────────────────────────
  /**
   * 刷新令牌
   * 使用 Refresh Token 轮转策略:
   *   1. 验证旧 refresh token（通过哈希比对）
   *   2. 删除旧 token → 签发全新的 access + refresh token
   * 这样每个 refresh token 只能使用一次，提高安全性
   */
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

    // 轮转: 删除旧 token，签发新 token
    await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash])
    const tokens = await issueTokens(app, stored.user_id)
    return tokens
  })

  // ── POST /api/auth/logout ────────────────────────────────────────
  /** 登出: 删除服务端存储的 refresh token，使其失效 */
  app.post('/logout', async (req) => {
    const { refreshToken } = req.body as { refreshToken?: string }
    if (refreshToken) {
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)])
    }
    return { ok: true }
  })

  // ── GET /api/auth/me ─────────────────────────────────────────────
  /** 获取当前登录用户信息（需要有效的 access token） */
  app.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    const user = await queryOne(
      'SELECT id, name, email, email_verified, role, created_at FROM users WHERE id = $1',
      [(req.user as { sub: string }).sub]
    )
    if (!user) throw app.httpErrors.notFound('User not found')
    return user
  })
}

// ── 辅助函数 ──────────────────────────────────────────────────────

/**
 * 签发 access token + refresh token
 * @param app    Fastify 实例（使用其 jwt.sign 方法）
 * @param userId 用户 UUID
 * @returns { accessToken, refreshToken }
 *
 * 安全说明:
 *   - Access Token: JWT 签名，payload 包含 { sub: userId }
 *   - Refresh Token: 双 UUID 拼接，SHA256 哈希后存入 DB（原文不存储）
 */
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

/**
 * 对 token 做 SHA256 哈希
 * DB 中只存储哈希值，不存储原始 refresh token
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
