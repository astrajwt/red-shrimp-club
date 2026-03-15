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
  login:    (identity: string) =>
    post<{ accessToken: string; refreshToken: string; user: User }>('/auth/login', { identity }),
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
  feedback: (messageId: string, itemIndex: number, verdict: MessageFeedbackVerdict) =>
    post<{ ok: boolean; feedback: Record<string, MessageFeedbackVerdict> }>(
      `/messages/${messageId}/feedback`,
      { itemIndex, verdict }
    ),
}

export const searchApi = {
  query: (q: string, limit = 12) =>
    get<SearchResults>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`),
}

// ─── Agents ───────────────────────────────────────────────────────────────────

export const agentsApi = {
  list:   () => get<Agent[]>('/agents'),
  get:    (id: string) => get<Agent>(`/agents/${id}`),
  memory: (id: string) => get<AgentMemory>(`/agents/${id}/memory`),
  authoredDocs: (id: string) => get<{ docs: AgentAuthoredDoc[] }>(`/agents/${id}/authored-docs`),
  todos:  (id: string) => get<{ todos: AgentTodo[] }>(`/agents/${id}/todos`),
  updateNote: (id: string, note: string) => patch<{ agent: { id: string; note: string | null } }>(`/agents/${id}/note`, { note }),
  updateModel: (id: string, modelId: string) => patch<{ agent: { id: string; model_id: string } }>(`/agents/${id}/model`, { modelId }),
  create: (data: { name: string; modelId: string; description?: string; role?: string; workspacePath?: string; runtime?: string; machineId?: string; systemPrompt?: string; parentAgentId?: string; reasoningEffort?: string }) =>
    post<{ agent: Agent }>('/agents', data),
  reconnectAll: () =>
    post<{ ok: boolean; count: number; results: Array<{ agentId: string; name: string; ok: boolean; message?: string; error?: string }> }>('/agents/reconnect-all'),
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

// ─── Shared Skills ────────────────────────────────────────────────────────────

export const skillsApi = {
  list: () => get<SharedSkillRegistrySnapshot>('/skills'),
  importRepo: (data: {
    name?: string
    repoUrl?: string
    branch?: string
    skillPath?: string
    valuePath?: string
    localPath?: string
  }) => post<{
    ok: boolean
    source: SharedSkillSource
    skills: SharedSkillRegistryItem[]
  }>('/skills/import-repo', data),
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export const tasksApi = {
  reviewSummary: () =>
    get<{ reviewingCount: number }>('/tasks/review-summary'),
  list:    (channelId?: string) =>
    get<{ tasks: Task[] }>(`/tasks${channelId ? `?channelId=${channelId}` : ''}`),
  get:     (id: string) => get<{ task: Task }>(`/tasks/${id}`),
  create:  (channelId: string, title: string, assigneeAgentId: string) =>
    post<{ tasks: Task[] }>('/tasks', { channelId, tasks: [{ title, assigneeAgentId }] }),
  intake:  (data: {
    channelId: string
    title: string
    summary?: string
    ownerAgentId?: string
    cleanLevel?: string
    dueDate?: string
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
  unclaim: (id: string) => post<{ task: Task }>(`/tasks/${id}/unclaim`),
  start:   (id: string) => post<{ task: Task }>(`/tasks/${id}/start`),
  submitReview:(id: string) => post<{ task: Task }>(`/tasks/${id}/review`),
  update:  (id: string, data: Partial<Task>) => patch<{ task: Task }>(`/tasks/${id}`, data),
  complete:(id: string) => post<{ task: Task }>(`/tasks/${id}/complete`),
  reject:  (id: string, message: string) => post<{ task: Task }>(`/tasks/${id}/reject`, { message }),
  remove:  (id: string) => del<{ ok: boolean; deletedTask: Task }>(`/tasks/${id}`),
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

  // Subtasks
  approve:    (id: string) =>
    post<{ task: Task }>(`/tasks/${id}/approve`, {}),
  setEstimate:(id: string, estimatedMinutes: number) =>
    patch<{ task: Task }>(`/tasks/${id}/estimate`, { estimatedMinutes }),
  // Feedback
  addFeedback: (id: string, data: { verdict: 'accept' | 'reject' | 'revise'; reasonCategory?: string; reasonText?: string }) =>
    post<{ feedback: TaskFeedback }>(`/tasks/${id}/feedback`, data),
  getFeedback: (id: string) =>
    get<{ feedbacks: TaskFeedback[] }>(`/tasks/${id}/feedback`),
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
  create:    () => post<Machine & { api_key: string; server_url: string; connect_command: string; env_config: string }>('/machines', {}),
  rename:    (id: string, name: string) => patch<Machine>('/machines/' + id, { name }),
  delete:    (id: string) => del('/machines/' + id),
  reconnect: (id: string) => post<{ api_key: string; server_url: string; connect_command: string; env_config: string }>('/machines/' + id + '/reconnect'),
  agents:    (id: string) => get<Agent[]>('/machines/' + id + '/agents'),
}

// ─── Obsidian ─────────────────────────────────────────────────────────────────

export const obsidianApi = {
  tree: (path = '') => get<{ path: string; items: ObsidianEntry[] }>(`/daemon/obsidian/tree?path=${encodeURIComponent(path)}`),
  file: (path: string) => get<{ path: string; content: string }>(`/daemon/obsidian/file?path=${encodeURIComponent(path)}`),
  backlinks: (path: string) => get<{ target: string; backlinks: Backlink[] }>(`/daemon/obsidian/backlinks?path=${encodeURIComponent(path)}`),
  assetUrl: (path: string, relativeTo?: string) =>
    `${API_BASE}/daemon/obsidian/asset?path=${encodeURIComponent(path)}${relativeTo ? `&relativeTo=${encodeURIComponent(relativeTo)}` : ''}`,
  sync: () => post('/daemon/obsidian/sync'),
}

// ─── Memory Sources (git imports) ────────────────────────────────────────────

export const memoryApi = {
  listSources: () => get<{ sources: MemorySource[] }>('/daemon/memory/sources'),
  addSource: (data: { name: string; gitUrl: string; branch?: string; authMethod?: 'none' | 'ssh' | 'pat' }) =>
    post<{ source: MemorySource }>('/daemon/memory/sources', data),
  syncSource: (id: string) => post<{ ok: boolean }>(`/daemon/memory/sources/${id}/sync`),
  deleteSource: (id: string) => del(`/daemon/memory/sources/${id}`),
}

// ─── Ask / AI Q&A ─────────────────────────────────────────────────────────────

export const askApi = {
  ask: (question: string, filePath?: string, model?: string, systemPrompt?: string) =>
    post<{ answer: string; model: string }>('/ask', { question, filePath, model, systemPrompt }),

  // SSE streaming version — calls onChunk for each text delta, returns full text
  askStream: async (
    question: string,
    onChunk: (text: string) => void,
    filePath?: string,
    model?: string,
    signal?: AbortSignal,
    systemPrompt?: string,
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
        body: JSON.stringify({ question, filePath, model, systemPrompt }),
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
  getKeys: () => get<{
    anthropic: boolean
    moonshot: boolean
    openai: boolean
    obsidian_root: string
    vault_git_url: string
    skill_path: string
    memory_path: string
    feishu_app_id: string
    feishu_app_secret: boolean
    feishu_verification_token: boolean
    feishu_webhook_base_url: string
  }>('/setup/keys'),
  saveKeys: (data: {
    anthropicKey?: string
    moonshotKey?: string
    openaiKey?: string
    obsidianRoot?: string
    vaultGitUrl?: string
    skillPath?: string
    memoryPath?: string
    feishuAppId?: string
    feishuAppSecret?: string
    feishuVerificationToken?: string
    feishuWebhookBaseUrl?: string
  }) =>
    post<{ ok: boolean }>('/setup/keys', data),
}

export const feishuApi = {
  relay: () => get<{
    config: {
      appId: string
      appSecretSet: boolean
      verificationTokenSet: boolean
    }
    relay: FeishuRelayBinding | null
    webhookPath: string
    webhookUrl: string | null
  }>('/feishu/relay'),
  saveRelay: (data: { agentId?: string; enabled?: boolean; resetBinding?: boolean }) =>
    post<{ ok: boolean; relay: FeishuRelayBinding }>('/feishu/relay', data),
  testRelay: () => post<{ ok: boolean }>('/feishu/relay/test'),
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

export const bulletinApi = {
  list:      (params?: { category?: string; limit?: number; before?: string }) =>
    get<{ bulletins: Bulletin[] }>(`/bulletins${toQuery(params)}`),
  create:    (data: { category: string; title: string; content?: string; priority?: string; linked_file?: string; linked_url?: string; linked_task_id?: string; metadata?: Record<string, unknown>; pinned?: boolean }) =>
    post<{ bulletin: Bulletin }>('/bulletins', data),
  update:    (id: string, data: Partial<Bulletin>) =>
    patch<{ bulletin: Bulletin }>(`/bulletins/${id}`, data),
  delete:    (id: string) => del<{ ok: boolean }>(`/bulletins/${id}`),
  dashboard: () => get<DashboardData>('/bulletins/dashboard'),
}

function toQuery(params?: Record<string, unknown>): string {
  if (!params) return ''
  const entries = Object.entries(params).filter(([, v]) => v != null)
  if (entries.length === 0) return ''
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
}

// ─── Data types ───────────────────────────────────────────────────────────────

export interface Bulletin {
  id: string
  server_id: string
  category: string
  title: string
  content?: string | null
  author_id: string
  author_type: string
  author_name: string
  priority: string
  linked_file?: string | null
  linked_url?: string | null
  linked_task_id?: string | null
  metadata: Record<string, unknown>
  pinned: boolean
  created_at: string
  updated_at: string
}

export interface DashboardData {
  leaders: DashboardAgent[]
  activeTasks: DashboardTask[]
  recentActivity: DashboardActivity[]
  bookmarks: Bulletin[]
  stickies: Bulletin[]
}

export interface DashboardAgent {
  id: string
  name: string
  role: string
  status: string
  last_heartbeat_at: string | null
  parent_agent_id: string | null
  description: string | null
}

export interface DashboardTask {
  id: string
  title: string
  status: string
  display_number: string | null
  assigned_agent_id: string | null
  agent_name: string | null
  created_at: string
  updated_at: string
}

export interface DashboardActivity {
  agent_id: string
  agent_name: string
  level: string
  content: string
  created_at: string
}

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

export interface FeishuRelayBinding {
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

export type MessageFeedbackVerdict = 'correct' | 'wrong' | 'selected'

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
  thinking?: string | null
  feedback?: Record<string, MessageFeedbackVerdict>
  created_at: string
}

export interface SearchMessageHit {
  id: string
  channel_id: string
  channel_name: string
  channel_type: 'channel' | 'dm'
  sender_name: string
  sender_type: 'human' | 'agent'
  seq: number
  created_at: string
  content: string
  snippet: string
}

export interface SearchDocHit {
  path: string
  title: string
  snippet: string
  updated_at: string | null
}

export interface SearchResults {
  query: string
  messages: SearchMessageHit[]
  docs: SearchDocHit[]
}

export interface Agent {
  id: string
  name: string
  status: 'idle' | 'running' | 'online' | 'offline' | 'error' | 'starting' | 'sleeping'
  model_id: string
  model_provider: string | null
  runtime: string
  reasoning_effort?: string | null
  machine_id?: string | null
  machine_name?: string | null
  machine_hostname?: string | null
  machine_status?: string | null
  current_project_id?: string | null
  current_project_name?: string | null
  current_project_slug?: string | null
  workspace_path: string | null
  system_prompt: string | null
  tokens_used_today: number
  last_heartbeat_at: string | null
  created_at: string
  role: string | null
  parent_agent_id: string | null
  description: string | null
  note?: string | null
}

export interface Machine {
  id: string
  name: string
  status: 'online' | 'offline'
  hostname: string | null
  os: string | null
  daemon_version: string | null
  agent_count: number
  runtimes?: string[]
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

export interface AgentMemory {
  path: string
  content: string
  updatedAt: string | null
  workspacePath?: string | null
  memory?: {
    path: string
    content: string
    updatedAt: string | null
  }
  knowledge?: {
    path: string
    content: string
    updatedAt: string | null
  }
  notesIndex?: {
    path: string
    content: string
    updatedAt: string | null
  }
}

export interface AgentTodoDoc {
  id: string
  doc_path: string
  doc_name: string
  status: 'writing' | 'unread' | 'read'
}

export interface AgentTodo {
  id: string
  channel_id: string
  channel_name: string
  title: string
  number: number
  status: 'open' | 'claimed' | 'in_progress' | 'reviewing' | 'completed'
  claimed_by_id: string | null
  claimed_by_name: string | null
  claimed_at: string | null
  completed_at: string | null
  created_at: string
  docs: AgentTodoDoc[]
}

export interface AgentAuthoredDoc {
  path: string
  title: string
  author: string[]
  date: string | null
  type: string | null
  tags: string[]
  youtube: string | null
  source: string | null
  updatedAt: string | null
}

export interface Task {
  id: string
  title: string
  status: 'open' | 'claimed' | 'in_progress' | 'reviewing' | 'completed'
  channel_id: string
  number: number
  claimed_by_id: string | null
  claimed_by_type: 'human' | 'agent' | null
  claimed_by_name: string | null
  claimed_at: string | null
  review_feedback?: string | null
  review_feedback_at?: string | null
  review_feedback_by_name?: string | null
  completed_at: string | null
  created_at: string
  estimated_minutes?: number | null
  started_at?: string | null
  parent_task_id?: string | null
  parent_task_number?: number | null
  source_doc_path?: string | null
  is_candidate?: boolean
  due_date?: string | null
  docs?: TaskDoc[]
  skills?: string[]
  subtasks?: Task[]
}

export interface TaskFeedback {
  id: string
  task_id: string
  reviewer_id: string
  reviewer_type: 'human' | 'agent'
  reviewer_name: string
  verdict: 'accept' | 'reject' | 'revise'
  reason_category?: string | null
  reason_text?: string | null
  created_at: string
}

export interface TaskDoc {
  id: string
  task_id: string
  doc_path: string
  doc_name?: string
  status: 'writing' | 'unread' | 'read'
  created_at: string
}

export interface Skill {
  id: string
  name: string
  description: string | null
}

export interface SharedSkillSource {
  name: string
  repoUrl: string
  branch: string
  skillPath: string | null
  repoPath: string
  skills: string[]
  skillEntries: Array<{ name: string; relativePath: string }>
  head: string | null
  lastSyncAt: string
}

export interface SharedSkillRegistryItem {
  name: string
  description: string | null
  sourceName: string
  repoUrl: string | null
  path: string
  runtimes: Array<'codex' | 'claude'>
}

export interface SharedSkillRegistrySnapshot {
  root: string
  sources: SharedSkillSource[]
  skills: SharedSkillRegistryItem[]
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

export interface Backlink {
  path: string
  name: string
  context: string
}

export interface MemorySource {
  id: string
  server_id: string
  name: string
  git_url: string
  branch: string
  local_path: string
  auth_method: 'none' | 'ssh' | 'pat'
  status: 'pending' | 'cloning' | 'synced' | 'error'
  last_synced: string | null
  last_error: string | null
  created_at: string
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
