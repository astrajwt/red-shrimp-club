// /api/ask — Context-aware AI Q&A
// Accepts a question + optional filePath, gathers context, calls LLM
// POST /ask — full response; POST /ask/stream — SSE streaming

import type { FastifyPluginAsync } from 'fastify'
import { query } from '../db/client.js'
import { llmClient } from '../daemon/llm-client.js'
import fs from 'fs'
import path from 'path'

// Shared context builder
async function buildContext(filePath?: string): Promise<string[]> {
  const contextParts: string[] = []

  if (filePath) {
    const vaultRoot = process.env.OBSIDIAN_ROOT
    if (vaultRoot) {
      const resolved = path.resolve(vaultRoot, filePath)
      if (resolved.startsWith(path.resolve(vaultRoot))) {
        try {
          const content = fs.readFileSync(resolved, 'utf-8')
          const truncated = content.length > 8000 ? content.slice(0, 8000) + '\n...[truncated]' : content
          contextParts.push(`## Current Document: ${path.basename(filePath)}\n\n${truncated}`)
        } catch { /* file not readable */ }
      }
    }
  }

  try {
    const tasks = await query<{ title: string; status: string; claimed_by_name: string | null }>(
      `SELECT t.title, t.status, a.name AS claimed_by_name
       FROM tasks t LEFT JOIN agents a ON a.id = t.claimed_by
       ORDER BY t.created_at DESC LIMIT 30`
    )
    if (tasks.length > 0) {
      contextParts.push(`## Current Tasks\n\n${tasks.map(t =>
        `- [${t.status}] ${t.title} (${t.claimed_by_name ? `@${t.claimed_by_name}` : 'unassigned'})`
      ).join('\n')}`)
    }
  } catch { /* ignore */ }

  try {
    const agents = await query<{ name: string; status: string; role: string }>(
      `SELECT name, status, role FROM agents ORDER BY created_at LIMIT 10`
    )
    if (agents.length > 0) {
      contextParts.push(`## Team Agents\n\n${agents.map(a =>
        `- ${a.name} (${a.role ?? 'general'}) — ${a.status}`
      ).join('\n')}`)
    }
  } catch { /* ignore */ }

  return contextParts
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant for the Red Shrimp Lab project.
Answer questions based on the provided context. Be concise and direct.
If asking about tasks or agents, use the task/agent data provided.
Reply in the same language as the question (Chinese or English).`

export const askRoutes: FastifyPluginAsync = async (app) => {

  // POST /api/ask — full response
  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { question, filePath, model, systemPrompt } = req.body as {
      question: string; filePath?: string; model?: string; systemPrompt?: string
    }
    if (!question?.trim()) return reply.code(400).send({ error: 'question is required' })

    const contextParts = await buildContext(filePath)
    const contextSection = contextParts.length > 0
      ? `<context>\n${contextParts.join('\n\n')}\n</context>\n\n` : ''
    const prompt = `${contextSection}Question: ${question}`

    try {
      const response = await llmClient.complete({
        prompt,
        systemPrompt: systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
        model: model ?? undefined, maxTokens: 1024,
      })
      return { answer: response.text, model: response.model }
    } catch (err: any) {
      return reply.code(500).send({ error: 'LLM call failed', detail: err.message })
    }
  })

  // POST /api/ask/stream — SSE streaming
  app.post('/stream', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { question, filePath, model, systemPrompt } = req.body as {
      question: string; filePath?: string; model?: string; systemPrompt?: string
    }
    if (!question?.trim()) return reply.code(400).send({ error: 'question is required' })

    const contextParts = await buildContext(filePath)
    const contextSection = contextParts.length > 0
      ? `<context>\n${contextParts.join('\n\n')}\n</context>\n\n` : ''
    const prompt = `${contextSection}Question: ${question}`

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    try {
      for await (const chunk of llmClient.streamComplete({
        prompt,
        systemPrompt: systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
        model: model ?? undefined, maxTokens: 1024,
      })) {
        reply.raw.write(`data: ${JSON.stringify({ text: chunk })}\n\n`)
      }
      reply.raw.write(`data: [DONE]\n\n`)
    } catch (err: any) {
      reply.raw.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
    }

    reply.raw.end()
  })
}
