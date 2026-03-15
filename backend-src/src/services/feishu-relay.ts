import { query, queryOne } from '../db/client.js'

interface TenantAccessTokenResponse {
  code?: number
  msg?: string
  tenant_access_token?: string
  expire?: number
}

export interface FeishuRelayBindingRow {
  id: string
  user_id: string
  server_id: string
  agent_id: string
  agent_name: string
  feishu_open_id: string | null
  feishu_chat_id: string | null
  enabled: boolean
  created_at: string
  updated_at: string
}

let tokenCache: { token: string; expiresAt: number } | null = null

function envTrim(name: string): string {
  return process.env[name]?.trim() ?? ''
}

export function feishuConfigStatus() {
  return {
    appId: envTrim('FEISHU_APP_ID'),
    appSecretSet: !!envTrim('FEISHU_APP_SECRET'),
    verificationTokenSet: !!envTrim('FEISHU_VERIFICATION_TOKEN'),
  }
}

export function isFeishuConfigured(): boolean {
  return !!envTrim('FEISHU_APP_ID') && !!envTrim('FEISHU_APP_SECRET')
}

function verificationTokenMatches(body: any): boolean {
  const expected = envTrim('FEISHU_VERIFICATION_TOKEN')
  if (!expected) return true
  const candidate = String(body?.token ?? body?.header?.token ?? '').trim()
  return !!candidate && candidate === expected
}

async function getTenantAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token

  const appId = envTrim('FEISHU_APP_ID')
  const appSecret = envTrim('FEISHU_APP_SECRET')
  if (!appId || !appSecret) throw new Error('Feishu relay is not configured')

  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  if (!res.ok) {
    throw new Error(`Feishu token request failed with HTTP ${res.status}`)
  }

  const data = await res.json() as TenantAccessTokenResponse
  if (!data.tenant_access_token || data.code !== 0) {
    throw new Error(data.msg || 'Feishu token response missing tenant_access_token')
  }

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, (data.expire ?? 7200) - 60) * 1000,
  }
  return tokenCache.token
}

export async function sendFeishuText(params: { openId?: string | null; chatId?: string | null; text: string }): Promise<void> {
  const text = params.text.trim()
  if (!text) return

  const receiveId = params.chatId?.trim() || params.openId?.trim()
  if (!receiveId) throw new Error('No Feishu receive target is bound yet')

  const receiveType = params.chatId?.trim() ? 'chat_id' : 'open_id'
  const accessToken = await getTenantAccessToken()
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  })

  if (!res.ok) {
    throw new Error(`Feishu send message failed with HTTP ${res.status}`)
  }

  const data = await res.json() as { code?: number; msg?: string }
  if (data.code !== 0) {
    throw new Error(data.msg || 'Feishu send message failed')
  }
}

export async function getFeishuRelayForUser(userId: string): Promise<FeishuRelayBindingRow | null> {
  return queryOne<FeishuRelayBindingRow>(
    `SELECT fr.id,
            fr.user_id,
            fr.server_id,
            fr.agent_id,
            a.name AS agent_name,
            fr.feishu_open_id,
            fr.feishu_chat_id,
            fr.enabled,
            fr.created_at,
            fr.updated_at
       FROM feishu_relay_bindings fr
       JOIN agents a ON a.id = fr.agent_id
      WHERE fr.user_id = $1`,
    [userId]
  )
}

export async function defaultRelayAgentForUser(userId: string): Promise<{ id: string; name: string; server_id: string } | null> {
  return queryOne<{ id: string; name: string; server_id: string }>(
    `SELECT a.id, a.name, a.server_id
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
      WHERE a.role = 'ops' OR LOWER(a.name) = 'akara'
      ORDER BY CASE WHEN LOWER(a.name) = 'akara' THEN 0 ELSE 1 END, a.created_at ASC
      LIMIT 1`,
    [userId]
  )
}

export async function upsertFeishuRelayBinding(params: {
  userId: string
  agentId: string
  enabled: boolean
  resetBinding?: boolean
}): Promise<FeishuRelayBindingRow> {
  const agent = await queryOne<{ id: string; name: string; server_id: string }>(
    `SELECT a.id, a.name, a.server_id
       FROM agents a
       JOIN server_members sm ON sm.server_id = a.server_id AND sm.user_id = $1
      WHERE a.id = $2`,
    [params.userId, params.agentId]
  )
  if (!agent) throw new Error('Relay agent not found in your server')

  await query(
    `INSERT INTO feishu_relay_bindings (user_id, server_id, agent_id, enabled, feishu_open_id, feishu_chat_id)
     VALUES ($1, $2, $3, $4, NULL, NULL)
     ON CONFLICT (user_id)
     DO UPDATE SET
       server_id = EXCLUDED.server_id,
       agent_id = EXCLUDED.agent_id,
       enabled = EXCLUDED.enabled,
       feishu_open_id = CASE WHEN $5 THEN NULL ELSE feishu_relay_bindings.feishu_open_id END,
       feishu_chat_id = CASE WHEN $5 THEN NULL ELSE feishu_relay_bindings.feishu_chat_id END,
       updated_at = NOW()`,
    [params.userId, agent.server_id, agent.id, params.enabled, params.resetBinding === true]
  )

  const binding = await getFeishuRelayForUser(params.userId)
  if (!binding) throw new Error('Relay binding could not be created')
  return binding
}

export async function bindFeishuIdentity(params: {
  relayId: string
  openId: string
  chatId?: string | null
}): Promise<void> {
  await query(
    `UPDATE feishu_relay_bindings
        SET feishu_open_id = $2,
            feishu_chat_id = COALESCE($3, feishu_chat_id),
            updated_at = NOW()
      WHERE id = $1`,
    [params.relayId, params.openId, params.chatId ?? null]
  )
}

export async function findRelayBindingForInbound(openId: string): Promise<FeishuRelayBindingRow | null> {
  const direct = await queryOne<FeishuRelayBindingRow>(
    `SELECT fr.id,
            fr.user_id,
            fr.server_id,
            fr.agent_id,
            a.name AS agent_name,
            fr.feishu_open_id,
            fr.feishu_chat_id,
            fr.enabled,
            fr.created_at,
            fr.updated_at
       FROM feishu_relay_bindings fr
       JOIN agents a ON a.id = fr.agent_id
      WHERE fr.enabled = TRUE
        AND fr.feishu_open_id = $1
      LIMIT 1`,
    [openId]
  )
  if (direct) return direct

  const pending = await query<FeishuRelayBindingRow>(
    `SELECT fr.id,
            fr.user_id,
            fr.server_id,
            fr.agent_id,
            a.name AS agent_name,
            fr.feishu_open_id,
            fr.feishu_chat_id,
            fr.enabled,
            fr.created_at,
            fr.updated_at
       FROM feishu_relay_bindings fr
       JOIN agents a ON a.id = fr.agent_id
      WHERE fr.enabled = TRUE
        AND fr.feishu_open_id IS NULL
      ORDER BY fr.updated_at DESC`,
    []
  )
  return pending.length === 1 ? pending[0] : null
}

export async function reserveInboundFeishuEvent(messageId: string): Promise<boolean> {
  const rows = await query<{ message_id: string }>(
    `INSERT INTO feishu_inbound_events (message_id)
     VALUES ($1)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING message_id`,
    [messageId]
  )
  return rows.length > 0
}

export async function findOrCreateHumanAgentDm(userId: string, agentId: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    `SELECT c.id
       FROM channels c
       JOIN channel_members cm1 ON cm1.channel_id = c.id AND cm1.user_id = $1
       JOIN channel_members cm2 ON cm2.channel_id = c.id AND cm2.agent_id = $2
      WHERE c.type = 'dm'
      LIMIT 1`,
    [userId, agentId]
  )
  if (existing) return existing.id

  const [channel] = await query<{ id: string }>(
    `INSERT INTO channels (server_id, name, type)
     SELECT a.server_id, $1, 'dm'
       FROM agents a
      WHERE a.id = $2
      LIMIT 1
     RETURNING id`,
    [`dm-${Date.now()}`, agentId]
  )
  await query(
    `INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [channel.id, userId]
  )
  await query(
    `INSERT INTO channel_members (channel_id, agent_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [channel.id, agentId]
  )
  return channel.id
}

export async function relayInternalMessageToFeishu(params: {
  channelId: string
  senderId: string
  senderType: string
  senderName: string
  content: string
}): Promise<void> {
  if (params.senderType !== 'agent' || !isFeishuConfigured()) return

  const binding = await queryOne<{
    id: string
    feishu_open_id: string | null
    feishu_chat_id: string | null
  }>(
    `SELECT fr.id, fr.feishu_open_id, fr.feishu_chat_id
       FROM feishu_relay_bindings fr
       JOIN channels c ON c.id = $1 AND c.type = 'dm'
       JOIN channel_members cm_user ON cm_user.channel_id = c.id AND cm_user.user_id = fr.user_id
       JOIN channel_members cm_agent ON cm_agent.channel_id = c.id AND cm_agent.agent_id = fr.agent_id
      WHERE fr.enabled = TRUE
        AND fr.agent_id = $2
      LIMIT 1`,
    [params.channelId, params.senderId]
  )
  if (!binding || (!binding.feishu_chat_id && !binding.feishu_open_id)) return

  await sendFeishuText({
    chatId: binding.feishu_chat_id,
    openId: binding.feishu_open_id,
    text: `${params.senderName}: ${params.content.trim()}`,
  })
}

export function assertFeishuWebhook(body: any): void {
  if (!verificationTokenMatches(body)) {
    throw new Error('Invalid Feishu verification token')
  }
}

