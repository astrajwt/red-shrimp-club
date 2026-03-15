// Red Shrimp Lab — Push Notification Client
// Registers service worker, requests permission, subscribes to web-push

import { tokenStore } from './api'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

/** VAPID public key — injected at build time or fetched from backend */
let vapidPublicKey: string | null = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? null

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

async function fetchVapidKey(): Promise<string | null> {
  try {
    const token = tokenStore.getAccess()
    const res = await fetch(`${API_BASE}/push/vapid-key`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.publicKey ?? null
  } catch {
    return null
  }
}

export async function registerPushNotifications(): Promise<boolean> {
  // Check browser support
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[push] Browser does not support push notifications')
    return false
  }

  // Check permission
  if (Notification.permission === 'denied') {
    console.warn('[push] Notification permission denied')
    return false
  }

  try {
    // Register service worker
    const registration = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready

    // Get VAPID key
    if (!vapidPublicKey) {
      vapidPublicKey = await fetchVapidKey()
    }
    if (!vapidPublicKey) {
      console.warn('[push] No VAPID public key available')
      return false
    }

    // Request permission
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      console.warn('[push] Notification permission not granted')
      return false
    }

    // Subscribe
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
    })

    // Send subscription to backend
    const token = tokenStore.getAccess()
    const res = await fetch(`${API_BASE}/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(subscription.toJSON()),
    })

    if (!res.ok) {
      console.error('[push] Failed to save subscription')
      return false
    }

    console.log('[push] Push notifications registered successfully')
    return true
  } catch (err) {
    console.error('[push] Registration failed:', err)
    return false
  }
}

export async function unregisterPushNotifications(): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return

    // Unsubscribe from push
    await subscription.unsubscribe()

    // Remove from backend
    const token = tokenStore.getAccess()
    await fetch(`${API_BASE}/push/unsubscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    })
  } catch (err) {
    console.error('[push] Unregister failed:', err)
  }
}

/** Check if push is currently active */
export async function isPushEnabled(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  if (Notification.permission !== 'granted') return false

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    return subscription !== null
  } catch {
    return false
  }
}
