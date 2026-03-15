// Red Shrimp Lab — Push Notification Routes
// POST /api/push/subscribe — save push subscription
// POST /api/push/unsubscribe — remove push subscription
// GET  /api/push/vapid-key — get VAPID public key

import type { FastifyInstance } from 'fastify'
import {
  saveSubscription,
  removeSubscription,
  getVapidPublicKey,
} from '../services/push-notifications.js'

export async function pushRoutes(app: FastifyInstance) {
  // Get VAPID public key (no auth required — needed before login on iOS)
  app.get('/vapid-key', async () => {
    return { publicKey: getVapidPublicKey() }
  })

  // Save push subscription
  app.post('/subscribe', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const caller = (req as any).user as { sub: string }
    const body = req.body as {
      endpoint: string
      keys: { p256dh: string; auth: string }
      expirationTime?: number | null
    }

    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return { error: 'Invalid subscription data' }
    }

    await saveSubscription(caller.sub, body)
    return { ok: true }
  })

  // Remove push subscription
  app.post('/unsubscribe', {
    preHandler: [app.authenticate],
  }, async (req) => {
    const { endpoint } = req.body as { endpoint: string }
    if (!endpoint) return { error: 'Missing endpoint' }

    await removeSubscription(endpoint)
    return { ok: true }
  })
}
