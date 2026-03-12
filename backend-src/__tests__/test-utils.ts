/**
 * Shared Test Utilities for Phase 2 Tests
 *
 * Common helpers for:
 * - Test user creation and authentication
 * - Channel and message setup
 * - Task creation and management
 * - Agent spawning
 * - WebSocket client setup
 *
 * @usage
 * import { createTestUser, createTestChannel, createTestMessage } from './test-utils'
 *
 * const user = await createTestUser('test@example.com')
 * const channel = await createTestChannel(user.server_id)
 * const message = await createTestMessage(channel.id, 'Hello')
 */

import request from 'supertest'
import { Socket, io } from 'socket.io-client'
import { app } from '../src/server'

// ─────────────────────────────────────────────────────────────────────────
// Test User Management
// ─────────────────────────────────────────────────────────────────────────

export interface TestUser {
  id: string
  email: string
  server_id: string
  access_token: string
  refresh_token: string
}

/**
 * Create a test user with auto-generated email and credentials
 *
 * @param email Optional email (default: test-{timestamp}@test.local)
 * @returns User object with tokens
 */
export async function createTestUser(email?: string): Promise<TestUser> {
  const testEmail = email || `test-${Date.now()}@test.local`
  const password = 'test1234'

  // Register user
  const registerRes = await request(app)
    .post('/api/auth/register')
    .send({
      email: testEmail,
      password,
      displayName: testEmail.split('@')[0],
    })

  if (registerRes.status !== 201) {
    throw new Error(`Failed to create test user: ${registerRes.status} ${registerRes.text}`)
  }

  const { user, accessToken, refreshToken, server_id } = registerRes.body

  return {
    id: user.id,
    email: testEmail,
    server_id,
    access_token: accessToken,
    refresh_token: refreshToken,
  }
}

/**
 * Create multiple test users for multi-client tests
 *
 * @param count Number of users to create
 * @returns Array of test users
 */
export async function createTestUsers(count: number): Promise<TestUser[]> {
  const users: TestUser[] = []
  for (let i = 0; i < count; i++) {
    const user = await createTestUser()
    users.push(user)
  }
  return users
}

/**
 * Authenticate as a test user (simulate login)
 *
 * @param email Email to login with
 * @param password Password (default: test1234)
 * @returns Login response with tokens
 */
export async function loginTestUser(email: string, password = 'test1234') {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password })

  if (res.status !== 200) {
    throw new Error(`Failed to login: ${res.status}`)
  }

  return res.body
}

// ─────────────────────────────────────────────────────────────────────────
// Channel Management
// ─────────────────────────────────────────────────────────────────────────

export interface TestChannel {
  id: string
  name: string
  type: 'channel' | 'dm'
  server_id: string
}

/**
 * Create a test channel
 *
 * @param server_id Server ID (from user)
 * @param name Channel name (default: test-channel-{timestamp})
 * @param token Auth token
 * @returns Channel object
 */
export async function createTestChannel(
  server_id: string,
  name?: string,
  token?: string
): Promise<TestChannel> {
  const channelName = name || `test-channel-${Date.now()}`

  const res = await request(app)
    .post('/api/channels')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: channelName,
      type: 'channel',
      server_id,
    })

  if (res.status !== 201 && res.status !== 200) {
    // Note: API may return existing #all channel
    console.warn(`Channel creation returned ${res.status}`)
  }

  const channel = res.body.channel || res.body

  return {
    id: channel.id,
    name: channel.name,
    type: channel.type || 'channel',
    server_id,
  }
}

/**
 * Get default #all channel for a server
 *
 * @param server_id Server ID
 * @param token Auth token
 * @returns Channel object
 */
export async function getDefaultChannel(server_id: string, token: string): Promise<TestChannel> {
  const res = await request(app)
    .get('/api/channels')
    .set('Authorization', `Bearer ${token}`)

  if (res.status !== 200) {
    throw new Error(`Failed to fetch channels: ${res.status}`)
  }

  const channels = res.body.channels || res.body
  const allChannel = channels.find((c: any) => c.name === '#all' || c.name === 'all')

  if (!allChannel) {
    throw new Error('No #all channel found')
  }

  return {
    id: allChannel.id,
    name: allChannel.name,
    type: 'channel',
    server_id,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Message Management
// ─────────────────────────────────────────────────────────────────────────

export interface TestMessage {
  id: string
  content: string
  channel_id: string
  sender_id: string
  created_at: string
}

/**
 * Send a test message
 *
 * @param channel_id Channel ID
 * @param content Message content
 * @param token Auth token
 * @returns Message object
 */
export async function createTestMessage(
  channel_id: string,
  content: string,
  token: string
): Promise<TestMessage> {
  const res = await request(app)
    .post('/api/messages')
    .set('Authorization', `Bearer ${token}`)
    .send({
      channelId: channel_id,
      content,
    })

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Failed to create message: ${res.status} ${res.text}`)
  }

  const message = res.body.message || res.body

  return {
    id: message.id,
    content: message.content,
    channel_id: message.channel_id,
    sender_id: message.sender_id,
    created_at: message.created_at,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Task Management
// ─────────────────────────────────────────────────────────────────────────

export interface TestTask {
  id: string
  title: string
  channel_id: string
  status: string
}

/**
 * Create a test task
 *
 * @param channel_id Channel ID
 * @param title Task title
 * @param token Auth token
 * @returns Task object
 */
export async function createTestTask(
  channel_id: string,
  title: string,
  token: string
): Promise<TestTask> {
  const res = await request(app)
    .post('/api/tasks')
    .set('Authorization', `Bearer ${token}`)
    .send({
      channelId: channel_id,
      tasks: [{ title }],
    })

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Failed to create task: ${res.status} ${res.text}`)
  }

  const tasks = res.body.tasks || [res.body]
  const task = tasks[0]

  return {
    id: task.id,
    title: task.title,
    channel_id: task.channel_id,
    status: task.status || 'open',
  }
}

/**
 * Claim a task (assign to user)
 *
 * @param task_id Task ID
 * @param token Auth token
 * @returns Updated task
 */
export async function claimTestTask(task_id: string, token: string) {
  const res = await request(app)
    .post(`/api/tasks/${task_id}/claim`)
    .set('Authorization', `Bearer ${token}`)

  if (res.status !== 200) {
    throw new Error(`Failed to claim task: ${res.status}`)
  }

  return res.body.task || res.body
}

/**
 * Complete a task
 *
 * @param task_id Task ID
 * @param token Auth token
 * @returns Updated task
 */
export async function completeTestTask(task_id: string, token: string) {
  const res = await request(app)
    .post(`/api/tasks/${task_id}/complete`)
    .set('Authorization', `Bearer ${token}`)

  if (res.status !== 200) {
    throw new Error(`Failed to complete task: ${res.status}`)
  }

  return res.body.task || res.body
}

// ─────────────────────────────────────────────────────────────────────────
// Agent Management
// ─────────────────────────────────────────────────────────────────────────

export interface TestAgent {
  id: string
  name: string
  role: string
  status: string
}

/**
 * Spawn a test agent
 *
 * @param server_id Server ID
 * @param name Agent name
 * @param role Agent role (developer|tester|pm|general)
 * @param token Auth token
 * @returns Agent object
 */
export async function spawnTestAgent(
  server_id: string,
  name: string,
  role: string = 'general',
  token: string
): Promise<TestAgent> {
  const res = await request(app)
    .post('/api/agents')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name,
      role,
      server_id,
    })

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Failed to spawn agent: ${res.status} ${res.text}`)
  }

  const agent = res.body.agent || res.body

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status || 'idle',
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WebSocket Client Management
// ─────────────────────────────────────────────────────────────────────────

/**
 * Create and connect a WebSocket client
 *
 * @param token Auth token
 * @param url Server URL (default: http://localhost:3001)
 * @returns Connected Socket.io client
 */
export async function createWebSocketClient(token: string, url = 'http://localhost:3001'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      reconnection: true,
      reconnectionDelay: 100,
    })

    socket.on('connect', () => {
      resolve(socket)
    })

    socket.on('connect_error', (error) => {
      reject(new Error(`WebSocket connection failed: ${error}`))
    })

    // Timeout after 5 seconds
    setTimeout(() => {
      reject(new Error('WebSocket connection timeout'))
    }, 5000)
  })
}

/**
 * Wait for a specific WebSocket event
 *
 * @param socket Socket client
 * @param eventName Event name to listen for
 * @param timeout Timeout in ms (default: 5000)
 * @returns Event data
 */
export async function waitForWebSocketEvent(
  socket: Socket,
  eventName: string,
  timeout = 5000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Event '${eventName}' not received within ${timeout}ms`))
    }, timeout)

    socket.once(eventName, (data) => {
      clearTimeout(timer)
      resolve(data)
    })
  })
}

/**
 * Disconnect a WebSocket client
 *
 * @param socket Socket client
 */
export function disconnectWebSocket(socket: Socket): void {
  if (socket.connected) {
    socket.disconnect()
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Cleanup & Utilities
// ─────────────────────────────────────────────────────────────────────────

/**
 * Setup complete test environment (user, channel, message)
 *
 * @returns Object with user, channel, message, and token
 */
export async function setupTestEnvironment() {
  const user = await createTestUser()
  const channel = await getDefaultChannel(user.server_id, user.access_token)
  const message = await createTestMessage(channel.id, 'Test message', user.access_token)

  return {
    user,
    channel,
    message,
    token: user.access_token,
  }
}

/**
 * Cleanup test data (optional for now, as tests use isolated DB)
 *
 * TODO: Implement user deletion if needed
 */
export async function cleanupTestEnvironment(_data: any) {
  // Placeholder for cleanup logic
  // In production, may want to delete test users, channels, messages
}

/**
 * Generate random string for test data
 *
 * @param length Length of string (default: 10)
 * @returns Random string
 */
export function randomString(length = 10): string {
  return Math.random().toString(36).substring(2, length + 2)
}

/**
 * Generate random email
 *
 * @returns Random test email
 */
export function randomEmail(): string {
  return `test-${randomString(8)}@test.local`
}

/**
 * Sleep for specified milliseconds
 *
 * @param ms Milliseconds
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
