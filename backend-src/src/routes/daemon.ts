// Daemon control routes — /api/daemon
// Internal routes called by the Daemon to persist logs / update state.
// Also exposes health info for monitoring.
// Cron job management + Obsidian vault access.

import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import { processManager } from '../daemon/process-manager.js'
import { heartbeatChecker } from '../daemon/heartbeat-checker.js'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const OBSIDIAN_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
])

const OBSIDIAN_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
}

export const daemonRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/daemon/heartbeat/trigger ──────────────────────────
  // Manually trigger a heartbeat check for all agents (or one agent)
  app.post('/heartbeat/trigger', { preHandler: [app.authenticate] }, async (req) => {
    const { agentId } = req.body as { agentId?: string }
    heartbeatChecker.triggerNow(agentId).catch(() => {})
    return { ok: true, message: 'Heartbeat check triggered' }
  })

  // ── GET /api/daemon/health ────────────────────────────────────────
  app.get('/health', async () => {
    return {
      status:    'ok',
      timestamp: new Date().toISOString(),
      uptime:    process.uptime(),
    }
  })

  // ── POST /api/daemon/logs ─────────────────────────────────────────
  // Daemon calls this to persist a log entry to DB
  app.post('/logs', async (req) => {
    const { agentId, runId, level, content } = req.body as {
      agentId: string; runId?: string; level: string; content: string
    }
    await query(
      `INSERT INTO agent_logs (agent_id, run_id, level, content) VALUES ($1, $2, $3, $4)`,
      [agentId, runId ?? null, level, content]
    )
    return { ok: true }
  })

  // ── POST /api/daemon/runs ─────────────────────────────────────────
  // Create a new agent run (including sub-agent runs)
  app.post('/runs', async (req) => {
    const { agentId, parentRunId, taskId, tokensLimit } = req.body as {
      agentId: string; parentRunId?: string; taskId?: string; tokensLimit?: number
    }
    const [run] = await query(
      `INSERT INTO agent_runs (agent_id, parent_run_id, task_id, tokens_limit)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [agentId, parentRunId ?? null, taskId ?? null, tokensLimit ?? 200000]
    )
    return { run }
  })

  // ── PATCH /api/daemon/runs/:id ────────────────────────────────────
  app.patch('/runs/:id', async (req) => {
    const { id } = req.params as { id: string }
    const { status, tokensUsed, contextSnapshot } = req.body as {
      status?: string; tokensUsed?: number; contextSnapshot?: Record<string, unknown>
    }

    const [run] = await query(
      `UPDATE agent_runs
       SET status = COALESCE($1, status),
           tokens_used = COALESCE($2, tokens_used),
           context_snapshot = COALESCE($3::jsonb, context_snapshot),
           ended_at = CASE WHEN $1 IN ('completed','handoff','failed') THEN NOW() ELSE ended_at END
       WHERE id = $4 RETURNING *`,
      [status ?? null, tokensUsed ?? null, contextSnapshot ? JSON.stringify(contextSnapshot) : null, id]
    )
    return { run }
  })

  // ── POST /api/daemon/doc-status ───────────────────────────────────
  // Agent updates a linked document's status (writing → unread)
  app.post('/doc-status', async (req) => {
    const { docPath, status } = req.body as { docPath: string; status: string }
    await query(
      `UPDATE task_documents SET status = $1 WHERE doc_path = $2`,
      [status, docPath]
    )
    return { ok: true }
  })

  // ── GET /api/daemon/cron ────────────────────────────────────────
  app.get('/cron', { preHandler: [app.authenticate] }, async () => {
    const jobs = await query(
      `SELECT cj.*, a.name AS agent_name
       FROM cron_jobs cj
       JOIN agents a ON a.id = cj.agent_id
       ORDER BY cj.created_at`
    )
    return { jobs }
  })

  // ── POST /api/daemon/cron ───────────────────────────────────────
  app.post('/cron', { preHandler: [app.authenticate] }, async (req) => {
    const { agentId, cronExpr, prompt, channelId, modelOverride } = req.body as {
      agentId: string; cronExpr: string; prompt: string;
      channelId?: string; modelOverride?: string
    }
    const [job] = await query(
      `INSERT INTO cron_jobs (agent_id, cron_expr, prompt, channel_id, model_override)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [agentId, cronExpr, prompt, channelId ?? null, modelOverride ?? null]
    )
    return { job }
  })

  // ── PATCH /api/daemon/cron/:id ──────────────────────────────────
  app.patch('/cron/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { enabled, cronExpr, prompt } = req.body as {
      enabled?: boolean; cronExpr?: string; prompt?: string
    }
    const existing = await queryOne('SELECT 1 FROM cron_jobs WHERE id = $1', [id])
    if (!existing) return reply.code(404).send({ error: 'Cron job not found' })

    const [job] = await query(
      `UPDATE cron_jobs
       SET enabled   = COALESCE($1, enabled),
           cron_expr = COALESCE($2, cron_expr),
           prompt    = COALESCE($3, prompt)
       WHERE id = $4 RETURNING *`,
      [enabled ?? null, cronExpr ?? null, prompt ?? null, id]
    )
    return { job }
  })

  // ── DELETE /api/daemon/cron/:id ─────────────────────────────────
  app.delete('/cron/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const [deleted] = await query('DELETE FROM cron_jobs WHERE id = $1 RETURNING id', [id])
    if (!deleted) return reply.code(404).send({ error: 'Cron job not found' })
    return { ok: true }
  })

  // ── POST /api/daemon/obsidian/sync ──────────────────────────────
  // Trigger manual git sync for Obsidian vault
  app.post('/obsidian/sync', { preHandler: [app.authenticate] }, async (_req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    try {
      execSync('git add -A && git diff --cached --quiet || git commit -m "manual sync" && git push', {
        cwd: vaultRoot,
        timeout: 30_000,
        stdio: 'pipe',
      })
      return { ok: true, message: 'Obsidian vault synced' }
    } catch (err: any) {
      return reply.code(500).send({ error: 'Sync failed', detail: err.stderr?.toString() })
    }
  })

  // ── GET /api/daemon/obsidian/file ───────────────────────────────
  // Read an Obsidian markdown file (read-only)
  app.get('/obsidian/file', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: filePath, relativeTo } = req.query as { path: string; relativeTo?: string }
    if (!filePath) return reply.code(400).send({ error: 'path query param required' })

    let resolvedFile: ResolvedVaultFile | null
    try {
      resolvedFile = resolveVaultFile(vaultRoot, filePath, relativeTo, new Set(['.md']))
    } catch (err: any) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'Failed to resolve file path' })
    }
    if (!resolvedFile) return reply.code(404).send({ error: 'File not found' })

    try {
      const content = fs.readFileSync(resolvedFile.absolutePath, 'utf-8')
      return { path: resolvedFile.relativePath, content }
    } catch {
      return reply.code(404).send({ error: 'File not found' })
    }
  })

  // ── GET /api/daemon/obsidian/image ──────────────────────────────
  // Serve a binary image from the Obsidian vault
  app.get('/obsidian/image', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: filePath, relativeTo } = req.query as { path: string; relativeTo?: string }
    if (!filePath) return reply.code(400).send({ error: 'path query param required' })

    let resolvedFile: ResolvedVaultFile | null
    try {
      resolvedFile = resolveVaultFile(vaultRoot, filePath, relativeTo, OBSIDIAN_IMAGE_EXTENSIONS)
    } catch (err: any) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'Failed to resolve image path' })
    }
    if (!resolvedFile) return reply.code(404).send({ error: 'Image not found' })

    return sendVaultAsset(reply, resolvedFile)
  })

  // ── GET /api/daemon/obsidian/asset ──────────────────────────────
  // Serve image / PDF / binary attachments from the Obsidian vault
  app.get('/obsidian/asset', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: filePath, relativeTo } = req.query as { path: string; relativeTo?: string }
    if (!filePath) return reply.code(400).send({ error: 'path query param required' })

    let resolvedFile: ResolvedVaultFile | null
    try {
      resolvedFile = resolveVaultFile(vaultRoot, filePath, relativeTo)
    } catch (err: any) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'Failed to resolve asset path' })
    }
    if (!resolvedFile) return reply.code(404).send({ error: 'Asset not found' })

    return sendVaultAsset(reply, resolvedFile)
  })

  // ── GET /api/daemon/obsidian/backlinks ──────────────────────────
  // Find all files that contain [[wikilinks]] pointing to a given file
  app.get('/obsidian/backlinks', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: targetPath } = req.query as { path: string }
    if (!targetPath) return reply.code(400).send({ error: 'path query param required' })

    // Derive the target name (filename without extension) for [[wikilink]] matching
    const targetName = path.basename(targetPath, path.extname(targetPath)).toLowerCase()
    const backlinks: Array<{ path: string; name: string; context: string }> = []

    function scanDir(dir: string, relDir: string) {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const fullPath = path.join(dir, e.name)
        const relPath = relDir ? path.join(relDir, e.name) : e.name
        if (e.isDirectory()) {
          scanDir(fullPath, relPath)
        } else if (e.name.endsWith('.md') && relPath !== targetPath) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8')
            // Match [[target]] or [[target|alias]]
            const wikiRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
            let m: RegExpExecArray | null
            while ((m = wikiRe.exec(content)) !== null) {
              const linked = m[1].trim().toLowerCase()
              if (linked === targetName || linked === targetPath.toLowerCase()) {
                // Extract a line of context
                const lineStart = content.lastIndexOf('\n', m.index) + 1
                const lineEnd = content.indexOf('\n', m.index)
                const ctx = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim()
                backlinks.push({ path: relPath, name: e.name, context: ctx })
                break // one entry per file
              }
            }
          } catch { /* skip unreadable */ }
        }
      }
    }

    scanDir(vaultRoot, '')
    return { target: targetPath, backlinks }
  })

  // ── GET /api/daemon/obsidian/tree ───────────────────────────────
  // List directory tree from Obsidian vault
  app.get('/obsidian/tree', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { path: dirPath = '' } = req.query as { path?: string }
    const resolved = path.resolve(vaultRoot, dirPath)

    if (!resolved.startsWith(path.resolve(vaultRoot))) {
      return reply.code(403).send({ error: 'Path traversal not allowed' })
    }

    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
      const items = entries
        .filter(e => !e.name.startsWith('.'))  // skip .git, .obsidian
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
          path: path.join(dirPath, e.name),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      return { path: dirPath, items }
    } catch {
      return reply.code(404).send({ error: 'Directory not found' })
    }
  })

  // ── GET /api/daemon/memory/sources ────────────────────────────────
  // List all imported memory git sources
  app.get('/memory/sources', { preHandler: [app.authenticate] }, async () => {
    const sources = await query(
      `SELECT * FROM memory_sources ORDER BY created_at DESC`
    )
    return { sources }
  })

  // ── POST /api/daemon/memory/sources ───────────────────────────────
  // Import a git repo as a memory source into the vault
  app.post('/memory/sources', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { name, gitUrl, branch, authMethod } = req.body as {
      name: string
      gitUrl: string
      branch?: string
      authMethod?: 'none' | 'ssh' | 'pat'
    }

    if (!name?.trim() || !gitUrl?.trim()) {
      return reply.code(400).send({ error: 'name and gitUrl are required' })
    }

    const safeName = name.trim().replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
    const localPath = path.join('imports', safeName)
    const targetDir = path.resolve(vaultRoot, localPath)

    // Prevent overwriting existing directories outside imports/
    if (!targetDir.startsWith(path.resolve(vaultRoot))) {
      return reply.code(403).send({ error: 'Path traversal not allowed' })
    }

    // Get server_id from first server (single-server setup)
    const server = await queryOne<{ id: string }>('SELECT id FROM servers LIMIT 1')
    if (!server) return reply.code(500).send({ error: 'No server found' })

    const branchName = branch?.trim() || 'main'
    const auth = authMethod || 'none'

    // Insert record
    const [source] = await query(
      `INSERT INTO memory_sources (server_id, name, git_url, branch, local_path, auth_method, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'cloning')
       ON CONFLICT (server_id, name) DO UPDATE SET
         git_url = EXCLUDED.git_url,
         branch = EXCLUDED.branch,
         auth_method = EXCLUDED.auth_method,
         status = 'cloning',
         last_error = NULL
       RETURNING *`,
      [server.id, safeName, gitUrl.trim(), branchName, localPath, auth]
    )

    // Clone async — don't block the response
    cloneRepo(vaultRoot, targetDir, gitUrl.trim(), branchName, auth, source.id).catch(() => {})

    return { source }
  })

  // ── POST /api/daemon/memory/sources/:id/sync ──────────────────────
  // Pull latest changes for an imported memory source
  app.post('/memory/sources/:id/sync', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { id } = req.params as { id: string }
    const source = await queryOne<{ id: string; local_path: string; branch: string; auth_method: string; git_url: string }>(
      'SELECT * FROM memory_sources WHERE id = $1', [id]
    )
    if (!source) return reply.code(404).send({ error: 'Memory source not found' })

    const targetDir = path.resolve(vaultRoot, source.local_path)

    await query(`UPDATE memory_sources SET status = 'cloning', last_error = NULL WHERE id = $1`, [id])

    // Pull async
    pullRepo(targetDir, source.branch, source.auth_method, id).catch(() => {})

    return { ok: true, message: 'Sync started' }
  })

  // ── DELETE /api/daemon/memory/sources/:id ─────────────────────────
  // Remove an imported memory source (deletes local directory)
  app.delete('/memory/sources/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (!vaultRoot) return reply.code(500).send({ error: 'OBSIDIAN_ROOT not configured' })

    const { id } = req.params as { id: string }
    const source = await queryOne<{ id: string; local_path: string }>(
      'SELECT * FROM memory_sources WHERE id = $1', [id]
    )
    if (!source) return reply.code(404).send({ error: 'Memory source not found' })

    const targetDir = path.resolve(vaultRoot, source.local_path)

    // Safety: only remove directories under vaultRoot/imports/
    if (targetDir.startsWith(path.resolve(vaultRoot, 'imports'))) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch { /* ok */ }
    }

    await query('DELETE FROM memory_sources WHERE id = $1', [id])
    return { ok: true }
  })
}

type ResolvedVaultFile = {
  absolutePath: string
  relativePath: string
  ext: string
  contentType: string
}

function resolveVaultFile(
  vaultRoot: string,
  requestedPath: string,
  relativeTo?: string,
  allowedExts?: Set<string>,
): ResolvedVaultFile | null {
  const root = path.resolve(vaultRoot)
  const normalizedPath = requestedPath.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalizedPath) return null

  const candidates: string[] = []
  if (!relativeTo || !normalizedPath.startsWith('.')) {
    const directCandidate = resolveVaultCandidate(root, normalizedPath)
    if (directCandidate) candidates.push(directCandidate)
  }

  if (relativeTo && !requestedPath.startsWith('/')) {
    const normalizedRelativeTo = relativeTo.replace(/\\/g, '/')
    const baseDir = path.posix.dirname(normalizedRelativeTo)
    const relativeCandidate = resolveVaultCandidate(root, path.posix.join(baseDir, normalizedPath))
    if (relativeCandidate) candidates.push(relativeCandidate)
  }

  for (const candidate of candidates) {
    const resolvedFile = buildResolvedVaultFile(root, candidate, allowedExts)
    if (resolvedFile) return resolvedFile
  }

  if (!normalizedPath.includes('/')) {
    const fallback = findVaultFileByBasename(root, path.basename(normalizedPath), allowedExts)
    if (fallback) return buildResolvedVaultFile(root, fallback, allowedExts)
  }

  return null
}

function resolveVaultCandidate(vaultRoot: string, candidatePath: string): string | null {
  const resolved = path.resolve(vaultRoot, candidatePath)
  if (!isPathWithinRoot(vaultRoot, resolved)) {
    const err = new Error('Path traversal not allowed') as Error & { statusCode?: number }
    err.statusCode = 403
    throw err
  }
  return resolved
}

function buildResolvedVaultFile(
  vaultRoot: string,
  absolutePath: string,
  allowedExts?: Set<string>,
): ResolvedVaultFile | null {
  try {
    const stat = fs.statSync(absolutePath)
    if (!stat.isFile()) return null

    const ext = path.extname(absolutePath).toLowerCase()
    if (allowedExts && !allowedExts.has(ext)) return null

    return {
      absolutePath,
      relativePath: path.relative(vaultRoot, absolutePath).split(path.sep).join('/'),
      ext,
      contentType: OBSIDIAN_MIME_TYPES[ext] ?? 'application/octet-stream',
    }
  } catch {
    return null
  }
}

function findVaultFileByBasename(
  vaultRoot: string,
  basename: string,
  allowedExts?: Set<string>,
): string | null {
  const queue = [vaultRoot]

  for (let index = 0; index < queue.length; index += 1) {
    const dir = queue[index]
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue

      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
        continue
      }

      if (entry.name !== basename) continue

      const ext = path.extname(entry.name).toLowerCase()
      if (allowedExts && !allowedExts.has(ext)) continue
      return fullPath
    }
  }

  return null
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function sendVaultAsset(reply: any, file: ResolvedVaultFile) {
  reply.header('Content-Type', file.contentType)
  reply.header('Cache-Control', 'public, max-age=3600')
  reply.header('Content-Disposition', 'inline')
  reply.header('X-Content-Type-Options', 'nosniff')
  return reply.send(fs.createReadStream(file.absolutePath))
}

// ── Git helpers ─────────────────────────────────────────────────────────────

async function cloneRepo(
  vaultRoot: string, targetDir: string, gitUrl: string,
  branch: string, authMethod: string, sourceId: string,
) {
  try {
    // Ensure imports/ directory exists
    const importsDir = path.resolve(vaultRoot, 'imports')
    if (!fs.existsSync(importsDir)) fs.mkdirSync(importsDir, { recursive: true })

    // Remove existing if present
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true })

    const env = buildGitEnv(authMethod)
    execSync(
      `git clone --depth 1 --branch ${shellEscape(branch)} ${shellEscape(gitUrl)} ${shellEscape(targetDir)}`,
      { timeout: 120_000, stdio: 'pipe', env: { ...process.env, ...env } }
    )

    await query(
      `UPDATE memory_sources SET status = 'synced', last_synced = NOW(), last_error = NULL WHERE id = $1`,
      [sourceId]
    )
  } catch (err: any) {
    const errMsg = err.stderr?.toString() || err.message || 'Clone failed'
    await query(
      `UPDATE memory_sources SET status = 'error', last_error = $1 WHERE id = $2`,
      [errMsg.slice(0, 500), sourceId]
    )
  }
}

async function pullRepo(
  targetDir: string, branch: string, authMethod: string, sourceId: string,
) {
  try {
    const env = buildGitEnv(authMethod)
    execSync(
      `git -C ${shellEscape(targetDir)} fetch origin ${shellEscape(branch)} && git -C ${shellEscape(targetDir)} reset --hard origin/${shellEscape(branch)}`,
      { timeout: 120_000, stdio: 'pipe', env: { ...process.env, ...env } }
    )

    await query(
      `UPDATE memory_sources SET status = 'synced', last_synced = NOW(), last_error = NULL WHERE id = $1`,
      [sourceId]
    )
  } catch (err: any) {
    const errMsg = err.stderr?.toString() || err.message || 'Pull failed'
    await query(
      `UPDATE memory_sources SET status = 'error', last_error = $1 WHERE id = $2`,
      [errMsg.slice(0, 500), sourceId]
    )
  }
}

function buildGitEnv(authMethod: string): Record<string, string> {
  if (authMethod === 'ssh') {
    return { GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new' }
  }
  return {}
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
