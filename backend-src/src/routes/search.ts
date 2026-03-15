import fs from 'fs'
import path from 'path'
import type { FastifyPluginAsync } from 'fastify'
import { query } from '../db/client.js'

const MAX_LIMIT = 50

type SearchDocHit = {
  path: string
  title: string
  snippet: string
  updated_at: string | null
}

function buildSnippet(raw: string, needle: string, radius = 80) {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''

  const haystack = normalized.toLowerCase()
  const index = haystack.indexOf(needle.toLowerCase())
  if (index === -1) {
    return normalized.length > radius * 2
      ? `${normalized.slice(0, radius * 2).trim()}...`
      : normalized
  }

  const start = Math.max(0, index - radius)
  const end = Math.min(normalized.length, index + needle.length + radius)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < normalized.length ? '...' : ''
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`
}

function extractTitle(content: string, fallbackPath: string) {
  const frontmatterTitle = content.match(/^---\r?\n[\s\S]*?\r?\ntitle:\s*(.+?)\r?\n[\s\S]*?---/im)
  if (frontmatterTitle?.[1]) {
    return frontmatterTitle[1].replace(/^['"]|['"]$/g, '').trim()
  }

  const heading = content.match(/^#\s+(.+)$/m)
  if (heading?.[1]) return heading[1].trim()

  return path.basename(fallbackPath, path.extname(fallbackPath))
}

function searchVaultDocs(vaultRoot: string, needle: string, limit: number): SearchDocHit[] {
  const hits: Array<SearchDocHit & { score: number }> = []
  const root = path.resolve(vaultRoot)

  function visit(dir: string, relDir = '') {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

      const absolutePath = path.join(dir, entry.name)
      const relativePath = relDir ? path.join(relDir, entry.name) : entry.name
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath)
        continue
      }

      if (!entry.isFile()) continue

      const lowerPath = relativePath.toLowerCase()
      const pathMatchIndex = lowerPath.indexOf(needle)
      let content = ''
      let contentMatchIndex = -1
      let title = path.basename(relativePath, path.extname(relativePath))

      const isMarkdown = entry.name.toLowerCase().endsWith('.md')
      if (isMarkdown) {
        try {
          content = fs.readFileSync(absolutePath, 'utf-8')
          contentMatchIndex = content.toLowerCase().indexOf(needle)
          title = extractTitle(content, relativePath)
        } catch {
          content = ''
          contentMatchIndex = -1
        }
      }

      if (pathMatchIndex === -1 && contentMatchIndex === -1) continue

      const stats = fs.statSync(absolutePath)
      const scoreBase = pathMatchIndex === -1 ? 2000 : pathMatchIndex
      const score = scoreBase + (contentMatchIndex === -1 ? 1000 : Math.min(contentMatchIndex, 999))
      const snippetSource = contentMatchIndex !== -1 ? content : relativePath

      hits.push({
        path: relativePath.replace(/\\/g, '/'),
        title,
        snippet: buildSnippet(snippetSource, needle),
        updated_at: stats.mtime.toISOString(),
        score,
      })
    }
  }

  visit(root)

  return hits
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score
      return (right.updated_at ?? '').localeCompare(left.updated_at ?? '')
    })
    .slice(0, limit)
    .map(({ score: _score, ...hit }) => hit)
}

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const { q = '', limit = '12' } = req.query as { q?: string; limit?: string }
    const searchTerm = q.trim()
    if (searchTerm.length < 2) {
      return { query: searchTerm, messages: [], docs: [] }
    }

    const cappedLimit = Math.max(1, Math.min(Number(limit) || 12, MAX_LIMIT))
    const likePattern = `%${searchTerm}%`

    const messages = await query(
      `SELECT m.id,
              m.channel_id,
              CASE
                WHEN c.type = 'dm' THEN COALESCE((
                  SELECT COALESCE(u.name, a.name)
                  FROM channel_members cm2
                  LEFT JOIN users u ON u.id = cm2.user_id
                  LEFT JOIN agents a ON a.id = cm2.agent_id
                  WHERE cm2.channel_id = c.id
                    AND (cm2.user_id IS NULL OR cm2.user_id <> $1)
                    AND cm2.agent_id IS DISTINCT FROM $1::uuid
                  ORDER BY cm2.joined_at
                  LIMIT 1
                ), c.name)
                ELSE c.name
              END AS channel_name,
              c.type AS channel_type,
              m.sender_name,
              m.sender_type,
              m.seq,
              m.created_at,
              m.content
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $1
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
       WHERE m.content ILIKE $2
         AND (
           (c.type = 'channel' AND sm.user_id IS NOT NULL)
           OR (c.type = 'dm' AND cm.user_id IS NOT NULL)
         )
       ORDER BY m.created_at DESC
       LIMIT $3`,
      [caller.sub, likePattern, cappedLimit]
    )

    const docs = process.env.OBSIDIAN_ROOT?.trim()
      ? searchVaultDocs(process.env.OBSIDIAN_ROOT.trim(), searchTerm.toLowerCase(), cappedLimit)
      : []

    return {
      query: searchTerm,
      messages: messages.map((message: any) => ({
        ...message,
        snippet: buildSnippet(message.content ?? '', searchTerm),
      })),
      docs,
    }
  })
}
