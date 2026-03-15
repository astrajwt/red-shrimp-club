// Red Shrimp Lab — Service Worker
// Handles push notifications and basic offline caching

const CACHE_NAME = 'redshrimp-v1'
const PRECACHE_URLS = ['/', '/index.html']

// ── Install ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  )
})

// ── Activate ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  )
})

// ── Fetch — network-first, fallback to cache ──
self.addEventListener('fetch', (event) => {
  // Skip non-GET and API requests
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache successful responses
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return response
      })
      .catch(() => caches.match(event.request).then(r => r || caches.match('/index.html')))
  )
})

// ── Push Notification ──
self.addEventListener('push', (event) => {
  let data = { title: '红虾俱乐部', body: '新消息', url: '/' }

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() }
    } catch {
      data.body = event.data.text()
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'redshrimp-default',
      renotify: true,
      data: { url: data.url || '/' },
      actions: [
        { action: 'open', title: '查看' },
      ],
    })
  )
})

// ── Notification Click ──
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const url = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Focus existing window if possible
        for (const client of clients) {
          if (client.url.includes(self.location.origin)) {
            client.focus()
            client.postMessage({
              type: 'notification-click',
              url,
            })
            return
          }
        }
        // Otherwise open new window
        return self.clients.openWindow(url)
      })
  )
})
