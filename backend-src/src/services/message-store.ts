import { query, queryOne } from '../db/client.js'
import { broadcastMessage } from '../socket/index.js'
import { notifyAgentMembers } from './agent-delivery.js'
import { relayInternalMessageToFeishu } from './feishu-relay.js'

export type MessageSenderType = 'human' | 'agent'

export interface CreateStoredMessageParams {
  channelId: string
  senderId: string
  senderType: MessageSenderType
  senderName: string
  content: string
  attachments?: unknown[]
  mentions?: unknown[]
  thinking?: string | null
}

export async function createStoredMessage(params: CreateStoredMessageParams) {
  const {
    channelId,
    senderId,
    senderType,
    senderName,
    content,
    attachments = [],
    mentions = [],
    thinking = null,
  } = params

  const seqRow = await queryOne<{ last_seq: string }>(
    `INSERT INTO channel_sequences (channel_id, last_seq) VALUES ($1, 1)
     ON CONFLICT (channel_id) DO UPDATE SET last_seq = channel_sequences.last_seq + 1
     RETURNING last_seq`,
    [channelId]
  )
  const seq = Number(seqRow?.last_seq ?? 1)

  const [msg] = await query(
    `INSERT INTO messages
       (channel_id, sender_id, sender_type, sender_name, content, seq, attachments, mentions, thinking)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      channelId,
      senderId,
      senderType,
      senderName,
      content.trim(),
      seq,
      JSON.stringify(attachments),
      JSON.stringify(mentions),
      thinking,
    ]
  )

  broadcastMessage(channelId, msg)
  // Only notify agents for human messages.
  // Agent-to-agent: agents pick up via receive_message polling + @mention.
  // This prevents chain reactions where agent A's reply wakes agent B.
  if (senderType === 'human') {
    await notifyAgentMembers({
      channelId,
      senderId,
      senderName,
      senderType,
      content: msg.content,
      timestamp: msg.created_at,
    })
  }

  void relayInternalMessageToFeishu({
    channelId,
    senderId,
    senderType,
    senderName,
    content: msg.content,
  }).catch((err: any) => {
    console.error(`[feishu-relay] outbound relay failed: ${err.message}`)
  })

  return msg
}

