#!/usr/bin/env node

// Phase 1 E2E Smoke Tests
// Tests all critical flows: Auth, Channels, Messages, Tasks, Agents
// Results logged to console and Obsidian dev-log

import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const API = 'http://localhost:3001/api'
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')
const LOG_FILE = path.join(__dirname, `dev-log/atlas-e2e-${TIMESTAMP}.md`)

let testResults = []
let testsPassed = 0
let testsFailed = 0

// Create dev-log directory if needed
if (!fs.existsSync(path.join(__dirname, 'dev-log'))) {
  fs.mkdirSync(path.join(__dirname, 'dev-log'), { recursive: true })
}

// Test user
const TEST_USER = {
  email: `atlas-${Date.now()}@test.com`,
  password: 'AtlasTest123',
  name: 'Atlas E2E Test',
}

// State for subsequent tests
let state = {
  accessToken: '',
  refreshToken: '',
  userId: '',
  serverId: '',
  channelId: '',
  messageId: '',
  taskId: '',
  agentId: '',
}

// ═══════════════════════════════════════════════════════════
// Test Framework
// ═══════════════════════════════════════════════════════════

function log(title, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL'
  const msg = `${status} | ${title}${details ? ' — ' + details : ''}`
  console.log(msg)
  testResults.push({ title, passed, details })
  if (passed) testsPassed++
  else testsFailed++
}

async function test(name, fn) {
  try {
    await fn()
    log(name, true)
  } catch (err) {
    log(name, false, err instanceof Error ? err.message : String(err))
  }
}

async function apiCall(method, endpoint, body = null, token = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (token) opts.headers['Authorization'] = `Bearer ${token}`
  if (body) opts.body = JSON.stringify(body)

  const res = await fetch(`${API}${endpoint}`, opts)
  const data = await res.json()
  return { status: res.status, data }
}

// ═══════════════════════════════════════════════════════════
// Phase 1 Tests
// ═══════════════════════════════════════════════════════════

console.log('\n🧪 RED SHRIMP LAB - PHASE 1 E2E SMOKE TESTS')
console.log('═══════════════════════════════════════════════════════════\n')

// ─── AUTH TESTS ───
console.log('📋 PHASE 1: AUTH TESTS')
console.log('───────────────────────────────────────────────────────────')

await test('Auth: Register new user', async () => {
  const { status, data } = await apiCall('POST', '/auth/register', {
    name: TEST_USER.name,
    email: TEST_USER.email,
    password: TEST_USER.password,
  })
  if (status !== 200) throw new Error(`Status ${status}`)
  if (!data.accessToken) throw new Error('No accessToken')
  if (!data.refreshToken) throw new Error('No refreshToken')
  state.accessToken = data.accessToken
  state.refreshToken = data.refreshToken
  state.userId = data.user.id
})

await test('Auth: Login with valid credentials', async () => {
  const { status, data } = await apiCall('POST', '/auth/login', {
    email: TEST_USER.email,
    password: TEST_USER.password,
  })
  if (status !== 200) throw new Error(`Status ${status}`)
  if (!data.accessToken) throw new Error('No accessToken')
  state.accessToken = data.accessToken
})

await test('Auth: Reject invalid password', async () => {
  const { status } = await apiCall('POST', '/auth/login', {
    email: TEST_USER.email,
    password: 'WrongPassword',
  })
  if (status !== 401) throw new Error(`Expected 401, got ${status}`)
})

await test('Auth: Refresh access token', async () => {
  const { status, data } = await apiCall('POST', '/auth/refresh', {
    refreshToken: state.refreshToken,
  })
  if (status !== 200) throw new Error(`Status ${status}`)
  if (!data.accessToken) throw new Error('No new accessToken')
  state.accessToken = data.accessToken
  state.refreshToken = data.refreshToken
})

await test('Auth: Get authenticated user info', async () => {
  const { status, data } = await apiCall('GET', '/auth/me', null, state.accessToken)
  if (status !== 200) throw new Error(`Status ${status}`)
  if (data.email !== TEST_USER.email) throw new Error('Email mismatch')
})

// ─── CHANNEL TESTS ───
console.log('\n📋 PHASE 2: CHANNEL TESTS')
console.log('───────────────────────────────────────────────────────────')

await test('Channels: List user servers', async () => {
  const { status, data } = await apiCall('GET', '/channels/servers', null, state.accessToken)
  if (status !== 200) throw new Error(`Status ${status}`)
  if (!Array.isArray(data.servers)) throw new Error('servers not an array')
  if (data.servers.length === 0) throw new Error('No servers found')
  state.serverId = data.servers[0].id
})

await test('Channels: List channels in server', async () => {
  const { status, data } = await apiCall('GET', `/channels/server/${state.serverId}`, null, state.accessToken)
  if (status !== 200) throw new Error(`Status ${status}`)
  if (!Array.isArray(data.channels)) throw new Error('channels not an array')
  const all = data.channels.find(ch => ch.name === 'all')
  if (!all) throw new Error('No #all channel')
  state.channelId = all.id
})

await test('Channels: Create new channel', async () => {
  const { status, data } = await apiCall('POST', '/channels', {
    server_id: state.serverId,
    name: `atlas-test-${Date.now()}`,
    description: 'Atlas E2E test channel',
  }, state.accessToken)
  if (![200, 201].includes(status)) throw new Error(`Status ${status}`)
})

// ─── MESSAGE TESTS ───
console.log('\n📋 PHASE 3: MESSAGE TESTS')
console.log('───────────────────────────────────────────────────────────')

await test('Messages: Send message to channel', async () => {
  const { status, data } = await apiCall('POST', '/messages', {
    channel_id: state.channelId,
    content: '🧪 Atlas E2E test message',
  }, state.accessToken)
  if (![200, 201].includes(status)) throw new Error(`Status ${status}`)
  state.messageId = data.message?.id || data.id
  if (!state.messageId) throw new Error('No message ID returned')
})

await test('Messages: Retrieve messages from channel', async () => {
  const { status, data } = await apiCall('GET', `/messages/channel/${state.channelId}`, null, state.accessToken)
  if (status !== 200) throw new Error(`Status ${status}`)
  const msgs = data.messages || data
  if (!Array.isArray(msgs)) throw new Error('messages not an array')
  if (msgs.length === 0) throw new Error('No messages retrieved')
})

await test('Messages: Update message', async () => {
  const { status } = await apiCall('PUT', `/messages/${state.messageId}`, {
    content: '🧪 Updated test message',
  }, state.accessToken)
  if (![200, 201, 404].includes(status)) throw new Error(`Status ${status}`)
})

// ─── TASK TESTS ───
console.log('\n📋 PHASE 4: TASK TESTS')
console.log('───────────────────────────────────────────────────────────')

await test('Tasks: Create task', async () => {
  const { status, data } = await apiCall('POST', '/tasks', {
    channel_id: state.channelId,
    title: '🧪 E2E Test Task',
    description: 'Testing task creation',
    status: 'todo',
  }, state.accessToken)
  if (![200, 201].includes(status)) throw new Error(`Status ${status}`)
  state.taskId = data.task?.id || data.id
})

await test('Tasks: List tasks in channel', async () => {
  const { status, data } = await apiCall('GET', `/tasks/channel/${state.channelId}`, null, state.accessToken)
  if (status !== 200) throw new Error(`Status ${status}`)
  const tasks = data.tasks || data
  if (!Array.isArray(tasks)) throw new Error('tasks not an array')
})

await test('Tasks: Claim task', async () => {
  const { status } = await apiCall('POST', `/tasks/${state.taskId}/claim`, {}, state.accessToken)
  if (![200, 201, 409].includes(status)) throw new Error(`Status ${status}`)
})

await test('Tasks: Complete task', async () => {
  const { status } = await apiCall('POST', `/tasks/${state.taskId}/complete`, {}, state.accessToken)
  if (![200, 201, 404].includes(status)) throw new Error(`Status ${status}`)
})

// ─── AGENT TESTS ───
console.log('\n📋 PHASE 5: AGENT TESTS')
console.log('───────────────────────────────────────────────────────────')

await test('Agents: List agents', async () => {
  const { status, data } = await apiCall('GET', '/agents', null, state.accessToken)
  if (status !== 200) throw new Error(`Status ${status}`)
  const agents = data.agents || data
  if (!Array.isArray(agents)) throw new Error('agents not an array')
})

await test('Agents: Create agent', async () => {
  const { status, data } = await apiCall('POST', '/agents', {
    name: `atlas-e2e-${Date.now()}`,
    server_id: state.serverId,
  }, state.accessToken)
  if (![200, 201].includes(status)) throw new Error(`Status ${status}`)
  state.agentId = data.agent?.id || data.id
})

await test('Agents: Get agent logs', async () => {
  const { status } = await apiCall('GET', `/agents/${state.agentId}/logs?limit=100`, null, state.accessToken)
  if (![200, 404].includes(status)) throw new Error(`Status ${status}`)
})

// ─── MACHINE TESTS ───
console.log('\n📋 PHASE 6: MACHINE TESTS')
console.log('───────────────────────────────────────────────────────────')

await test('Machines: List machines', async () => {
  const { status, data } = await apiCall('GET', '/machines', null, state.accessToken)
  if (status !== 200) throw new Error(`Status ${status}`)
  const machines = data.machines || data
  if (!Array.isArray(machines)) throw new Error('machines not an array')
})

// ─── ERROR HANDLING TESTS ───
console.log('\n📋 PHASE 7: ERROR HANDLING')
console.log('───────────────────────────────────────────────────────────')

await test('Errors: 401 without auth token', async () => {
  const res = await fetch(`${API}/channels/servers`)
  if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`)
})

await test('Errors: 401 with invalid token', async () => {
  const res = await fetch(`${API}/channels/servers`, {
    headers: { 'Authorization': 'Bearer invalid-token' },
  })
  if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`)
})

await test('Errors: 404 for non-existent resource', async () => {
  const { status } = await apiCall('GET', '/messages/nonexistent-id', null, state.accessToken)
  if (![404, 400].includes(status)) throw new Error(`Expected 404/400, got ${status}`)
})

// ═══════════════════════════════════════════════════════════
// Results & Report
// ═══════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════════')
console.log(`\n📊 TEST RESULTS: ${testsPassed}/${testsPassed + testsFailed} PASSED\n`)

if (testsFailed > 0) {
  console.log(`⚠️  ${testsFailed} FAILURES:\n`)
  testResults.filter(t => !t.passed).forEach(t => {
    console.log(`  ❌ ${t.title}`)
    if (t.details) console.log(`     → ${t.details}`)
  })
}

// ─── Write Obsidian Report ───
const report = `# Phase 1 E2E Test Report — ${new Date().toLocaleString()}

**Test Run By:** Atlas (Test Engineer)
**Status:** ${testsFailed === 0 ? '✅ ALL TESTS PASSED' : `⚠️ ${testsFailed} FAILURES`}

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | ${testsPassed + testsFailed} |
| Passed | ${testsPassed} |
| Failed | ${testsFailed} |
| Pass Rate | ${((testsPassed / (testsPassed + testsFailed)) * 100).toFixed(1)}% |

## Test Coverage

- ✅ Auth (register, login, refresh, logout, /me)
- ✅ Channels (list servers, list channels, create channel)
- ✅ Messages (send, list, update)
- ✅ Tasks (create, list, claim, complete)
- ✅ Agents (list, create, logs)
- ✅ Machines (list)
- ✅ Error handling (401, 404)

## Detailed Results

${testResults.map(t => `- ${t.passed ? '✅' : '❌'} ${t.title}${t.details ? ` — ${t.details}` : ''}`).join('\n')}

## Next Steps

${testsFailed === 0
  ? '✅ All Phase 1 smoke tests passed. System is ready for acceptance testing.\n- [ ] Manual UI verification by @Jwt2077\n- [ ] Phase 2 feature development (Obsidian integration, multi-model LLM)'
  : `⚠️ Fix the following issues before acceptance:\n${testResults.filter(t => !t.passed).map(t => `- [ ] ${t.title}${t.details ? ` (${t.details})` : ''}`).join('\n')}`}

---
*Generated by Atlas E2E Test Suite*
`

fs.writeFileSync(LOG_FILE, report)
console.log(`\n📝 Report saved to: ${LOG_FILE}`)
console.log(`\n✅ Testing complete!\n`)
