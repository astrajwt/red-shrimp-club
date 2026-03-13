/**
 * 文件上传路由 — /api/files
 *
 * 文件位置: backend-src/src/routes/files.ts
 * 核心功能:
 *   POST /upload — 文件上传（支持图片和 PDF）
 *   GET  /:id   — 获取文件元数据
 *
 * 上传限制:
 *   - 允许的 MIME 类型: JPEG, PNG, GIF, WebP, PDF
 *   - 图片最大 10MB，PDF 最大 50MB
 *   - 文件以 UUID 命名存储在磁盘上，通过 /uploads/ 静态路由访问
 *
 * 存储方案:
 *   - 文件保存到 UPLOADS_DIR (默认 /var/redshrimp/uploads)
 *   - 元数据（文件名、MIME、大小、路径）存入 DB files 表
 *   - 文件名格式: {uuid}.{ext}，避免命名冲突
 */

import type { FastifyPluginAsync } from 'fastify'
import type { MultipartFile } from '@fastify/multipart'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { query } from '../db/client.js'

/** 允许上传的 MIME 类型白名单 */
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
])
/** 图片最大字节数 (10MB) */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** PDF 最大字节数 (50MB) */
const MAX_PDF_BYTES   = 50 * 1024 * 1024

export const fileRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/files/upload ────────────────────────────────────────
  /**
   * 文件上传
   * 流程:
   *   1. 从 multipart 请求中读取文件流
   *   2. 校验 MIME 类型白名单
   *   3. 流式读取并检查文件大小（超限则立即拒绝）
   *   4. 保存到磁盘（UUID 命名）
   *   5. 写入 DB 元数据记录
   *
   * @returns 文件元数据 + 访问 URL
   */
  app.post('/upload', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }

    const data = await req.file() as MultipartFile | undefined
    if (!data) return reply.code(400).send({ error: 'No file provided' })

    // MIME 类型校验
    const mime = data.mimetype
    if (!ALLOWED_MIME.has(mime)) {
      return reply.code(400).send({ error: `File type not allowed: ${mime}` })
    }

    // 根据文件类型确定大小限制
    const maxBytes = mime === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES
    const uploadsDir = process.env.UPLOADS_DIR ?? '/var/redshrimp/uploads'

    // 流式读取文件内容，边读边检查大小（防止大文件耗尽内存）
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

    // 以 UUID 命名保存到磁盘，避免文件名冲突
    const ext      = mime === 'application/pdf' ? '.pdf' : path.extname(data.filename) || '.bin'
    const fileId   = randomUUID()
    const filename = `${fileId}${ext}`
    const filePath = path.join(uploadsDir, filename)

    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(filePath, Buffer.concat(chunks))

    // 获取调用者所在的 server（用于文件归属）
    const serverRow = await query<{ id: string }>(
      'SELECT server_id AS id FROM server_members WHERE user_id = $1 LIMIT 1',
      [caller.sub]
    )
    const serverId = serverRow[0]?.id

    // 写入文件元数据到 DB
    const [file] = await query(
      `INSERT INTO files
         (id, server_id, uploader_id, uploader_type, filename, mime_type, size_bytes, storage_path)
       VALUES ($1, $2, $3, 'human', $4, $5, $6, $7)
       RETURNING id, filename, mime_type, size_bytes, created_at`,
      [fileId, serverId, caller.sub, data.filename, mime, totalBytes, filename]
    )

    return {
      ...file,
      url: `/uploads/${filename}`,  // 通过静态文件路由访问
    }
  })

  // ── GET /api/files/:id ────────────────────────────────────────────
  /** 获取文件元数据（含访问 URL） */
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
