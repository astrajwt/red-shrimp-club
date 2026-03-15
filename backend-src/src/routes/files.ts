// Files routes — /api/files
// POST /upload   multipart upload (generic attachments)
// GET  /:id      file metadata

import type { FastifyPluginAsync } from 'fastify'
import type { MultipartFile } from '@fastify/multipart'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { query } from '../db/client.js'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

function normalizeFilename(filename: string | undefined, mime: string) {
  const trimmed = filename?.trim()
  if (trimmed) return trimmed

  const fallbackExt =
    mime === 'image/png' ? '.png' :
    mime === 'image/jpeg' ? '.jpg' :
    mime === 'image/gif' ? '.gif' :
    mime === 'image/webp' ? '.webp' :
    mime === 'application/pdf' ? '.pdf' :
    ''

  return `attachment-${Date.now()}${fallbackExt}`
}

export const fileRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/files/upload ────────────────────────────────────────
  app.post('/upload', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    const data = await req.file() as MultipartFile | undefined
    if (!data) return reply.code(400).send({ error: 'No file provided' })

    const mime = data.mimetype || 'application/octet-stream'
    const originalFilename = normalizeFilename(data.filename, mime)
    const isImage = mime.startsWith('image/')
    const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_ATTACHMENT_BYTES
    const uploadsDir = process.env.UPLOADS_DIR ?? '/var/redshrimp/uploads'

    // Stream to temp buffer to check size
    const chunks: Buffer[] = []
    let totalBytes = 0
    for await (const chunk of data.file) {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        return reply.code(413).send({
          error: `File too large. Max: ${maxBytes / 1024 / 1024}MB`
        })
      }
      chunks.push(chunk)
    }

    // Save to disk
    const ext      = path.extname(originalFilename) || '.bin'
    const fileId   = randomUUID()
    const filename = `${fileId}${ext}`
    const filePath = path.join(uploadsDir, filename)

    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(filePath, Buffer.concat(chunks))

    // Get serverId for the caller
    const serverRow = await query<{ id: string }>(
      'SELECT server_id AS id FROM server_members WHERE user_id = $1 LIMIT 1',
      [caller.sub]
    )
    const serverId = serverRow[0]?.id

    const [file] = await query(
      `INSERT INTO files
         (id, server_id, uploader_id, uploader_type, filename, mime_type, size_bytes, storage_path)
       VALUES ($1, $2, $3, 'human', $4, $5, $6, $7)
       RETURNING id, filename, mime_type, size_bytes, created_at`,
      [fileId, serverId, caller.sub, originalFilename, mime, totalBytes, filename]
    )

    return {
      ...file,
      url: `/uploads/${filename}`,
    }
  })

  // ── GET /api/files/:id ────────────────────────────────────────────
  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const file = await query<{
      id: string; filename: string; mime_type: string; size_bytes: number; storage_path: string;
    }>('SELECT * FROM files WHERE id = $1', [id])

    if (!file[0]) return reply.code(404).send({ error: 'File not found' })
    return {
      ...file[0],
      url: `/uploads/${file[0].storage_path}`,
    }
  })
}
