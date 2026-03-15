// Red Shrimp Lab — Web Push Notification Service
// Sends push notifications to subscribed clients using web-push

import webpush from 'web-push'
import { query } from '../db/client.js'

// ── VAPID Setup ──
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  ?? ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     ?? 'mailto:admin@redshrimp.local'

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY
}

// ── Subscription Management ──

interface PushSubscriptionData {
  endpoint: string
  keys: { p256dh: string; auth: string }
  expirationTime?: number | null
}

export async function saveSubscription(userId: string, sub: PushSubscriptionData): Promise<void> {
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = $1, p256dh = $3, auth = $4, created_at = NOW()`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  )
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint])
}

// ── Sending Notifications ──

interface PushPayload {
  title: string
  body: string
  tag?: string
  url?: string
}

async function getSubscriptionsForUsers(userIds: string[]): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
  if (userIds.length === 0) return []
  const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',')
  return query<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${placeholders})`,
    userIds
  )
}

async function getAllSubscriptions(): Promise<Array<{ endpoint: string; p256dh: string; auth: string }>> {
  return query<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions`
  )
}

async function sendToSubscriptions(
  subs: Array<{ endpoint: string; p256dh: string; auth: string }>,
  payload: PushPayload
): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return

  const body = JSON.stringify(payload)

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          body
        )
      } catch (err: any) {
        // 410 Gone or 404 = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await removeSubscription(sub.endpoint)
        }
      }
    })
  )
}

// ── High-level notification functions ──

/** Notify channel members about a new message (except sender) */
export async function notifyNewMessage(params: {
  channelId: string
  senderId: string
  senderName: string
  senderType: string
  content: string
}): Promise<void> {
  // Get human members of this channel (except the sender)
  const members = await query<{ user_id: string }>(
    `SELECT user_id FROM channel_members
     WHERE channel_id = $1 AND member_type = 'human' AND user_id != $2`,
    [params.channelId, params.senderId]
  )

  if (members.length === 0) {
    // Broadcast to all subscriptions if no specific members (e.g. public channel)
    const subs = await getAllSubscriptions()
    if (subs.length === 0) return
    await sendToSubscriptions(subs, {
      title: `${params.senderName}`,
      body: params.content.length > 120 ? params.content.slice(0, 117) + '...' : params.content,
      tag: `msg-${params.channelId}`,
      url: `/?channel=${params.channelId}`,
    })
    return
  }

  const userIds = members.map(m => m.user_id)
  const subs = await getSubscriptionsForUsers(userIds)
  if (subs.length === 0) return

  await sendToSubscriptions(subs, {
    title: `${params.senderName}`,
    body: params.content.length > 120 ? params.content.slice(0, 117) + '...' : params.content,
    tag: `msg-${params.channelId}`,
    url: `/?channel=${params.channelId}`,
  })
}

/** Notify about task status changes */
export async function notifyTaskUpdate(params: {
  taskId: string
  channelId: string
  title: string
  status: string
  agentId?: string
}): Promise<void> {
  const statusLabels: Record<string, string> = {
    'reviewing': '等待审核',
    'completed': '已完成',
    'in_progress': '进行中',
    'open': '已创建',
  }

  // Get all human subscribers (personal use, just notify everyone)
  const subs = await getAllSubscriptions()
  if (subs.length === 0) return

  await sendToSubscriptions(subs, {
    title: `任务${statusLabels[params.status] ?? params.status}`,
    body: params.title.length > 120 ? params.title.slice(0, 117) + '...' : params.title,
    tag: `task-${params.taskId}`,
    url: `/?page=tasks`,
  })
}

/** Notify when an agent crashes */
export async function notifyAgentCrash(params: {
  agentId: string
  agentName: string
}): Promise<void> {
  const subs = await getAllSubscriptions()
  if (subs.length === 0) return

  await sendToSubscriptions(subs, {
    title: 'Agent 异常',
    body: `${params.agentName} 已崩溃`,
    tag: `agent-crash-${params.agentId}`,
    url: `/?page=agents`,
  })
}
