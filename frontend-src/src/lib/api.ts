/**
 * @file api.ts — API 客户端 + 全局类型定义
 * @description 前端与后端通信的核心模块，提供：
 *   1. tokenStore — JWT token 的 localStorage 存取
 *   2. request() — 带自动 token 刷新和 401 重定向的 fetch 封装
 *   3. 各业务 API 模块（auth / channels / messages / agents / tasks / files / obsidian / cron）
 *   4. 所有共享的 TypeScript 接口定义（User, Channel, Message, Agent, Task 等）
 *
 * 设计要点：
 *   - 所有 API 请求自动附加 Authorization header
 *   - 401 响应触发 refresh token 刷新，刷新失败则跳转登录页
 *   - 并发 401 请求共享同一个 refresh promise，避免重复刷新
 */

/** API 基础路径，可通过环境变量 VITE_API_BASE 覆盖 */
const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001/api'

// ─── Token store (localStorage) ───────────────────────────────────────────────

/**
 * JWT Token 存储器
 * 使用 localStorage 持久化 access token（15分钟）和 refresh token（30天）
 * key 前缀 'rsl_' = Red Shrimp Lab
 */
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

/**
 * 共享的 refresh promise，确保并发 401 请求只触发一次 token 刷新
 * 刷新完成后重置为 null
 */
let refreshPromise: Promise<boolean> | null = null

/**
 * 核心请求函数 — 封装 fetch，自动处理 JWT 和错误
 * @param path - API 路径（不含 base，如 '/channels'）
 * @param init - 原生 RequestInit 配置
 * @param retry - 是否在 401 时尝试刷新 token（防止无限递归，重试时置 false）
 * @returns 解析后的 JSON 响应体
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  retry = true
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  }
  const token = tokenStore.getAccess()
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })

  // 401 自动刷新：多个并发请求共享同一个 refreshPromise
  if (res.status === 401 && retry) {
    if (!refreshPromise) {
      refreshPromise = tryRefresh().finally(() => { refreshPromise = null })
    }
    const ok = await refreshPromise
    if (ok) return request<T>(path, init, false)  // 刷新成功，用新 token 重试一次
    tokenStore.clear()
    window.location.href = '/login'  // 刷新失败，跳转登录页
    throw new Error('Unauthorized')
  }

  // 非 2xx 响应抛出带 status 和 body 的错误
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status, body })
  }

  return res.json() as Promise<T>
}

/**
 * 尝试用 refresh token 换取新的 access token
 * @returns 是否刷新成功
 */
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

// ─── HTTP 方法快捷函数 ───────────────────────────────────────────────────────

const get  = <T>(path: string) => request<T>(path)
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined })
const del  = <T>(path: string) => request<T>(path, { method: 'DELETE' })

// ─── 认证 API ─────────────────────────────────────────────────────────────────

/** 认证相关接口：登录、注册、获取当前用户、登出 */
export const authApi = {
  /** 用户名密码登录，返回 JWT token 对和用户信息 */
  login:    (username: string, password: string) =>
    post<{ accessToken: string; refreshToken: string; user: User }>('/auth/login', { username, password }),
  /** 注册新用户，displayName 可选 */
  register: (username: string, password: string, displayName?: string) =>
    post<{ accessToken: string; refreshToken: string; user: User }>('/auth/register', { username, password, displayName }),
  /** 获取当前登录用户信息（用于 token 恢复时校验） */
  me:       () => get<{ user: User }>('/auth/me'),
  /** 登出，使服务端的 refresh token 失效 */
  logout:   () => post('/auth/logout', { refreshToken: tokenStore.getRefresh() }),
}

// ─── 频道 API ─────────────────────────────────────────────────────────────────

/** 频道管理接口：列表、创建、未读计数、标记已读、私信 */
export const channelsApi = {
  /** 获取当前用户可见的所有频道（包括 text 和 dm 类型） */
  list:      () => get<{ channels: Channel[] }>('/channels'),
  /** 创建新频道 */
  create:    (name: string, serverId: string, type?: string) =>
    post<{ channel: Channel }>('/channels', { name, serverId, type }),
  /** 获取各频道未读消息计数 */
  unread:    () => get<{ unread: UnreadCount[] }>('/channels/unread'),
  /** 标记频道已读到指定 seq（序列号） */
  markRead:  (channelId: string, seq: number) =>
    post('/channels/mark-read', { channelId, seq }),
  /** 打开/创建与指定用户的私信频道 */
  openDM:    (userId: string) => post<{ channel: Channel }>('/channels/dm', { userId }),
  /** 获取所有私信频道列表 */
  listDMs:   () => get<{ channels: Channel[] }>('/channels/dms'),
}

// ─── 消息 API ─────────────────────────────────────────────────────────────────

/** 消息接口：获取历史、发送消息 */
export const messagesApi = {
  /** 获取频道消息历史，支持分页（before=seq 向前翻页） */
  history: (channelId: string, before?: number, limit = 50) =>
    get<{ messages: Message[] }>(`/messages?channelId=${channelId}&limit=${limit}${before ? `&before=${before}` : ''}`),
  /** 发送消息到指定频道，可附带文件 ID 列表 */
  send: (channelId: string, content: string, fileIds?: string[]) =>
    post<{ message: Message }>('/messages', { channelId, content, fileIds }),
}

// ─── Agent API ────────────────────────────────────────────────────────────────

/** AI Agent 管理接口：CRUD、启停、日志、模型注册表 */
export const agentsApi = {
  /** 获取所有 agent 列表 */
  list:   () => get<{ agents: Agent[] }>('/agents'),
  /** 获取单个 agent 详情 */
  get:    (id: string) => get<{ agent: Agent }>(`/agents/${id}`),
  /** 创建新 agent（指定名称、模型、system prompt 等） */
  create: (data: { name: string; modelId: string; systemPrompt?: string; workspacePath?: string; runtime?: string }) =>
    post<{ agent: Agent }>('/agents', data),
  /** 启动 agent 进程（可选绑定到某频道） */
  start:  (id: string, channelId?: string) =>
    post<{ ok: boolean }>(`/agents/${id}/start`, { channelId }),
  /** 停止 agent 进程 */
  stop:   (id: string) =>
    post<{ ok: boolean }>(`/agents/${id}/stop`),
  /** 获取 agent 运行日志，支持分页 */
  logs:   (id: string, limit = 100, before?: string) =>
    get<{ logs: AgentLog[] }>(`/agents/${id}/logs?limit=${limit}${before ? `&before=${before}` : ''}`),
  /** 获取可用的 LLM 模型注册表（按提供商分组） */
  models: () => get<ModelRegistry>('/models'),
}

// ─── 任务 API ─────────────────────────────────────────────────────────────────

/**
 * 任务管理接口
 * 任务生命周期: open → claimed → pending_review → completed
 * 每个频道内有独立的序列号（#t1, #t2...）
 */
export const tasksApi = {
  /** 获取任务列表，可按频道过滤 */
  list:    (channelId?: string) =>
    get<{ tasks: Task[] }>(`/tasks${channelId ? `?channelId=${channelId}` : ''}`),
  /** 获取单个任务详情 */
  get:     (id: string) => get<{ task: Task }>(`/tasks/${id}`),
  /** 创建新任务（标题 + 频道 + 可选描述） */
  create:  (data: { title: string; channelId: string; description?: string }) =>
    post<{ task: Task }>('/tasks', data),
  /** Agent 认领任务 */
  claim:   (id: string) => post<{ task: Task }>(`/tasks/${id}/claim`),
  /** 更新任务属性 */
  update:  (id: string, data: Partial<Task>) => patch<{ task: Task }>(`/tasks/${id}`, data),
  /** 标记任务完成 */
  complete:(id: string) => post<{ task: Task }>(`/tasks/${id}/complete`),
  // ── 任务关联文档 ──
  /** 为任务关联 Obsidian 文档 */
  addDoc:     (taskId: string, docPath: string) =>
    post<{ doc: TaskDoc }>(`/tasks/${taskId}/docs`, { docPath }),
  /** 移除任务关联文档 */
  removeDoc:  (taskId: string, docId: string) =>
    del(`/tasks/${taskId}/docs/${docId}`),
  /** 标记关联文档为已读 */
  markDocRead:(taskId: string, docId: string) =>
    post(`/tasks/${taskId}/docs/${docId}/read`),
  // ── 任务技能标签 ──
  /** 为任务添加技能标签 */
  addSkill:   (taskId: string, skillId: string) =>
    post(`/tasks/${taskId}/skills`, { skillId }),
  /** 移除任务的技能标签 */
  removeSkill:(taskId: string, skillId: string) =>
    del(`/tasks/${taskId}/skills/${skillId}`),
}

// ─── 文件上传 API ─────────────────────────────────────────────────────────────

/**
 * 文件上传接口
 * 注意：文件上传使用 FormData，不经过 request() 封装（需要不同的 Content-Type）
 */
export const filesApi = {
  /** 上传单个文件，返回文件元信息（ID、URL 等） */
  upload: async (file: File): Promise<{ file: UploadedFile }> => {
    const formData = new FormData()
    formData.append('file', file)
    const token = tokenStore.getAccess()
    const res = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    })
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
    return res.json()
  },
}

// ─── Obsidian Vault API ──────────────────────────────────────────────────────

/** Obsidian vault 接口：浏览目录树、读取文件内容、触发 git 同步 */
export const obsidianApi = {
  /** 获取目录树（path 为空时返回根目录） */
  tree: (path = '') => get<{ path: string; items: ObsidianEntry[] }>(`/daemon/obsidian/tree?path=${encodeURIComponent(path)}`),
  /** 读取指定路径的 markdown 文件内容 */
  file: (path: string) => get<{ path: string; content: string }>(`/daemon/obsidian/file?path=${encodeURIComponent(path)}`),
  /** 触发 vault 的 git 同步操作 */
  sync: () => post('/daemon/obsidian/sync'),
}

// ─── 定时任务 API ─────────────────────────────────────────────────────────────

/** Cron 定时任务接口：管理 agent 的定时执行计划 */
export const cronApi = {
  /** 获取所有定时任务 */
  list:   () => get<{ jobs: CronJob[] }>('/daemon/cron'),
  /** 创建定时任务（cron 表达式 + prompt + 可选频道和模型覆盖） */
  create: (data: { agentId: string; cronExpr: string; prompt: string; channelId?: string; modelOverride?: string }) =>
    post<{ job: CronJob }>('/daemon/cron', data),
  /** 更新定时任务配置 */
  update: (id: string, data: { enabled?: boolean; cronExpr?: string; prompt?: string }) =>
    patch<{ job: CronJob }>(`/daemon/cron/${id}`, data),
  /** 删除定时任务 */
  delete: (id: string) => del(`/daemon/cron/${id}`),
}

// ─── 数据类型定义 ─────────────────────────────────────────────────────────────
// 以下接口与后端 PostgreSQL 表结构一一对应，字段命名遵循 snake_case

/** 用户信息 */
export interface User {
  id: string                    // UUID
  username: string              // 登录用户名
  display_name: string          // 显示名称
  avatar_url: string | null     // 头像 URL
  created_at: string            // ISO 时间戳
}

/** 频道（支持 text 普通频道和 dm 私信） */
export interface Channel {
  id: string
  name: string
  type: 'text' | 'dm'          // text=普通频道, dm=私信
  server_id: string | null      // 所属服务器 ID
  created_at: string
}

/** 频道未读消息计数 */
export interface UnreadCount {
  channel_id: string
  count: number
}

/** 消息（人类和 agent 共用同一结构，通过 sender_*_id 区分发送者类型） */
export interface Message {
  id: string
  channel_id: string
  sender_user_id: string | null   // 人类发送者 ID（与 sender_agent_id 互斥）
  sender_agent_id: string | null  // Agent 发送者 ID
  content: string
  seq: number                     // 频道内消息序列号（用于未读标记和分页）
  created_at: string
  sender?: { display_name: string; username: string; avatar_url: string | null }  // 后端 JOIN 的发送者信息
}

/** AI Agent 实体 */
export interface Agent {
  id: string
  name: string
  status: 'idle' | 'running' | 'offline' | 'error'  // 进程状态
  model_id: string              // 使用的 LLM 模型 ID
  runtime: string               // 运行时类型（如 claude / kimi / codex）
  workspace_path: string | null // Agent 工作目录路径
  system_prompt: string | null  // 系统提示词
  tokens_used_today: number     // 今日 token 消耗量
  last_heartbeat_at: string | null  // 最后心跳时间（daemon 定期上报）
  created_at: string
}

/** Agent 运行日志条目 */
export interface AgentLog {
  id: string
  agent_id: string
  run_id: string | null         // 关联的运行 ID（一次启动到停止为一个 run）
  level: string                 // 日志级别：ACTION / FILE / SPAWN / WARN / ERROR / INFO
  content: string
  created_at: string
}

/**
 * 任务实体
 * 生命周期: open → claimed → completed
 * seq 为频道内序列号（#t1, #t2...）
 */
export interface Task {
  id: string
  title: string
  description: string | null
  status: 'open' | 'claimed' | 'completed'
  channel_id: string
  claimed_by_agent_id: string | null  // 认领该任务的 agent ID
  seq: number                         // 频道内任务序列号
  created_at: string
  docs?: TaskDoc[]                    // 关联的文档列表（可选展开）
  skills?: Skill[]                    // 关联的技能标签（可选展开）
}

/** 任务关联文档（Obsidian vault 中的 markdown 文件） */
export interface TaskDoc {
  id: string
  task_id: string
  doc_path: string              // Obsidian vault 中的相对路径
  status: 'writing' | 'unread' | 'read'  // writing=agent正在写, unread=待阅读, read=已读
  created_at: string
}

/** 技能标签 */
export interface Skill {
  id: string
  name: string
  description: string | null
}

/** 上传文件的元信息 */
export interface UploadedFile {
  id: string
  filename: string
  mime_type: string
  size: number
  url: string                   // 文件访问 URL（/uploads/ 前缀）
}

/** Obsidian vault 目录条目 */
export interface ObsidianEntry {
  name: string
  type: 'file' | 'directory'
  path: string                  // vault 内相对路径
}

/** Cron 定时任务 */
export interface CronJob {
  id: string
  agent_id: string
  agent_name: string            // 冗余字段，方便前端显示
  cron_expr: string             // cron 表达式（如 '0 */6 * * *'）
  prompt: string                // 每次执行时发送给 agent 的 prompt
  channel_id: string | null     // 可选绑定频道
  model_override: string | null // 可选模型覆盖
  enabled: boolean
  created_at: string
}

/** LLM 模型注册表（按提供商分组） */
export interface ModelRegistry {
  anthropic: ModelInfo[]        // Anthropic Claude 系列
  moonshot:  ModelInfo[]        // 月之暗面 Kimi 系列
  openai:    ModelInfo[]        // OpenAI GPT 系列
}

/** 单个模型信息 */
export interface ModelInfo {
  id: string                    // 模型标识符（如 'claude-3-opus'）
  label: string                 // 显示名称
  tier: 'fast' | 'standard' | 'premium'  // 性能档次
}
