// Machines routes — /api/machines
// GET    /              list machines in user's server
// POST   /              create machine (returns API key once)
// DELETE /:id           remove machine
// POST   /:id/heartbeat daemon heartbeat (machine API key auth, no JWT needed)
// GET    /:id/agents    agents assigned to this machine

import type { FastifyPluginAsync } from 'fastify'
import { createHash, randomBytes } from 'crypto'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { query, queryOne } from '../db/client.js'
import { machineConnectionManager } from '../daemon/machine-connection.js'
import { resolveServerUrl } from '../server-url.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Resolve daemon path relative to project root (backend-src/../daemon-src/dist/index.js)
const DEFAULT_DAEMON_PATH = resolve(__dirname, '..', '..', '..', 'daemon-src', 'dist', 'index.js')

function hashKey(key: string) {
  return createHash('sha256').update(key).digest('hex')
}

export const machineRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/machines ─────────────────────────────────────────────
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const machines = await query(
      `SELECT m.id, m.name, m.status, m.hostname, m.os, m.daemon_version,
              m.last_seen_at, m.created_at,
              COUNT(a.id)::int AS agent_count
       FROM machines m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.user_id = $1
       LEFT JOIN agents a ON a.machine_id = m.id
       GROUP BY m.id
       ORDER BY m.created_at DESC`,
      [caller.sub]
    )

    // Enrich with live runtime info from connected daemons
    return (machines as any[]).map(m => ({
      ...m,
      runtimes: machineConnectionManager.getRuntimes(m.id),
    }))
  })

  // ── POST /api/machines ────────────────────────────────────────────
  // Creates a machine with auto-generated name, returns the raw API key (only returned once)
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    // Get user's primary server
    const server = await queryOne<{ id: string }>(
      `SELECT s.id FROM servers s
       JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
       LIMIT 1`,
      [caller.sub]
    )
    if (!server) return reply.code(400).send({ error: 'No server found' })

    // Auto-generate name: machine-XXXX
    const suffix = randomBytes(2).toString('hex').toUpperCase()
    const autoName = `machine-${suffix}`

    // Generate API key: sk_machine_<64 hex chars>
    const rawKey = 'sk_machine_' + randomBytes(32).toString('hex')
    const keyHash = hashKey(rawKey)

    const [machine] = await query(
      `INSERT INTO machines (server_id, name, api_key_hash, api_key)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, status, hostname, os, daemon_version, last_seen_at, created_at`,
      [server.id, autoName, keyHash, rawKey]
    )

    const serverUrl = resolveServerUrl(req)

    return {
      ...machine,
      api_key: rawKey,  // returned once only
      server_url: serverUrl,
      connect_command: `npx ${serverUrl}/daemon/redshrimp-daemon.tgz --server-url ${serverUrl} --api-key ${rawKey}`,
      env_config: `REDSHRIMP_SERVER_URL=${serverUrl}\nREDSHRIMP_API_KEY=${rawKey}`,
    }
  })

  // ── PATCH /api/machines/:id ───────────────────────────────────────
  // Rename a machine
  app.patch('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }
    const { name } = req.body as { name: string }

    if (!name?.trim()) return reply.code(400).send({ error: 'name required' })

    const machine = await queryOne(
      `SELECT m.id FROM machines m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.user_id = $1
       WHERE m.id = $2`,
      [caller.sub, id]
    )
    if (!machine) return reply.code(404).send({ error: 'Machine not found' })

    const [updated] = await query(
      `UPDATE machines SET name = $1 WHERE id = $2
       RETURNING id, name, status, hostname, os, daemon_version, last_seen_at, created_at`,
      [name.trim(), id]
    )
    return updated
  })

  // ── POST /api/machines/:id/reconnect ─────────────────────────────
  // Return existing API key + connect command (no key regeneration)
  app.post('/:id/reconnect', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const machine = await queryOne<{ id: string; name: string; api_key: string | null }>(
      `SELECT m.id, m.name, m.api_key FROM machines m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.user_id = $1
       WHERE m.id = $2`,
      [caller.sub, id]
    )
    if (!machine) return reply.code(404).send({ error: 'Machine not found' })

    const rawKey = machine.api_key
    if (!rawKey) return reply.code(400).send({ error: 'API key not available — please delete and recreate the machine' })

    const serverUrl = resolveServerUrl(req)

    return {
      api_key: rawKey,
      server_url: serverUrl,
      connect_command: `npx ${serverUrl}/daemon/redshrimp-daemon.tgz --server-url ${serverUrl} --api-key ${rawKey}`,
      env_config: `REDSHRIMP_SERVER_URL=${serverUrl}\nREDSHRIMP_API_KEY=${rawKey}`,
    }
  })

  // ── DELETE /api/machines/:id ──────────────────────────────────────
  app.delete('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const machine = await queryOne(
      `SELECT m.id FROM machines m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.user_id = $1
       WHERE m.id = $2`,
      [caller.sub, id]
    )
    if (!machine) return reply.code(404).send({ error: 'Machine not found' })

    // Unlink agents from this machine before deleting
    await query('UPDATE agents SET machine_id = NULL WHERE machine_id = $1', [id])
    await query('DELETE FROM machines WHERE id = $1', [id])
    return { ok: true }
  })

  // ── POST /api/machines/:id/heartbeat ─────────────────────────────
  // Called by daemon process — auth via machine API key (X-Machine-Key header)
  app.post('/:id/heartbeat', async (req, reply) => {
    const { id } = req.params as { id: string }
    const machineKey = (req.headers['x-machine-key'] as string) ?? ''

    const machine = await queryOne<{ id: string; api_key_hash: string }>(
      'SELECT id, api_key_hash FROM machines WHERE id = $1',
      [id]
    )
    if (!machine || machine.api_key_hash !== hashKey(machineKey)) {
      return reply.code(401).send({ error: 'Invalid machine key' })
    }

    const { hostname, os, daemon_version } = req.body as {
      hostname?: string; os?: string; daemon_version?: string
    }

    await query(
      `UPDATE machines
       SET status = 'online', hostname = COALESCE($2, hostname),
           os = COALESCE($3, os), daemon_version = COALESCE($4, daemon_version),
           last_seen_at = NOW()
       WHERE id = $1`,
      [id, hostname, os, daemon_version]
    )
    return { ok: true }
  })

  // ── GET /api/machines/:id/agents ──────────────────────────────────
  app.get('/:id/agents', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const { id } = req.params as { id: string }

    const machine = await queryOne(
      `SELECT m.id FROM machines m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.user_id = $1
       WHERE m.id = $2`,
      [caller.sub, id]
    )
    if (!machine) return reply.code(404).send({ error: 'Machine not found' })

    const agents = await query(
      `SELECT id, name, status, activity, model_id, runtime, last_heartbeat_at, created_at
       FROM agents WHERE machine_id = $1 ORDER BY name`,
      [id]
    )
    return agents
  })

  // ── GET /api/machines/runtimes ──────────────────────────────────
  // Returns all supported runtimes and which are currently available on connected machines
  app.get('/runtimes', { preHandler: [app.authenticate] }, async () => {
    const liveRuntimes = machineConnectionManager.getAllRuntimes()
    return [
      { id: 'claude', name: 'Claude Code', binary: 'claude', available: liveRuntimes.includes('claude'), defaultModel: 'claude-sonnet-4-6' },
      { id: 'codex',  name: 'Codex CLI',   binary: 'codex',  available: liveRuntimes.includes('codex'),  defaultModel: 'gpt-5.4' },
      { id: 'kimi',   name: 'Kimi CLI',    binary: 'kimi',   available: liveRuntimes.includes('kimi'),   defaultModel: 'kimi-code/kimi-for-coding' },
    ]
  })
}
