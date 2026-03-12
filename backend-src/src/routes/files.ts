// Files routes — /api/files
// POST /upload   multipart upload (image/pdf)
// GET  /:id      file metadata

import type { FastifyPluginAsync } from 'fastify'
import type { MultipartFile } from '@fastify/multipart'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { query } from '../db/client.js'

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
])
const MAX_IMAGE_BYTES = 10 * 1024 * 1024   // 10MB
const MAX_PDF_BYTES   = 50 * 1024 * 1024   // 50MB

export const fileRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/files/upload ────────────────────────────────────────
  app.post('/upload', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    const data = await req.file() as MultipartFile | undefined
    if (!data) return reply.code(400).send({ error: 'No file provided' })

    const mime = data.mimetype
    if (!ALLOWED_MIME.has(mime)) {
      return reply.code(400).send({ error: `File type not allowed: ${mime}` })
    }

    const maxBytes = mime === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES
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
    const ext      = mime === 'application/pdf' ? '.pdf' : path.extname(data.filename) || '.bin'
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
      [fileId, serverId, caller.sub, data.filename, mime, totalBytes, filename]
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
