import type { FastifyPluginAsync } from 'fastify'
import { query, queryOne } from '../db/client.js'
import { createStoredMessage } from '../services/message-store.js'
import {
  assertFeishuWebhook,
  bindFeishuIdentity,
  defaultRelayAgentForUser,
  feishuConfigStatus,
  findOrCreateHumanAgentDm,
  findRelayBindingForInbound,
  getFeishuRelayForUser,
  reserveInboundFeishuEvent,
  sendFeishuText,
  upsertFeishuRelayBinding,
} from '../services/feishu-relay.js'

function parseFeishuTextContent(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as { text?: string }
    return parsed.text?.trim() ?? ''
  } catch {
    return ''
  }
}

export const feishuRoutes: FastifyPluginAsync = async (app) => {
  const webhookPath = '/api/feishu/webhook'

  await query(`
    CREATE TABLE IF NOT EXISTS feishu_relay_bindings (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      server_id        UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      feishu_open_id   TEXT UNIQUE,
      feishu_chat_id   TEXT,
      enabled          BOOLEAN NOT NULL DEFAULT TRUE,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {})

  await query(`
    CREATE TABLE IF NOT EXISTS feishu_inbound_events (
      message_id  TEXT PRIMARY KEY,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {})

  app.get('/relay', { preHandler: [app.authenticate] }, async (req) => {
    const caller = req.user as { sub: string }
    const binding = await getFeishuRelayForUser(caller.sub)
    return {
      config: feishuConfigStatus(),
      relay: binding,
      webhookPath,
      webhookUrl: process.env.FEISHU_WEBHOOK_BASE_URL?.trim()
        ? `${process.env.FEISHU_WEBHOOK_BASE_URL!.trim().replace(/\/+$/, '')}${webhookPath}`
        : null,
    }
  })

  app.post('/relay', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const body = req.body as {
      agentId?: string
      enabled?: boolean
      resetBinding?: boolean
    }

    const targetAgent = body.agentId?.trim()
      ? await queryOne<{ id: string }>('SELECT id FROM agents WHERE id = $1', [body.agentId.trim()])
      : await defaultRelayAgentForUser(caller.sub)
    if (!targetAgent) {
      return reply.code(400).send({ error: 'No Akara/ops agent found in your server yet' })
    }

    try {
      const relay = await upsertFeishuRelayBinding({
        userId: caller.sub,
        agentId: targetAgent.id,
        enabled: body.enabled !== false,
        resetBinding: body.resetBinding === true,
      })
      return { ok: true, relay }
    } catch (err: any) {
      return reply.code(400).send({ error: err.message ?? 'Failed to save Feishu relay' })
    }
  })

  app.post('/relay/test', { preHandler: [app.authenticate] }, async (req, reply) => {
    const caller = req.user as { sub: string }
    const binding = await getFeishuRelayForUser(caller.sub)
    if (!binding?.enabled) return reply.code(400).send({ error: 'Feishu relay is not enabled' })
    if (!binding.feishu_chat_id && !binding.feishu_open_id) {
      return reply.code(400).send({ error: 'Send one Feishu message first so the relay can bind your chat' })
    }

    try {
      await sendFeishuText({
        chatId: binding.feishu_chat_id,
        openId: binding.feishu_open_id,
        text: `${binding.agent_name}: relay connected. Send text here and I will forward it into your Akara DM.`,
      })
      return { ok: true }
    } catch (err: any) {
      return reply.code(400).send({ error: err.message ?? 'Failed to send test message' })
    }
  })

  app.post('/webhook', async (req, reply) => {
    const body = req.body as any

    try {
      assertFeishuWebhook(body)
    } catch (err: any) {
      return reply.code(403).send({ error: err.message ?? 'Forbidden' })
    }

    if (body?.challenge && (body?.type === 'url_verification' || typeof body?.challenge === 'string')) {
      return { challenge: body.challenge }
    }

    const eventType = body?.header?.event_type ?? body?.event?.type ?? ''
    if (eventType !== 'im.message.receive_v1') {
      return { ok: true, ignored: 'unsupported event type' }
    }

    const messageId = String(body?.event?.message?.message_id ?? '').trim()
    const senderType = String(body?.event?.sender?.sender_type ?? 'user').trim()
    const senderOpenId = String(body?.event?.sender?.sender_id?.open_id ?? '').trim()
    const chatId = String(body?.event?.message?.chat_id ?? '').trim() || null
    const text = parseFeishuTextContent(body?.event?.message?.content)

    if (!messageId) return { ok: true, ignored: 'missing message id' }
    if (senderType !== 'user') return { ok: true, ignored: 'non-user sender' }
    if (!senderOpenId) return { ok: true, ignored: 'missing open id' }
    if (!text) return { ok: true, ignored: 'text only for now' }

    const inserted = await reserveInboundFeishuEvent(messageId)
    if (!inserted) return { ok: true, duplicate: true }

    const relay = await findRelayBindingForInbound(senderOpenId)
    if (!relay) return { ok: true, ignored: 'no relay binding found' }

    if (!relay.feishu_open_id || relay.feishu_chat_id !== chatId) {
      await bindFeishuIdentity({
        relayId: relay.id,
        openId: senderOpenId,
        chatId,
      })
    }

    const user = await queryOne<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE id = $1',
      [relay.user_id]
    )
    if (!user) return { ok: true, ignored: 'relay user not found' }

    const channelId = await findOrCreateHumanAgentDm(relay.user_id, relay.agent_id)
    await createStoredMessage({
      channelId,
      senderId: relay.user_id,
      senderType: 'human',
      senderName: user.name,
      content: text,
    })

    return { ok: true }
  })
}
