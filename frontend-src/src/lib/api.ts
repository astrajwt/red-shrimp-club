// Red Shrimp Lab — API Client
// Typed fetch wrapper with JWT auth, auto-refresh, and 401 redirect

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

import {
  describeServiceError,
  markServiceReachable,
  markServiceUnreachable,
} from './service-status'

// ─── Token store (localStorage) ───────────────────────────────────────────────

export const tokenStore = {
  getAccess:  () => localStorage.getItem('rsl_access'),
  getRefresh: () => localStorage.getItem('rsl_refresh'),
  set(access: string, refresh: string) {
    localStorage.setItem('rsl_access', access)
    localStorage.setItem('rsl_refresh', refresh)
  },
  clear() {
    localStorage.removeItem('rsl_access')
    localStorage.removeItem('rsl_refresh')
  },
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

let refreshPromise: Promise<boolean> | null = null

async function request<T>(
  path: string,
  init: RequestInit = {},
  retry = true
): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers as Record<string, string>),
  }
  const token = tokenStore.getAccess()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers })
    markServiceReachable()
  } catch (err) {
    markServiceUnreachable(describeServiceError(err))
    throw err
  }

  // Auto-refresh on 401
  if (res.status === 401 && retry) {
    if (!refreshPromise) {
      refreshPromise = tryRefresh().finally(() => { refreshPromise = null })
    }
    const ok = await refreshPromise
    if (ok) return request<T>(path, init, false)
    tokenStore.clear()
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status >= 500) {
      markServiceUnreachable(body.error ?? `Backend error (${res.status})`)
    }
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body })
  }

  return res.json() as Promise<T>
}

async function tryRefresh(): Promise<boolean> {
  const refresh = tokenStore.getRefresh()
  if (!refresh) return false
  try {
    const data = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    }).then(r => r.json())
    if (data.accessToken) {
      tokenStore.set(data.accessToken, data.refreshToken ?? refresh)
      return true
    }
  } catch { /* ignore */ }
  return false
}

// ─── HTTP method shorthands ───────────────────────────────────────────────────

const get  = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined })
const del  = <T>(path: string) => request<T>(path, { method: 'DELETE' })

// ─── Auth ──────────────────────────────────────────────────────────────────────

export const authApi = {
  login:    (email: string) =>
    post<{ accessToken: string; refreshToken: string; user: User }>('/auth/login', { email }),
  register: (email: string, name?: string) =>
    post<{ accessToken: string; refreshToken: string; user: User }>('/auth/register', { email, name }),
  me:       () => get<User>('/auth/me'),
  logout:   () => post('/auth/logout', { refreshToken: tokenStore.getRefresh() }),
}

// ─── Channels ─────────────────────────────────────────────────────────────────

export const channelsApi = {
  list:      () => get<Channel[]>('/channels'),
  create:    (name: string, serverId: string, description?: string) =>
    post<Channel>('/channels', { name, serverId, description }),
  unread:    () => get<Record<string, number>>('/channels/unread'),
  markRead:  (channelId: string, seq: number) =>
    post(`/channels/${channelId}/read`, { seq }),
  openDM:    (agentId?: string, userId?: string) => post<Channel>('/channels/dm', { agentId, userId }),
  listDMs:   () => get<Channel[]>('/channels/dm'),
  join:      (channelId: string) => post(`/channels/${channelId}/join`),
  invite:    (channelId: string, agentId?: string, userId?: string) =>
    post(`/channels/${channelId}/invite`, { agentId, userId }),
  members:   (channelId: string) => get<ChannelMember[]>(`/channels/${channelId}/members`),
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export const messagesApi = {
  history: (channelId: string, before?: number, limit = 50) =>
    get<Message[]>(`/messages/channel/${channelId}?limit=${limit}${before ? `&before=${before}` : ''}`),
  send: (channelId: string, content: string, fileIds?: string[]) =>
    post<Message>('/messages', { channelId, content, fileIds }),
}

// ─── Agents ───────────────────────────────────────────────────────────────────

export const agentsApi = {
  list:   () => get<Agent[]>('/agents'),
  get:    (id: string) => get<Agent>(`/agents/${id}`),
  create: (data: { name: string; modelId: string; description?: string; role?: string; workspacePath?: string; runtime?: string; machineId?: string; systemPrompt?: string }) =>
    post<{ agent: Agent }>('/agents', data),
  start:  (id: string, channelId?: string) =>
    post<{ ok: boolean }>(`/agents/${id}/start`, { channelId }),
  stop:   (id: string) =>
    post<{ ok: boolean }>(`/agents/${id}/stop`),
  logs:   (id: string, limit = 100, before?: string) =>
    get<{ logs: AgentLog[] }>(`/agents/${id}/logs?limit=${limit}${before ? `&before=${before}` : ''}`),
  delete:  (id: string) => del<{ ok: boolean }>(`/agents/${id}`),
  resetContext: (id: string) => post<{ ok: boolean; tokensUsed: number }>(`/agents/${id}/reset-context`),
  models: () => get<ModelRegistry>('/models'),
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export const tasksApi = {
  list:    (channelId?: string) =>
    get<{ tasks: Task[] }>(`/tasks${channelId ? `?channelId=${channelId}` : ''}`),
  get:     (id: string) => get<{ task: Task }>(`/tasks/${id}`),
  create:  (channelId: string, title: string) =>
    post<{ tasks: Task[] }>('/tasks', { channelId, tasks: [{ title }] }),
  intake:  (data: {
    channelId: string
    title: string
    summary?: string
    ownerAgentId?: string
    cleanLevel?: string
    subtasks?: Array<{ title: string; assigneeAgentId?: string }>
  }) => post<{ ok: boolean; bundle: {
    todoDir: string
    docPath: string
    docName: string
    parentTaskId: string
    parentTaskNumber: number
    subtaskNumbers: number[]
  } }>('/tasks/intake', data),
  claim:   (id: string) => post<{ task: Task }>(`/tasks/${id}/claim`),
  submitReview:(id: string) => post<{ task: Task }>(`/tasks/${id}/review`),
  update:  (id: string, data: Partial<Task>) => patch<{ task: Task }>(`/tasks/${id}`, data),
  complete:(id: string) => post<{ task: Task }>(`/tasks/${id}/complete`),
  reopen:  (id: string) => post<{ task: Task }>(`/tasks/${id}/reopen`),
  addMemoryNote: (taskId: string, data: { title: string; content: string }) =>
    post<{ ok: boolean; note: { todoDir: string; docPath: string; docName: string } }>(`/tasks/${taskId}/memory-note`, data),
  // Documents
  addDoc:     (taskId: string, docPath: string) =>
    post<{ doc: TaskDoc }>(`/tasks/${taskId}/docs`, { docPath }),
  removeDoc:  (taskId: string, docId: string) =>
    del(`/tasks/${taskId}/docs/${docId}`),
  markDocRead:(taskId: string, docId: string) =>
    post(`/tasks/${taskId}/docs/${docId}/read`),
  // Skills
  addSkill:   (taskId: string, skillId: string) =>
    post(`/tasks/${taskId}/skills`, { skillId }),
  removeSkill:(taskId: string, skillId: string) =>
    del(`/tasks/${taskId}/skills/${skillId}`),
}

// ─── Files ────────────────────────────────────────────────────────────────────

export const filesApi = {
  upload: async (file: File): Promise<{ file: UploadedFile }> => {
    const formData = new FormData()
    formData.append('file', file)
    const token = tokenStore.getAccess()
    let res: Response
    try {
      res = await fetch(`${API_BASE}/files/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      markServiceReachable()
    } catch (err) {
      markServiceUnreachable(describeServiceError(err))
      throw err
    }
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    const json = await res.json()
    // Backend returns flat object; wrap for consistent API
    return { file: json }
  },
}

// ─── Machines ────────────────────────────────────────────────────────────────

export const machinesApi = {
  list:      () => get<Machine[]>('/machines'),
  create:    () => post<Machine & { api_key: string; connect_command: string }>('/machines', {}),
  rename:    (id: string, name: string) => patch<Machine>('/machines/' + id, { name }),
  delete:    (id: string) => del('/machines/' + id),
  reconnect: (id: string) => post<{ api_key: string; connect_command: string }>('/machines/' + id + '/reconnect'),
  agents:    (id: string) => get<Agent[]>('/machines/' + id + '/agents'),
}

// ─── Obsidian ─────────────────────────────────────────────────────────────────

export const obsidianApi = {
  tree: (path = '') => get<{ path: string; items: ObsidianEntry[] }>(`/daemon/obsidian/tree?path=${encodeURIComponent(path)}`),
  file: (path: string) => get<{ path: string; content: string }>(`/daemon/obsidian/file?path=${encodeURIComponent(path)}`),
  sync: () => post('/daemon/obsidian/sync'),
}

// ─── Ask / AI Q&A ─────────────────────────────────────────────────────────────

export const askApi = {
  ask: (question: string, filePath?: string, model?: string) =>
    post<{ answer: string; model: string }>('/ask', { question, filePath, model }),

  // SSE streaming version — calls onChunk for each text delta, returns full text
  askStream: async (
    question: string,
    onChunk: (text: string) => void,
    filePath?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    const token = tokenStore.getAccess()
    let res: Response
    try {
      res = await fetch(`${API_BASE}/ask/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ question, filePath, model }),
        signal,
      })
      markServiceReachable()
    } catch (err) {
      markServiceUnreachable(describeServiceError(err))
      throw err
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') return fullText
        try {
          const json = JSON.parse(data)
          if (json.error) throw new Error(json.error)
          if (json.text) {
            fullText += json.text
            onChunk(fullText)
          }
        } catch (e: any) {
          if (e.message && e.message !== data) throw e
        }
      }
    }
    return fullText
  },
}

// ─── Setup / Onboarding ───────────────────────────────────────────────────────

export const setupApi = {
  getKeys: () => get<{ anthropic: boolean; moonshot: boolean; openai: boolean; obsidian_root: string }>('/setup/keys'),
  saveKeys: (data: { anthropicKey?: string; moonshotKey?: string; openaiKey?: string; obsidianRoot?: string }) =>
    post<{ ok: boolean }>('/setup/keys', data),
}

// ─── Cron Jobs ────────────────────────────────────────────────────────────────

export const cronApi = {
  list:   () => get<{ jobs: CronJob[] }>('/daemon/cron'),
  create: (data: { agentId: string; cronExpr: string; prompt: string; channelId?: string; modelOverride?: string }) =>
    post<{ job: CronJob }>('/daemon/cron', data),
  update: (id: string, data: { enabled?: boolean; cronExpr?: string; prompt?: string }) =>
    patch<{ job: CronJob }>(`/daemon/cron/${id}`, data),
  delete: (id: string) => del(`/daemon/cron/${id}`),
}

// ─── Data types ───────────────────────────────────────────────────────────────

export interface User {
  id: string
  name: string
  email: string
  email_verified?: boolean
  role?: string
  created_at: string
}

export interface Channel {
  id: string
  name: string
  type: 'channel' | 'dm'
  server_id: string | null
  description?: string | null
  display_name?: string | null
  joined?: boolean
  created_at: string
}

export interface ChannelMember {
  channel_id: string
  member_id: string
  name: string
  type: 'human' | 'agent'
  joined_at: string
}

export interface UnreadCount {
  channel_id: string
  count: number
}

export interface MessageAttachment {
  file_id: string
  filename: string
  mime_type: string
  size: number
  url: string
}

export interface MessageMention {
  id: string
  name: string
  type: 'agent' | 'human'
}

export interface Message {
  id: string
  channel_id: string
  sender_id: string
  sender_type: 'human' | 'agent'
  sender_name: string
  content: string
  seq: number
  attachments?: MessageAttachment[]
  mentions?: MessageMention[]
  created_at: string
}

export interface Agent {
  id: string
  name: string
  status: 'idle' | 'running' | 'online' | 'offline' | 'error' | 'starting'
  model_id: string
  model_provider: string | null
  runtime: string
  workspace_path: string | null
  system_prompt: string | null
  tokens_used_today: number
  last_heartbeat_at: string | null
  created_at: string
  role: string | null
  parent_agent_id: string | null
  description: string | null
}

export interface Machine {
  id: string
  name: string
  status: 'online' | 'offline'
  hostname: string | null
  os: string | null
  daemon_version: string | null
  agent_count: number
  last_seen_at: string | null
  created_at: string
}

export interface AgentLog {
  id: string
  agent_id: string
  run_id: string | null
  level: string
  content: string
  created_at: string
}

export interface Task {
  id: string
  title: string
  description: string | null
  status: 'open' | 'claimed' | 'reviewing' | 'completed'
  channel_id: string
  claimed_by_agent_id: string | null
  seq: number
  created_at: string
  docs?: TaskDoc[]
  skills?: Skill[]
}

export interface TaskDoc {
  id: string
  task_id: string
  doc_path: string
  status: 'writing' | 'unread' | 'read'
  created_at: string
}

export interface Skill {
  id: string
  name: string
  description: string | null
}

export interface UploadedFile {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  url: string
}

export interface ObsidianEntry {
  name: string
  type: 'file' | 'directory'
  path: string
}

export interface CronJob {
  id: string
  agent_id: string
  agent_name: string
  cron_expr: string
  prompt: string
  channel_id: string | null
  model_override: string | null
  enabled: boolean
  created_at: string
}

export interface ModelRegistry {
  anthropic: ModelInfo[]
  moonshot:  ModelInfo[]
  openai:    ModelInfo[]
}

export interface ModelInfo {
  id: string
  label: string
  tier: 'fast' | 'standard' | 'premium'
}
