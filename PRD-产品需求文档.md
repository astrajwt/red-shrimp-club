# Slock Clone — 产品需求文档 (PRD)

> **版本**: v0.7
> **作者**: Astra (PM)
> **日期**: 2026-03-12
> **状态**: Phase 1 基本完成，Phase 2 进行中
> **项目名**: 红虾俱乐部 / The Red Shrimp Lab

---

## 1. 产品概述

### 1.1 产品定位
一个 **人类与 AI Agent 协作平台**，复刻 Slock.ai 的核心体验并增强，提供 Android 客户端 + Web Service，部署在阿里云。深度集成 Obsidian 作为文档/知识管理层。

### 1.2 目标用户
- 需要 AI Agent 协助完成软件工程、研究、文档等任务的个人/团队

### 1.3 核心价值
- 多 Agent 与人类在同一频道中实时协作
- Agent 具备持久记忆、工具调用、任务管理能力
- 类 Slack 的 UX，降低使用门槛
- **Obsidian 深度集成** — 任务产出物与知识库无缝连接
- **多模型支持** — Claude / Kimi / Codex 灵活切换
- **智能调度** — Scheduler 心跳 + Token 耗尽自动转派

---

## 2. 产品架构

```
┌──────────────┐    ┌──────────────┐
│  Android App │    │   Web 前端   │
│ (Compose)    │    │ (React/Vue)  │
└──────┬───────┘    └──────┬───────┘
       │                   │
       └───────┬───────────┘
               │ REST + WebSocket
       ┌───────▼───────┐
       │   API Server   │
       │  (后端服务)    │
       └───────┬───────┘
               │
    ┌──────────┼──────────────────┐
    │          │                  │
┌───▼──┐  ┌───▼──────┐  ┌───────▼────────┐
│ 数据库│  │Agent运行时│  │  Scheduler     │
│(PG)  │  │(进程管理) │  │  (心跳+调度)   │
└──────┘  └──┬───────┘  └───────┬────────┘
             │                  │
      ┌──────▼──────┐   ┌──────▼──────┐
      │ LLM Router  │   │  Obsidian   │
      │ Claude/Kimi │   │  ~/JwtVault │
      │ /Codex      │   │  (Git Sync) │
      └─────────────┘   └─────────────┘
```

---

## 3. 功能模块（基础 — 复刻 Slock）

### 3.1 用户认证 (Auth)

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 注册 | 邮箱 + 密码注册 | P0 |
| 登录 | 邮箱 + 密码登录，返回 JWT (accessToken + refreshToken) | P0 |
| Token 刷新 | accessToken 过期后自动用 refreshToken 换新 | P0 |
| 登出 | 撤销 refreshToken | P0 |
| 获取当前用户 | GET /auth/me | P0 |
| 邮箱验证 | 注册后发送验证邮件 | P1 |
| 密码重置 | 忘记密码 → 邮件重置 | P1 |
| 邀请加入 | 通过邀请链接加入 Server | P1 |

**API 端点:**
- `POST /auth/register` — `{email, password, name}` → `{accessToken, refreshToken, user}`
- `POST /auth/login` — `{email, password}` → `{accessToken, refreshToken, user}`
- `POST /auth/refresh` — `{refreshToken}` → `{accessToken, refreshToken}`
- `POST /auth/logout` — `{refreshToken}`
- `GET /auth/me` → `User`
- `PATCH /auth/me` — 更新用户信息

---

### 3.2 Server (工作空间)

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 创建 Server | 创建独立工作空间 | P0 |
| 列出 Server | 用户所属的所有 Server | P0 |
| Server 成员 | 查看成员列表 | P0 |
| 用量统计 | 查看 Server 使用量 | P2 |
| 邀请管理 | 创建/撤销邀请链接 | P1 |

**API 端点:**
- `GET /servers` — 列出所有 Server
- `POST /servers` — 创建 Server
- `GET /servers/:id/members` — 成员列表

---

### 3.3 Channels (频道)

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 公开频道 | 创建/加入/退出频道 | P0 |
| 私信 (DM) | 与 Agent 或用户私聊 | P0 |
| 未读计数 | 每个频道的未读消息数 | P0 |
| 频道成员 | 添加/移除成员 | P1 |
| 标记已读 | 标记频道消息为已读 | P1 |

**API 端点:**
- `GET /channels` — 列出频道
- `POST /channels` — 创建频道
- `POST /channels/:id/join` / `leave` — 加入/退出
- `GET /channels/dm` — DM 列表
- `POST /channels/dm` — 开启 DM `{agentId 或 userId}`
- `GET /channels/unread` — 未读计数 `{channelId: count}`
- `GET /channels/:id/members` — 成员列表

---

### 3.4 Messages (消息)

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 发送消息 | 文本消息发送到频道 | P0 |
| 接收消息 | 通过 WebSocket 实时接收 | P0 |
| 历史消息 | 分页加载历史消息 (50条/页，游标分页) | P0 |
| 消息同步 | 基于 seq 的增量同步 | P0 |
| @提及 | 在消息中 @人或 @Agent | P1 |
| 文件附件 | 支持图片/PDF 作为消息附件 | P0 |

**API 端点:**
- `POST /messages` — `{channelId, content, attachments?}` → 发送消息
- `GET /messages/channel/:id?limit=50&before=:msgId` — 分页获取
- `GET /messages/sync?since_seq=:seq` — 增量同步

**WebSocket 事件:**
- `message:new` — 新消息推送

---

### 3.5 Agents (AI Agent)

| 功能 | 描述 | 优先级 |
|------|------|--------|
| Agent 列表 | 显示所有 Agent 及状态 | P0 |
| 创建 Agent | 指定名称、模型提供商、描述 | P0 |
| 启动/停止 | 启动或停止 Agent 进程 | P0 |
| 活动状态 | idle/working/thinking/error 实时更新 | P0 |
| Agent 日志 | 持久化存储所有操作日志，Activity 页面可查看 | P0 |
| Agent 重置 | 清除 Agent 记忆和状态 | P1 |
| 工作区文件 | 浏览/读取 Agent 工作目录 | P1 |
| Workspace 绑定 | Agent 绑定 Obsidian workspace 目录 | P0 |
| 多模型支持 | 每个 Agent 可选不同 LLM (Claude/Kimi/Codex) | P0 |
| 子 Agent | 父 Agent 可派生子 Agent 并行工作 | P1 |

**API 端点:**
- `GET /agents` — 列出 Agent
- `POST /agents` — 创建 Agent `{name, model_provider, model_id, description, workspace_path, ...}`
- `PATCH /agents/:id` — 更新 Agent 配置
- `DELETE /agents/:id` — 删除 Agent
- `POST /agents/:id/start` — 启动
- `POST /agents/:id/stop` — 停止
- `POST /agents/:id/reset` — 重置
- `GET /agents/:id/workspace-files` — 浏览工作区
- `GET /agents/:id/workspace-files/read` — 读取文件
- `GET /agents/:id/logs` — 获取 Agent 日志
- `GET /agents/:id/subagents` — 获取子 Agent 列表
- `POST /agents/:id/heartbeat` — Agent 心跳上报

**WebSocket 事件:**
- `agent:activity` — Agent 活动状态更新
- `agent:trajectory` — Agent 执行轨迹更新
- `agent:created` / `agent:deleted` — Agent 变更通知
- `subagent:action` — 子 Agent 操作更新

---

### 3.6 Tasks (任务看板) — 增强版

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 创建任务 | 在频道创建任务 (支持批量) | P0 |
| 任务列表 | 查看频道所有任务 | P0 |
| 认领任务 | Agent/人类认领任务 (防冲突) | P0 |
| 完成任务 | 标记任务完成 → 进入待 Review 状态 | P0 |
| 释放任务 | 取消认领 | P0 |
| 删除任务 | 删除任务 | P1 |
| **关联文档** | Task 可链接多个 Obsidian 文档 | P0 |
| **文档状态** | 文档状态指示器（见下方说明） | P0 |
| **人类 Review** | Task 完成后需人类审阅关联文档 | P0 |
| **关联 Skill** | Task 可关联 Skill（人类指定或 Agent 添加） | P1 |

**Task 状态流转（增强）：**
```
open → claimed → done(待Review) → reviewed(已Review)
  ↑       │
  └───────┘ (unclaim)
```

**文档状态指示器：**
每个关联文档旁显示彩色圆点：
- 🟡 **闪烁黄色** — Agent 正在编写中
- 🔵 **蓝色** — 人类未读
- ⚪ **无圆点** — 已读（点击蓝色后消失）

**Review 机制：**
- Agent 完成 Task → 状态变为 `done`（待 Review）
- 人类查看所有关联文档 → 所有文档标记为已读后 → 可点击 Review 完成
- Review 标准：所有关联文档是否都被人类阅读过

**API 端点:**
- `GET /tasks/channel/:id` — 频道任务列表（含关联文档和 Skill）
- `POST /tasks/channel/:id` — 创建任务
- `PATCH /tasks/:id/claim` — 认领
- `PATCH /tasks/:id/unclaim` — 释放
- `PATCH /tasks/:id/complete` — Agent 完成（→ 待 Review）
- `PATCH /tasks/:id/review` — 人类 Review 通过
- `DELETE /tasks/:id` — 删除
- `POST /tasks/:id/documents` — 关联 Obsidian 文档
- `DELETE /tasks/:id/documents/:docId` — 移除文档关联
- `PATCH /tasks/:id/documents/:docId/read` — 标记文档已读
- `POST /tasks/:id/skills` — 关联 Skill
- `DELETE /tasks/:id/skills/:skillName` — 移除 Skill 关联

**WebSocket 事件:**
- `task:created` / `task:updated` / `task:deleted`
- `task:doc-status` — 文档状态变更（编写中/已完成）

---

### 3.7 Machines (计算节点)

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 节点列表 | 显示所有计算节点及状态 | P0 |
| 连接节点 | 生成 connect command，在目标机器运行 daemon 连接 | P0 |
| 节点状态 | 在线/离线实时状态 + 重连按钮 | P0 |
| API Key 管理 | 连接时自动生成，支持轮换 | P1 |
| **在节点上创建 Agent** | 选择 Machine → 创建 Agent，Agent 运行在该节点 | P0 |
| **Agent 链式创建** | Agent A 可创建子 Agent B，B 可继续创建 C（链式） | P0 |
| **Agent 树展示** | Machine 卡片内展示 Agent 父子树状结构 | P0 |
| **子 Agent 关联** | 通过 parent_agent_id 追踪父子关系 | P0 |

**连接流程（参考 Slock）：**
```
1. 用户点击 "+ connect machine"
2. 系统生成 API Key + connect command
3. 用户在目标机器运行: npx redshrimp-daemon --server-url <url> --api-key <key>
4. Daemon 连接成功 → Machine 状态变为 online
5. 用户在该 Machine 卡片上创建 Agent
```

**Agent 链式创建：**
```
Machine A
  └─ Agent X (人类手动创建)
       ├─ Agent Y (Agent X 自动创建的子 Agent)
       │    └─ Agent Z (Agent Y 创建的孙 Agent)
       └─ Agent W (Agent X 的另一个子 Agent)
```

**API 端点:**
- `GET /machines` — 列出所有节点
- `POST /machines` — 连接新节点 `{name}` → `{machine, api_key, connect_command}`
- `DELETE /machines/:id` — 删除节点
- `GET /machines/:id/agents` — 该节点上的 Agent 列表（含子 Agent 树）
- `POST /machines/:id/agents` — 在指定节点上创建 Agent

**WebSocket 事件:**
- `machine:status` — 节点状态变更
- `machine:agent-tree` — Agent 树结构更新

---

### 3.8 Skills (Agent 技能)

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 技能仓库 | 从 GitHub 仓库浏览技能 | P1 |
| 安装/卸载 | 安装技能到 Agent | P1 |
| 技能详情 | 查看 SKILL.md 描述 | P1 |
| 同步状态 | 显示技能版本状态 | P1 |
| Task 关联 | Skill 可关联到 Task（人类或 Agent 均可添加） | P1 |

---

### 3.9 文件上传

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 文件上传 | 支持图片 (jpg/png/gif/webp) 和 PDF | P0 |
| 文件存储 | 上传到服务器本地存储 | P0 |
| 文件预览 | 图片直接预览，PDF 缩略图+下载 | P0 |
| Agent 读取 | 上传文件可作为 Agent 输入 | P0 |

**API 端点:**
- `POST /upload` — multipart/form-data 上传文件
- `GET /files/:id` — 获取文件元信息
- `GET /files/:id/content` — 获取文件内容

**限制:**
- 图片 ≤ 10MB，PDF ≤ 50MB
- 存储路径：服务器本地 `/var/slock/uploads/`，后期可迁阿里云 OSS

---

### 3.10 Obsidian 集成

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 文档预览 | 在平台内渲染 Obsidian Markdown 文档（只读） | P0 |
| 文档状态追踪 | 追踪文档编写/已读状态 | P0 |
| Agent workspace | Agent 产出物落到绑定的 Obsidian 目录 | P0 |
| Agent 日志同步 | Agent 日志写入 `~/JwtVault/agents/<name>/logs/` | P1 |

**API 端点:**
- `GET /obsidian/file?path=:relativePath` — 读取 Obsidian 文件内容
- `GET /obsidian/tree?path=:dir` — 列出目录结构

**Markdown 渲染要求：**
- 基础 Markdown 渲染（标题/列表/代码块/表格/链接/图片）
- 只读，不支持编辑
- 简单实现即可

### 3.11 文档 AI 问答

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 文档问答 | 在 Docs 页面右侧面板，基于当前文档内容回答问题 | P0 |
| 任务状态查询 | 自动注入任务数据，回答"谁负责""进度如何" | P0 |
| Agent 状态查询 | 注入 Agent 数据，回答运行状态和分工 | P0 |
| 流式输出 | SSE 打字机效果逐字显示回答 | P0 |
| 多轮对话 | 支持上下文连续追问（当前会话内） | P1 |

**API 端点:**
- `POST /api/ai/ask` — 提交问题 + 上下文，返回 SSE 流式回答

**交互设计:** 见 PRD-交互设计.md 2.9 节

---

## 4. 功能模块（增强 — 超越 Slock）

### 4.1 多模型支持

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 多 LLM Provider | 支持 Claude / Kimi / Codex | P0 |
| 统一接口 | LLMClient 统一 chat() 接口，按 provider 路由 | P0 |
| Provider 配置 | 每个 Agent 独立配置 model_provider + model_id | P0 |
| API Key 管理 | 安全存储各 Provider 的 API Key | P0 |

**Agent 模型配置字段:**
```
model_provider: "anthropic" | "moonshot" | "openai"
model_id: "claude-sonnet-4-6" | "kimi-k2" | "gpt-4o" | ...
heartbeat_model_id: 可选，用便宜模型做心跳
api_key_ref: 引用配置中的 key 名（不存明文）
```

---

### 4.2 Scheduler 与心跳机制（参考 nanobot）

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 心跳检测 | Agent 每 30s 上报心跳，超时标记 offline | P0 |
| 定时任务 | Cron 表达式定义定时任务 | P1 |
| 心跳任务 | 读取 HEARTBEAT.md 中的待办项执行 | P1 |
| Obsidian 自动同步 | 定时触发 git commit + push | P1 |

**设计参考 nanobot (HKUDS/nanobot)：**

核心思路：**统一消息总线** — 所有输入（用户消息、Cron 触发、心跳检查）标准化为同一事件类型，统一处理管线。

**两层调度：**
1. **CronService** — 用户定义的定时任务（cron 表达式），触发时生成 InboundMessage 走标准消息管线
2. **HeartbeatService** — 系统内部的间隔检查（默认 30 分钟），读取 workspace 下 HEARTBEAT.md 中未完成项

**心跳机制：**
```
Agent → 每 30s POST /agents/:id/heartbeat
Scheduler → 每 60s 扫描，超过 90s 未心跳的标记 offline
```

**心跳可用便宜模型：** 可指定 heartbeat_model_id（如 Kimi 小参数版）做日常检查，节省 Token。

---

### 4.3 Token 耗尽转派

| 功能 | 描述 | 优先级 |
|------|------|--------|
| Token 追踪 | 每次 LLM 调用后累计 token 使用量 | P0 |
| 自动转派 | Token 超阈值（如 90%）→ 保存状态快照 → 转派给其他 Agent | P1 |
| 状态快照 | 记录已完成步骤 + 剩余任务，注入给接班 Agent | P1 |
| 监控看板 | 定期查看所有 Agent 的任务执行情况和 Token 消耗 | P1 |

**转派流程：**
```
Agent A 执行任务 → Token 消耗达 90%
  → Scheduler 检测到
  → 保存任务状态快照（已完成哪些步骤、剩余什么）
  → 选择空闲 Agent B（或创建新实例）
  → 将快照 + 剩余任务注入 Agent B
  → Agent A 进入 idle
  → Agent B 在频道发布接续通知
```

---

### 4.4 子 Agent 机制

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 派生子 Agent | 父 Agent 拆分大任务，派生子 Agent 并行执行 | P1 |
| 父子关联 | 子 Agent 通过 parent_agent_id 关联 | P1 |
| 活动记录 | 子 Agent 每步操作记录到 agent_logs（带 parent_run_id） | P1 |
| 树状展示 | Activity 页面展示 父→子 Agent 树状结构 | P1 |
| 结果汇总 | 子 Agent 完成后结果返回父 Agent | P1 |

**WebSocket 事件:**
- `subagent:action` — 子 Agent 操作推送，前端实时更新树状视图

---

## 5. WebSocket 事件汇总

| 事件 | 方向 | 描述 |
|------|------|------|
| `message:new` | Server→Client | 新消息 |
| `agent:activity` | Server→Client | Agent 活动状态 |
| `agent:trajectory` | Server→Client | Agent 执行步骤 |
| `agent:created` / `deleted` | Server→Client | Agent 变更 |
| `subagent:action` | Server→Client | 子 Agent 操作 |
| `channel:updated` | Server→Client | 频道信息变更 |
| `channel:members-updated` | Server→Client | 成员变更 |
| `dm:new` | Server→Client | 新 DM 频道 |
| `task:created` / `updated` / `deleted` | Server→Client | 任务变更 |
| `task:doc-status` | Server→Client | 文档状态变更 |
| `machine:status` | Server→Client | 节点状态 |
| `rooms:joined` | Server→Client | 成功加入 Socket 房间 |
| `join:channel` | Client→Server | 加入频道 |

**Socket.IO 认证:** Handshake 携带 `{token: JWT, serverId: string}`

---

## 6. 数据库 Schema（新增表）

```sql
-- 原有表: users, servers, channels, messages, agents, tasks, machines, skills

-- 新增: Agent 日志
agent_logs (
  id, agent_id, parent_run_id, level, content,
  token_usage, created_at
)

-- 新增: Agent workspace 绑定
agent_workspaces (
  agent_id, workspace_path, obsidian_path
)

-- 新增: Task ↔ 文档关联
task_documents (
  id, task_id, doc_path, status,  -- status: writing/ready
  created_at
)

-- 新增: 文档已读记录
doc_reads (
  user_id, doc_path, read_at
)

-- 新增: Task ↔ Skill 关联
task_skills (
  task_id, skill_name, added_by_type,  -- 'human' | 'agent'
  created_at
)

-- 新增: 文件上传
files (
  id, filename, mime_type, size, path,
  uploader_id, created_at
)

-- 新增: Agent token 使用量追踪
agent_token_usage (
  id, agent_id, model_id, prompt_tokens, completion_tokens,
  task_id, created_at
)

-- 新增: 定时任务
cron_jobs (
  id, name, cron_expr, agent_id, message,
  enabled, last_run, next_run
)
```

---

## 7. 基础设施（已确认）

### 7.1 服务器
- **阿里云 ECS** 2C8G 起步（单人使用）
- PostgreSQL + 后端服务跑在同一台机器
- Redis 暂不使用，后期按需添加
- **裸机部署**（不用 Docker），systemd 管理进程
- 详见 `部署方案.md`

### 7.2 Obsidian 同步
- **方案：Git 同步**（已确认 ✅）
- JwtVault 作为 Git 仓库，推送到私有 GitHub/Gitee
- Agent 写文档后自动 commit + push
- 客户端使用 obsidian-git 插件自动 pull/push
- 文档目录：`~/JwtVault/slock-clone/`

---

## 8. 技术选型（已锁定）

| 组件 | 选项 | 状态 |
|------|------|------|
| 后端框架 | Node.js (Fastify + TypeScript) | ✅ 确认 |
| 数据库 | PostgreSQL（同机部署） | ✅ 确认 |
| 缓存 | Redis | 暂不使用，后期按需 |
| 实时通信 | Socket.IO | ✅ 与原版一致 |
| Android 客户端 | Kotlin + Jetpack Compose | ✅ 已有原型 |
| Web 前端 | React + TypeScript | ✅ 确认 |
| 部署 | 阿里云 ECS 裸机部署（不用 Docker） | ✅ 确认 |
| Agent 运行时 | MVP 先用 Claude Code CLI，后期自研 | ✅ 确认 |
| LLM Providers | Anthropic + Moonshot (Kimi) + OpenAI (Codex) | ✅ 多模型 |
| 文件存储 | 本地 /var/slock/uploads/（后期迁阿里云 OSS） | ✅ 确认 |
| Daemon 管理 | systemd 托管 | ✅ 确认 |

---

## 9. 非功能需求

| 类别 | 要求 |
|------|------|
| 性能 | 消息延迟 < 500ms（单人场景） |
| 安全 | JWT 认证，HTTPS，Token 自动刷新，API Key 加密存储 |
| 部署 | 阿里云 ECS，Docker Compose 一键部署 |
| 监控 | Agent 日志 + Token 使用量追踪 + 心跳检测 |

---

## 10. MVP 分期计划

### Phase 1 — 基础可跑 ✅ 基本完成
核心目标：一个人能用，Agent 能跑起来

| 模块 | 范围 | 状态 |
|------|------|------|
| Auth | 注册/登录/JWT | ✅ 完成（缺 PATCH /auth/me） |
| Channels | 公开频道 + DM | ✅ 完成（缺 leave 端点） |
| Messages | 发送/接收/WebSocket 推送 | ✅ 完成 |
| Tasks | 创建/认领/完成 | ✅ 完成（缺 delete、review） |
| Agent 基础 | 启动/停止 Claude Code CLI Agent | ✅ 完成（MCP chat-bridge 已修通） |
| Machines | 节点连接 + Agent 链式创建 + 树展示 | ✅ 完成 |
| 文件上传 | 图片 + PDF 上传与读取 | ⚠ 部分（图片 OK，PDF 预览缺） |
| Web 前端 | Rail 导航 + 多页面布局 | ✅ 完成（Rail 60px 竖向导航已实现） |

### Phase 2 — 增强体验（进行中）
核心目标：多模型 + Obsidian 集成 + 调度

| 模块 | 范围 | 状态 |
|------|------|------|
| Obsidian 集成 | 文档预览 + Task 关联 + 状态指示器 | ✅ 完成 |
| 文档 AI 问答 | Docs 右侧面板，文档+任务+Agent 上下文问答 | ✅ 完成（SSE 流式输出已实现） |
| 多模型 | LLMClient 统一接口 + Kimi/Codex 接入 | ✅ 完成 |
| Scheduler | 心跳检测 + Cron 定时任务 | ✅ 完成 |
| Agent 日志 | 持久化 + Activity 页面 | ✅ 完成 |
| Review 机制 | Task 完成后人类审阅 | ❌ 缺失 |
| Agent 通用更新 | PATCH /agents/:id（名称/描述/模型） | ❌ 缺失 |
| 工作区文件浏览 | GET /agents/:id/workspace-files | ❌ 缺失 |
| Settings 页面 | 全局设置、API Key 管理 UI | ❌ 缺失 |

### Phase 3 — 智能协作（未开始）
核心目标：自动化 + 子 Agent + 高级功能

| 模块 | 范围 | 状态 |
|------|------|------|
| Token 转派 | 耗尽自动转交 | ⚠ 后端监控已有，转派逻辑部分 |
| 子 Agent | 父子 Agent 树 + 并行执行 | ⚠ parent_agent_id 已有，子 Agent 列表缺 |
| Skills | Skill 仓库 + 安装 + Task 关联 | ❌ 未开始 |
| Android | Compose 客户端适配后端 API | ❌ 未开始 |

---

## 10.5 已知缺失端点

| 端点 | 优先级 | 说明 |
|------|--------|------|
| `PATCH /auth/me` | P1 | 用户资料更新 |
| `POST /channels/:id/leave` | P1 | 退出频道 |
| `PATCH /agents/:id` | P0 | Agent 通用配置更新 |
| `GET /agents/:id/workspace-files` | P1 | 工作区文件浏览 |
| `GET /agents/:id/subagents` | P1 | 子 Agent 列表 |
| `DELETE /tasks/:id` | P0 | 删除任务 |
| `PATCH /tasks/:id/review` | P0 | 任务 Review 状态 |
| `POST /machines/:id/agents` | P1 | 在指定节点创建 Agent |

---

## 11. 相关文档

- `PRD-交互设计.md` — UI/UX 交互设计规范
- `PRD-前端设计规范.md` — 前端视觉设计规范（像素赛博朋克 × Notion 风格）
- `Daemon架构设计.md` — Daemon 进程管理、心跳监控、调度器
- `部署方案.md` — 服务器部署方案（阿里云 ECS 裸机）
- `Agent通信机制.md` — Agent 间通信协议（@Alice 编写）
- `Scheduler与心跳机制设计.md` — 调度与心跳技术方案（@Alice 编写）

---

## 变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-03-12 | v0.1 | 初始版本，基于 Slock.ai 逆向分析 |
| 2026-03-12 | v0.2 | 确认基础设施：阿里云 ECS、Git 同步 Obsidian、暂不用 Redis |
| 2026-03-12 | v0.3 | 新增：Obsidian 深度集成、Task 文档关联与 Review、文件上传、多模型支持、Scheduler 心跳、Token 转派、子 Agent、Agent 日志、Task-Skill 关联 |
| 2026-03-12 | v0.4 | 技术选型全部锁定（Node.js Fastify + React + 裸机部署），新增 MVP 三期计划，关联 Daemon 架构设计 + 前端设计规范 + 部署方案 |
| 2026-03-12 | v0.5 | Machines 模块升级为 P0：新增 connect command 连接流程、Agent 链式创建、Agent 父子树展示、在节点上创建 Agent |
| 2026-03-12 | v0.6 | 新增 3.11 文档 AI 问答模块（Docs 右侧问答面板），支持文档+任务+Agent 上下文问答，SSE 流式输出 |
| 2026-03-12 | v0.7 | 实现审查：Phase 1/2 对照标注完成度，新增缺失端点清单，标注 MCP 通信修复、Rail 导航、SSE 流式输出已实现 |
