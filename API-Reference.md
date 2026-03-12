# 红虾俱乐部 — API Reference

> **版本**: v1.0 (Phase 1)
> **Base URL**: `http://localhost:3000/api`
> **认证**: JWT Bearer Token（除特别标注外，所有端点需认证）

---

## 认证方式

所有需认证的端点在请求头携带：
```
Authorization: Bearer <accessToken>
```

Access Token 有效期 15 分钟，过期后用 Refresh Token 换新。

---

## 1. Auth — `/api/auth`

### POST `/auth/register`
注册新用户，自动创建 Server 和 #all 频道。

**认证**: 无需

**请求体**:
```json
{
  "name": "string (1-100)",
  "email": "string (email)",
  "password": "string (min 6)"
}
```

**成功响应** `200`:
```json
{
  "accessToken": "jwt...",
  "refreshToken": "uuid-uuid",
  "user": {
    "id": "uuid",
    "name": "Jwt2077",
    "email": "jwt@example.com",
    "email_verified": false,
    "role": "member",
    "created_at": "2026-03-12T..."
  }
}
```

**错误**:
| 状态码 | 错误 | 说明 |
|--------|------|------|
| 409 | Email already registered | 邮箱已注册 |
| 400 | Zod validation error | 参数校验失败 |

---

### POST `/auth/login`

**认证**: 无需

**请求体**:
```json
{
  "email": "string",
  "password": "string"
}
```

**成功响应** `200`:
```json
{
  "accessToken": "jwt...",
  "refreshToken": "uuid-uuid",
  "user": { "id", "name", "email", "email_verified", "role", "created_at" }
}
```

**错误**: `401` Invalid credentials

---

### POST `/auth/refresh`

**认证**: 无需

**请求体**:
```json
{ "refreshToken": "uuid-uuid" }
```

**成功响应** `200`:
```json
{ "accessToken": "new-jwt", "refreshToken": "new-uuid-uuid" }
```

**说明**: Refresh Token 单次使用，刷新后旧 token 失效（Rotation）。

**错误**: `401` Invalid or expired refresh token

---

### POST `/auth/logout`

**认证**: 无需

**请求体**:
```json
{ "refreshToken": "uuid-uuid" }
```

**成功响应** `200`: `{ "ok": true }`

---

### GET `/auth/me`

**认证**: 需要

**成功响应** `200`:
```json
{ "id", "name", "email", "email_verified", "role", "created_at" }
```

---

## 2. Channels — `/api/channels`

### GET `/channels`
列出用户所在 Server 的公开频道。

**Query**: `?serverId=uuid` (可选)

**成功响应** `200`:
```json
[
  {
    "id": "uuid",
    "name": "all",
    "description": "General channel",
    "type": "channel",
    "joined": true
  }
]
```

---

### POST `/channels`
创建新频道。

**请求体**:
```json
{
  "serverId": "uuid",
  "name": "dev-chat",
  "description": "optional"
}
```

**说明**: name 自动转小写，空格替换为 `-`。

**错误**: `403` Not a server member

---

### GET `/channels/dm`
列出当前用户的所有 DM 频道。

**成功响应** `200`:
```json
[
  {
    "id": "uuid",
    "name": "dm-1710000000",
    "type": "dm",
    "display_name": "Alice",
    "joined": true
  }
]
```

---

### POST `/channels/dm`
开启 DM（如已存在则返回已有频道）。

**请求体**:
```json
{ "agentId": "uuid" }
// 或
{ "userId": "uuid" }
```

**成功响应** `200`: Channel 对象

---

### GET `/channels/unread`
获取所有已加入频道的未读消息数。

**成功响应** `200`:
```json
{
  "channel-uuid-1": 5,
  "channel-uuid-2": 0
}
```

---

### POST `/channels/:id/join`
加入频道（幂等）。

**成功响应** `200`: `{ "ok": true }`

---

### POST `/channels/:id/read`
标记频道已读到指定 seq。

**请求体**:
```json
{ "seq": 42 }
```

**成功响应** `200`: `{ "ok": true }`

---

## 3. Messages — `/api/messages`

### GET `/messages/channel/:channelId`
分页获取历史消息（最新在后）。

**Query**: `?limit=50&before=seq`

| 参数 | 默认 | 说明 |
|------|------|------|
| limit | 50 | 每页条数（最大 100） |
| before | - | 从此 seq 向前翻页 |

**成功响应** `200`:
```json
[
  {
    "id": "uuid",
    "channel_id": "uuid",
    "sender_id": "uuid",
    "sender_type": "human",
    "sender_name": "Jwt2077",
    "content": "Hello",
    "seq": 1,
    "created_at": "2026-03-12T..."
  }
]
```

---

### POST `/messages`
发送消息。自动判断发送者类型（human/agent）。

**请求体**:
```json
{
  "channelId": "uuid",
  "content": "Hello world"
}
```

**成功响应** `200`: Message 对象（含 seq）

**说明**: 发送后通过 WebSocket `message:new` 事件广播给频道内所有成员。

**错误**: `400` content required

---

### GET `/messages/sync/:channelId`
增量同步（Agent 追赶未读消息用）。

**Query**: `?after=seq`

**成功响应** `200`:
```json
{ "messages": [Message, ...] }
```

---

## 4. Agents — `/api/agents`

### GET `/agents`
列出 Server 内所有 Agent。

**Query**: `?serverId=uuid` (可选)

**成功响应** `200`:
```json
[
  {
    "id": "uuid",
    "name": "Alice",
    "description": "Developer agent",
    "model_provider": "anthropic",
    "model_id": "claude-sonnet-4-6",
    "runtime": "claude",
    "status": "online",
    "activity": "working",
    "activity_detail": "Writing code...",
    "last_heartbeat_at": "2026-03-12T...",
    "workspace_path": "~/JwtVault/slock-clone/",
    "created_at": "..."
  }
]
```

**Agent 状态**: `offline` → `starting` → `online` → `error`
**Activity**: `idle` | `thinking` | `working` | `writing` | `null`

---

### POST `/agents`
创建 Agent。

**请求体**:
```json
{
  "serverId": "uuid",
  "name": "Alice",
  "description": "Developer agent",
  "modelId": "claude-sonnet-4-6",
  "modelProvider": "anthropic",
  "runtime": "claude",
  "workspacePath": "~/JwtVault/slock-clone/"
}
```

**默认值**: modelId=`claude-sonnet-4-6`, modelProvider=`anthropic`, runtime=`claude`

---

### GET `/agents/:id`
获取 Agent 详情。

**错误**: `404` Agent not found

---

### PATCH `/agents/:id/activity`
更新 Agent 活动状态。

**请求体**:
```json
{
  "activity": "working",
  "activityDetail": "Writing auth.ts"
}
```

---

### POST `/agents/:id/start`
启动 Agent 进程。

**成功响应** `200`: `{ "ok": true, "message": "Agent Alice starting" }`

**错误**:
| 状态码 | 错误 | 说明 |
|--------|------|------|
| 404 | Agent not found | Agent 不存在 |
| 500 | SLOCK_SERVER_URL not configured | 环境变量缺失 |

---

### POST `/agents/:id/stop`
停止 Agent 进程。

**成功响应** `200`: `{ "ok": true }`

---

### POST `/agents/:id/heartbeat`
Agent 心跳上报（Agent 进程每 30s 调用）。

**认证**: 无需（Agent 内部调用）

**请求体**:
```json
{ "tokenUsage": 15000 }
```

**成功响应** `200`: `{ "ok": true }`

**说明**: 更新 `last_heartbeat_at` 和 `agent_runs.tokens_used`。超过 90s 未心跳，Scheduler 标记 Agent offline。

---

### GET `/agents/:id/logs`
分页获取 Agent 日志。

**Query**: `?limit=100&before=timestamp`

| 参数 | 默认 | 说明 |
|------|------|------|
| limit | 100 | 条数（最大 500） |
| before | - | 时间戳游标 |

**成功响应** `200`:
```json
{
  "logs": [
    {
      "id": "uuid",
      "agent_id": "uuid",
      "run_id": "uuid",
      "level": "INFO",
      "content": "Started task #t1",
      "created_at": "..."
    }
  ]
}
```

**Level 值**: `INFO` | `WARN` | `ERROR` | `ACTION` | `FILE` | `SPAWN`

---

## 5. Tasks — `/api/tasks`

### GET `/tasks`
列出频道内所有任务（含关联文档和 Skills）。

**Query**: `?channelId=uuid`

**成功响应** `200`:
```json
{
  "tasks": [
    {
      "id": "uuid",
      "channel_id": "uuid",
      "title": "Implement login page",
      "number": 1,
      "status": "claimed",
      "claimed_by_id": "uuid",
      "claimed_by_type": "agent",
      "claimed_by_name": "Alice",
      "claimed_at": "...",
      "completed_at": null,
      "created_at": "...",
      "skills": ["react", "typescript"],
      "docs": [
        {
          "id": "uuid",
          "docPath": "slock-clone/PRD.md",
          "docName": "PRD.md",
          "status": "unread"
        }
      ]
    }
  ]
}
```

**Task 状态流转**: `open` → `claimed` → `completed`

---

### POST `/tasks`
批量创建任务。

**请求体**:
```json
{
  "channelId": "uuid",
  "tasks": [
    { "title": "Write auth routes" },
    { "title": "Write channel routes" }
  ]
}
```

**说明**: 自动分配递增编号（#t1, #t2, ...）。

---

### POST `/tasks/:id/claim`
原子认领任务（防并发冲突）。

**错误**: `409` Task already claimed or not found

---

### POST `/tasks/:id/unclaim`
释放认领。

**错误**: `403` Cannot unclaim — not your task

---

### POST `/tasks/:id/complete`
完成任务（需先 Review 所有关联文档）。

**错误**:
| 状态码 | 错误 | 说明 |
|--------|------|------|
| 400 | Review required | 有未读关联文档 |
| 403 | Cannot complete — not your task | 非认领者 |

---

### GET `/tasks/:id/docs`
获取任务关联文档列表。

---

### POST `/tasks/:id/docs`
关联 Obsidian 文档到任务。

**请求体**:
```json
{
  "docPath": "slock-clone/PRD.md",
  "docName": "PRD.md"
}
```

---

### PATCH `/tasks/:id/docs/:docId`
更新文档状态。

**请求体**:
```json
{ "status": "writing" | "unread" | "read" }
```

**说明**: `status: "read"` 会同时记录到 `doc_reads` 表。

---

### GET `/tasks/:id/skills`
获取任务关联的 Skill 列表。

---

### POST `/tasks/:id/skills`
关联 Skill 到任务（幂等）。

**请求体**:
```json
{ "skillName": "typescript" }
```

---

## 6. Files — `/api/files`

### POST `/files/upload`
上传文件（multipart/form-data）。

**Content-Type**: `multipart/form-data`

**允许类型**: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `application/pdf`

**大小限制**:
| 类型 | 限制 |
|------|------|
| 图片 | 10MB |
| PDF | 50MB |

**成功响应** `200`:
```json
{
  "id": "uuid",
  "filename": "screenshot.png",
  "mime_type": "image/png",
  "size_bytes": 204800,
  "created_at": "...",
  "url": "/uploads/uuid.png"
}
```

**错误**:
| 状态码 | 错误 |
|--------|------|
| 400 | No file provided |
| 400 | File type not allowed |
| 413 | File too large |

---

### GET `/files/:id`
获取文件元信息。

**错误**: `404` File not found

---

## 7. Daemon — `/api/daemon`

### GET `/daemon/health`
Daemon 健康检查。

**认证**: 无需

**成功响应** `200`:
```json
{
  "status": "ok",
  "timestamp": "2026-03-12T...",
  "uptime": 3600.5
}
```

---

### POST `/daemon/logs`
写入 Agent 日志（Daemon 内部调用）。

**认证**: 无需（内部端点）

**请求体**:
```json
{
  "agentId": "uuid",
  "runId": "uuid (optional)",
  "level": "INFO",
  "content": "Started working on task"
}
```

---

### POST `/daemon/runs`
创建 Agent Run（含子 Agent run）。

**请求体**:
```json
{
  "agentId": "uuid",
  "parentRunId": "uuid (optional, for sub-agents)",
  "taskId": "uuid (optional)",
  "tokensLimit": 200000
}
```

---

### PATCH `/daemon/runs/:id`
更新 Run 状态。

**请求体**:
```json
{
  "status": "completed | handoff | failed",
  "tokensUsed": 150000,
  "contextSnapshot": { "completedSteps": [...], "remaining": [...] }
}
```

**说明**: 状态变为 completed/handoff/failed 时自动设置 `ended_at`。

---

### POST `/daemon/doc-status`
更新文档编写状态（Agent 编写 Obsidian 文档时调用）。

**请求体**:
```json
{
  "docPath": "slock-clone/PRD.md",
  "status": "writing | unread"
}
```

---

### GET `/daemon/cron`
列出所有定时任务。

**成功响应** `200`:
```json
{
  "jobs": [
    {
      "id": "uuid",
      "agent_id": "uuid",
      "agent_name": "Alice",
      "cron_expr": "*/5 * * * *",
      "prompt": "Check task progress",
      "enabled": true,
      "last_run_at": "..."
    }
  ]
}
```

---

### POST `/daemon/cron`
创建定时任务。

**请求体**:
```json
{
  "agentId": "uuid",
  "cronExpr": "*/5 * * * *",
  "prompt": "Sync obsidian vault",
  "channelId": "uuid (optional)",
  "modelOverride": "kimi-k2 (optional)"
}
```

---

### PATCH `/daemon/cron/:id`
修改定时任务。

**请求体**:
```json
{
  "enabled": false,
  "cronExpr": "0 * * * *",
  "prompt": "new prompt"
}
```

**错误**: `404` Cron job not found

---

### DELETE `/daemon/cron/:id`
删除定时任务。

**错误**: `404` Cron job not found

---

### POST `/daemon/obsidian/sync`
手动触发 Obsidian Git 同步。

**成功响应** `200`: `{ "ok": true, "message": "Obsidian vault synced" }`

**错误**: `500` OBSIDIAN_ROOT not configured / Sync failed

---

### GET `/daemon/obsidian/file`
读取 Obsidian 文件内容（只读）。

**Query**: `?path=slock-clone/PRD.md`

**成功响应** `200`:
```json
{
  "path": "slock-clone/PRD.md",
  "content": "# PRD\n..."
}
```

**错误**:
| 状态码 | 错误 |
|--------|------|
| 400 | path query param required |
| 403 | Path traversal not allowed |
| 404 | File not found |

---

### GET `/daemon/obsidian/tree`
列出 Obsidian 目录结构。

**Query**: `?path=slock-clone` (默认为根目录)

**成功响应** `200`:
```json
{
  "path": "slock-clone",
  "items": [
    { "name": "PRD.md", "type": "file", "path": "slock-clone/PRD.md" },
    { "name": "pages", "type": "directory", "path": "slock-clone/pages" }
  ]
}
```

**说明**: 隐藏文件 (`.git`, `.obsidian`) 自动过滤。目录排在文件前面。

---

## 8. WebSocket 事件

**连接**: `ws://localhost:3000` (Socket.IO)

**认证**: Handshake 时传递：
```js
const socket = io('http://localhost:3000', {
  auth: {
    token: accessToken,
    serverId: 'uuid'
  }
})
```

### Client → Server

| 事件 | Payload | 说明 |
|------|---------|------|
| `join:channel` | `channelId: string` | 加入频道房间 |
| `leave:channel` | `channelId: string` | 离开频道房间 |
| `agent:heartbeat` | `{ agentId: string }` | Agent 心跳 |

### Server → Client

| 事件 | Payload | 说明 |
|------|---------|------|
| `message:new` | `Message` | 新消息 |
| `agent:activity` | `{ agentId, activity, detail, timestamp }` | Agent 活动状态变更 |
| `agent:log` | `{ agentId, level, content, timestamp }` | Agent 日志推送 |
| `task:updated` | `Task` | 任务状态变更 |
| `doc:writing` | `{ agentId, docPath, timestamp }` | 文档编写中 |
| `doc:ready` | `{ agentId, docPath, timestamp }` | 文档编写完成 |
| `agent:rate_limited` | `{ agentId, retryAfter, timestamp }` | API 限流通知 |
| `subagent:action` | `{ agentId, parentRunId, action, timestamp }` | 子 Agent 操作 |

---

## 9. 通用错误码

| 状态码 | 说明 |
|--------|------|
| 400 | 请求参数错误 / 校验失败 |
| 401 | 未认证 / Token 过期 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 409 | 冲突（如重复注册、重复认领） |
| 413 | 文件过大 |
| 429 | API 限流（LLM Provider） |
| 500 | 服务器内部错误 |

---

## 10. 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DB_HOST` | PostgreSQL 主机 | `localhost` |
| `DB_PORT` | PostgreSQL 端口 | `5432` |
| `DB_NAME` | 数据库名 | `redshrimp` |
| `DB_USER` | 数据库用户 | `postgres` |
| `DB_PASSWORD` | 数据库密码 | - |
| `JWT_SECRET` | JWT 签名密钥 | - |
| `PORT` | API Server 端口 | `3000` |
| `SLOCK_SERVER_URL` | WebSocket 地址 | - |
| `OBSIDIAN_ROOT` | Obsidian Vault 根目录 | - |
| `UPLOADS_DIR` | 文件上传目录 | `/var/redshrimp/uploads` |
| `ANTHROPIC_API_KEY` | Claude API Key | - |
| `MOONSHOT_API_KEY` | Kimi API Key | - |
| `OPENAI_API_KEY` | GPT API Key | - |
