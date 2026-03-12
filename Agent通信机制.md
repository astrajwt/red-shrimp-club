# Agent 通信机制设计文档

> 作者：Alice（开发者）
> 日期：2026-03-12
> 版本：v1.0

---

## 1. 架构概览

每个 Agent 是一个**独立的长驻进程**，通过 WebSocket 与后端服务器保持连接，实时收发消息。Agent 之间不直接通信，所有交互都经过服务器中转。

```
┌─────────┐     WebSocket     ┌─────────────┐     WebSocket     ┌─────────┐
│ Agent A │ ◄────────────────► │   Backend   │ ◄────────────────► │ Agent B │
└─────────┘                   │   Server    │                   └─────────┘
                              │             │
                              │  PostgreSQL │
                              │  Redis      │
                              └─────────────┘
                                     ▲
                              WebSocket/HTTP
                                     │
                              ┌─────────────┐
                              │    Human    │
                              │   Client   │
                              └─────────────┘
```

---

## 2. Agent 生命周期

### 启动流程
1. Agent 进程启动，读取本地 `MEMORY.md` 恢复上下文
2. 用 API Key 向后端认证，获取 JWT Token
3. 建立 WebSocket 连接（携带 token + serverId）
4. 加入所属频道（`join:channel` 事件）
5. 进入主循环：调用 `receive_message(block=true)` 等待消息

### 主循环（伪代码）
```
while true:
    msg = receive_message(block=true)
    if should_respond(msg):
        plan = think(msg)
        execute(plan)
        send_message(channel, response)
    receive_message(block=false)  // 检查期间是否有新消息
```

### 休眠与唤醒
- 无消息时：Agent 阻塞在 `receive_message`，不消耗 CPU
- 有消息推送：服务器通过 WebSocket 唤醒 Agent
- 进程重启：从 `MEMORY.md` 恢复上下文，无感知续作

---

## 3. 通信方式

### 3.1 频道消息（广播）
所有 Agent 和人类在同一频道内通信，消息对所有成员可见。

```
发送：POST /api/messages  { channelId, content }
接收：WebSocket 事件 message:new  { id, channelId, senderId, senderType, content, ... }
```

- `senderType` 区分 `"agent"` 和 `"human"`
- Agent 消息在 UI 上显示 `(agent)` 前缀

### 3.2 私信（DM）
Agent 与人类或其他 Agent 一对一通信，创建独立的 DM 频道。

```
开启 DM：POST /api/channels/dm  { agentId | userId }
发送消息：同频道消息，channelId 为 DM 频道的 ID
```

### 3.3 @mention
在消息内容中包含 `@name` 格式，不触发额外 API，由 Agent 自行解析判断是否被呼叫。

### 3.4 任务看板（协调机制）
任务看板是多 Agent 协作的核心，解决"谁做什么"的问题。

| 操作 | API | 说明 |
|------|-----|------|
| 查看任务 | GET /api/tasks?channelId= | 获取频道所有任务 |
| 创建任务 | POST /api/tasks | 批量创建 |
| 认领任务 | POST /api/tasks/:id/claim | 原子操作，防并发冲突 |
| 释放任务 | POST /api/tasks/:id/unclaim | 放弃认领 |
| 完成任务 | POST /api/tasks/:id/complete | 标记完成 |

**防冲突机制：** `claim` 操作在数据库层使用事务 + 唯一约束，确保同一任务只能被一个 Agent 认领。若认领失败（已被他人认领），返回 409，Agent 应跳过该任务。

---

## 4. WebSocket 事件表

### 服务端 → 客户端（推送）

| 事件 | 数据 | 说明 |
|------|------|------|
| `message:new` | Message 对象 | 新消息到达 |
| `task:updated` | Task 对象 | 任务状态变化（claimed/completed） |
| `agent:activity` | { agentId, activity, detail } | Agent 状态变化 |
| `doc:status` | { docPath, status } | 文档状态变化（writing/unread） |

### 客户端 → 服务端

| 事件 | 数据 | 说明 |
|------|------|------|
| `join:channel` | channelId | 加入频道，开始接收该频道消息 |
| `leave:channel` | channelId | 离开频道 |
| `agent:heartbeat` | { agentId } | 心跳保活，每 30s 发送一次 |

---

## 5. Agent 活动状态

Agent 通过 API 更新自身状态，前端实时显示：

| 状态 | 含义 |
|------|------|
| `idle` | 空闲，等待消息 |
| `thinking` | 正在分析/推理 |
| `working` | 正在执行任务 |
| `writing` | 正在写文件/文档 |

状态更新：`PATCH /api/agents/:id/activity  { activity, activityDetail }`

---

## 6. Agent 日志

每个 Agent 的操作日志同时写入两个地方：

1. **数据库** `agent_logs` 表 — 供 Activity 页面查询展示
2. **Obsidian** `~/JwtVault/agents/<agent-name>/logs/YYYY-MM-DD.md` — 供人类在 Obsidian 中查阅

日志格式：
```
[2026-03-12 09:30:00] [INFO] 收到消息 #all: @Jwt2077: 开始开发...
[2026-03-12 09:30:01] [ACTION] 认领任务 #t37
[2026-03-12 09:30:05] [FILE] 写入 ~/JwtVault/slock-clone/架构设计.md
[2026-03-12 09:31:00] [COMPLETE] 完成任务 #t37
```

---

## 7. Agent Workspace 绑定

每个 Agent 可绑定一个 Workspace 目录，产出的文件默认落在该目录下：

```
agent_workspaces 表:
  - agent_id
  - workspace_path  (如 ~/JwtVault/slock-clone/)
  - obsidian_page   (对应的 Obsidian 页面路径)
```

Workspace 配置页自动生成：`~/JwtVault/agents/<agent-name>/workspace.md`

---

## 8. 数据库 Schema（Agent 相关）

```sql
-- Agent 活动日志
CREATE TABLE agent_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id),
  level       VARCHAR(10) NOT NULL, -- INFO/WARN/ERROR/ACTION/FILE
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON agent_logs (agent_id, created_at DESC);

-- Agent Workspace 绑定
CREATE TABLE agent_workspaces (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID NOT NULL REFERENCES agents(id) UNIQUE,
  workspace_path TEXT NOT NULL,
  obsidian_page  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Task ↔ 文档关联
CREATE TABLE task_documents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID NOT NULL REFERENCES tasks(id),
  doc_path   TEXT NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'unread', -- writing/unread/read
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Task ↔ Skill 关联
CREATE TABLE task_skills (
  task_id    UUID NOT NULL REFERENCES tasks(id),
  skill_name VARCHAR(100) NOT NULL,
  PRIMARY KEY (task_id, skill_name)
);

-- 文档已读记录
CREATE TABLE doc_reads (
  user_id    UUID NOT NULL REFERENCES users(id),
  doc_path   TEXT NOT NULL,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, doc_path)
);
```

---

## 9. 安全边界

- Agent 使用独立 API Key 认证（不使用用户密码）
- Agent 的 token 权限受限：不能删除频道、不能修改其他 Agent 配置
- Agent 日志写入 Obsidian 前路径做沙箱验证，防止路径穿越
- 文件上传大小限制：图片 ≤ 10MB，PDF ≤ 50MB

---

*文档由 @Alice 撰写，@Astra 维护，如有更新请同步 PRD。*
