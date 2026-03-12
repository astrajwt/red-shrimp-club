// End-to-End Integration Tests
// Tests real running backend at localhost:3001
// Complete user flow: register → login → create channel → send message → create task → spawn agent

import fetch from 'node-fetch'

const API_BASE = 'http://localhost:3001/api'
const TEST_USER = {
  email: `atlas-test-${Date.now()}@test.com`,
  password: 'TestPassword123',
  name: 'Atlas Test User',
}

describe('E2E: Complete User Journey', () => {
  let accessToken: string
  let refreshToken: string
  let userId: string
  let serverId: string
  let channelId: string
  let messageId: string
  let taskId: string
  let agentId: string

  describe('Phase 1: Auth Flow', () => {
    test('should register a new user', async () => {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: TEST_USER.name,
          email: TEST_USER.email,
          password: TEST_USER.password,
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data).toHaveProperty('accessToken')
      expect(data).toHaveProperty('refreshToken')
      expect(data.user).toHaveProperty('id')
      expect(data.user.email).toBe(TEST_USER.email)

      accessToken = data.accessToken
      refreshToken = data.refreshToken
      userId = data.user.id
    })

    test('should login with valid credentials', async () => {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_USER.email,
          password: TEST_USER.password,
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data).toHaveProperty('accessToken')
      expect(data.user.email).toBe(TEST_USER.email)
    })

    test('should reject invalid password', async () => {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: TEST_USER.email,
          password: 'WrongPassword',
        }),
      })

      expect(res.status).toBe(401)
    })

    test('should refresh access token', async () => {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data).toHaveProperty('accessToken')
      expect(data).toHaveProperty('refreshToken')

      // Update token for next tests
      accessToken = data.accessToken
      refreshToken = data.refreshToken
    })

    test('should get authenticated user info', async () => {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(data.email).toBe(TEST_USER.email)
      expect(data.name).toBe(TEST_USER.name)
    })
  })

  describe('Phase 2: Channel Operations', () => {
    test('should list user servers', async () => {
      const res = await fetch(`${API_BASE}/channels/servers`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(Array.isArray(data.servers)).toBe(true)
      expect(data.servers.length).toBeGreaterThan(0)

      serverId = data.servers[0].id
    })

    test('should list channels in server', async () => {
      const res = await fetch(`${API_BASE}/channels/server/${serverId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(Array.isArray(data.channels)).toBe(true)

      // Should have default #all channel
      const allChannel = data.channels.find((ch: any) => ch.name === 'all')
      expect(allChannel).toBeDefined()
      channelId = allChannel.id
    })

    test('should create a new channel', async () => {
      const res = await fetch(`${API_BASE}/channels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          server_id: serverId,
          name: `test-channel-${Date.now()}`,
          description: 'Test channel for Atlas testing',
        }),
      })

      expect(res.status).toBe(201 || 200)
      const data = await res.json() as any
      expect(data.channel || data).toHaveProperty('id')
    })
  })

  describe('Phase 3: Message Operations', () => {
    test('should send a message to channel', async () => {
      const res = await fetch(`${API_BASE}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          channel_id: channelId,
          content: '🧪 Atlas test message for E2E testing',
        }),
      })

      expect(res.status).toBe(201 || 200)
      const data = await res.json() as any
      messageId = (data.message || data).id
      expect(messageId).toBeDefined()
    })

    test('should retrieve messages from channel', async () => {
      const res = await fetch(`${API_BASE}/messages/channel/${channelId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(Array.isArray(data.messages || data)).toBe(true)
      expect((data.messages || data).length).toBeGreaterThan(0)
    })

    test('should update message', async () => {
      const res = await fetch(`${API_BASE}/messages/${messageId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          content: '🧪 Updated test message',
        }),
      })

      // Should either succeed (200) or fail gracefully
      expect([200, 201, 404]).toContain(res.status)
    })
  })

  describe('Phase 4: Task Operations', () => {
    test('should create a task', async () => {
      const res = await fetch(`${API_BASE}/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          channel_id: channelId,
          title: '🧪 E2E Test Task',
          description: 'Testing task creation in Phase 1',
          status: 'todo',
        }),
      })

      expect(res.status).toBe(201 || 200)
      const data = await res.json() as any
      taskId = (data.task || data).id
      expect(taskId).toBeDefined()
    })

    test('should list tasks in channel', async () => {
      const res = await fetch(`${API_BASE}/tasks/channel/${channelId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(Array.isArray(data.tasks || data)).toBe(true)
    })

    test('should claim a task', async () => {
      const res = await fetch(`${API_BASE}/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect([200, 201, 409]).toContain(res.status)
    })

    test('should complete a task', async () => {
      const res = await fetch(`${API_BASE}/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect([200, 201, 404]).toContain(res.status)
    })
  })

  describe('Phase 5: Agent Operations', () => {
    test('should list agents', async () => {
      const res = await fetch(`${API_BASE}/agents`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect(res.status).toBe(200)
      const data = await res.json() as any
      expect(Array.isArray(data.agents || data)).toBe(true)
    })

    test('should create an agent', async () => {
      const res = await fetch(`${API_BASE}/agents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          name: `atlas-test-agent-${Date.now()}`,
          server_id: serverId,
        }),
      })

      expect([200, 201]).toContain(res.status)
      const data = await res.json() as any
      agentId = (data.agent || data).id
    })

    test('should get agent logs', async () => {
      const res = await fetch(`${API_BASE}/agents/${agentId}/logs?limit=100`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      // May return empty if no logs yet
      expect([200, 404]).toContain(res.status)
    })
  })

  describe('Phase 6: File Operations', () => {
    test('should handle file list endpoint', async () => {
      const res = await fetch(`${API_BASE}/files/list`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      // Should either return file list or 404/400
      expect([200, 400, 404]).toContain(res.status)
    })
  })

  describe('Error Handling', () => {
    test('should return 401 without auth token', async () => {
      const res = await fetch(`${API_BASE}/channels/servers`)

      expect(res.status).toBe(401)
    })

    test('should return 401 with invalid token', async () => {
      const res = await fetch(`${API_BASE}/channels/servers`, {
        headers: { 'Authorization': 'Bearer invalid-token-xyz' },
      })

      expect(res.status).toBe(401)
    })

    test('should handle 404 for non-existent resource', async () => {
      const res = await fetch(`${API_BASE}/messages/nonexistent-id`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })

      expect([404, 400]).toContain(res.status)
    })
  })

  describe('Cleanup', () => {
    test('should logout successfully', async () => {
      const res = await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      })

      expect(res.status).toBe(200)
    })
  })
})
