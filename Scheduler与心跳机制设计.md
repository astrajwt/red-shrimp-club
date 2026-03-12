# Scheduler 与心跳机制设计

> 作者：Alice（开发者）
> 日期：2026-03-12
> 参考：[nanobot HeartbeatService](https://github.com/HKUDS/nanobot)
> 版本：v1.0

---

## 1. 设计思路（参考 nanobot）

nanobot 的核心设计：
- **HeartbeatService** — 每 30 分钟唤醒一次，读取 workspace 下的 `HEARTBEAT.md`，执行其中未勾选的任务（`- [ ]` 格式），结果推送到最近活跃的频道
- **CronService** — 用户自定义的定时任务（cron 表达式）
- 心跳和 Cron 都**绕过消息总线**，直接调用 Agent 处理逻辑（`AgentLoop.process_direct()`）

我们在此基础上扩展，支持多模型 + 分布式 Agent。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────┐
│                  Backend Scheduler                   │
│                                                      │
│  ┌──────────────────┐    ┌──────────────────────┐   │
│  │  HeartbeatService │    │     CronService       │   │
│  │  (每 N 分钟 tick) │    │  (cron 表达式定时)   │   │
│  └────────┬─────────┘    └──────────┬───────────┘   │
│           │                         │               │
│           └──────────┬──────────────┘               │
│                      ▼                              │
│            ┌──────────────────┐                     │
│            │  AgentDispatcher │                     │
│            │  (选择合适模型)   │                     │
│            └────────┬─────────┘                     │
└─────────────────────┼───────────────────────────────┘
                      │ 触发
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
  Claude Agent    Kimi Agent    Codex Agent
  (复杂推理)     (轻量心跳)    (代码生成)
```

---

## 3. HeartbeatService 设计

### 3.1 工作原理

```
每 N 分钟（默认 30 分钟，可配置）:
  1. 读取 Agent 的 workspace/HEARTBEAT.md
  2. 找出所有未完成项（- [ ] ...）
  3. 将这些任务投递给指定的心跳模型处理
  4. 处理结果推送到该 Agent 最近活跃的频道
  5. 完成的任务标记为 [x]
```

### 3.2 HEARTBEAT.md 格式

```markdown
# Alice 心跳任务

- [ ] 检查是否有未认领的开发任务，如有则认领并汇报
- [ ] 检查昨日开发日志是否已推送到 Obsidian
- [ ] 如果有待 Review 的 PR，提醒 @Jwt2077
- [x] ~~每日站会汇报（已完成）~~
```

### 3.3 心跳模型选择

心跳任务通常是轻量判断（"有没有待处理任务"），不需要高智能模型：

| 场景 | 推荐模型 | 原因 |
|------|----------|------|
| 心跳检查（轻量） | Kimi 小参数版 / GPT-4o-mini | 便宜，够用 |
| 复杂任务执行 | Claude Sonnet / Kimi K2 | 推理能力强 |
| 代码生成 | Codex / Claude | 代码专长 |
| 文档编写 | Claude | 写作质量高 |

配置示例（`agent_config.json`）：
```json
{
  "heartbeat_model": "moonshot/kimi-k1-8k",
  "task_model": "anthropic/claude-sonnet-4-6",
  "code_model": "openai/gpt-4o",
  "heartbeat_interval_minutes": 30
}
```

---

## 4. CronService 设计

支持用户/Agent 自定义定时任务：

```sql
CREATE TABLE scheduled_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agents(id),
  cron_expr    VARCHAR(100) NOT NULL,   -- "0 9 * * 1-5" (工作日 9 点)
  prompt       TEXT NOT NULL,            -- 触发时发给 Agent 的指令
  channel_id   UUID REFERENCES channels(id),  -- 结果发到哪个频道
  model_override VARCHAR(100),           -- 可覆盖默认模型
  enabled      BOOLEAN NOT NULL DEFAULT true,
  last_run_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

使用场景示例：
```
cron: "0 9 * * 1-5"   prompt: "生成今日工作计划并发到 #all"
cron: "0 18 * * 1-5"  prompt: "汇总今日开发进度，更新 Obsidian 项目进度.md"
cron: "*/5 * * * *"   prompt: "检查 Obsidian git 是否需要同步"
```

---

## 5. 多模型 LLM Provider 设计

### 5.1 统一接口

```typescript
interface LLMProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string>
}

// 各 Provider 实现
class AnthropicProvider implements LLMProvider { ... }  // Claude
class MoonshotProvider implements LLMProvider { ... }   // Kimi
class OpenAIProvider implements LLMProvider { ... }     // Codex / GPT

// 工厂函数
function createProvider(modelId: string, apiKey: string): LLMProvider {
  if (modelId.startsWith('claude')) return new AnthropicProvider(...)
  if (modelId.startsWith('moonshot') || modelId.startsWith('kimi')) return new MoonshotProvider(...)
  return new OpenAIProvider(...)
}
```

### 5.2 数据库 Schema

```sql
-- Agent 支持多模型配置
ALTER TABLE agents ADD COLUMN model_provider VARCHAR(50) DEFAULT 'anthropic';
ALTER TABLE agents ADD COLUMN model_id VARCHAR(100) DEFAULT 'claude-sonnet-4-6';
ALTER TABLE agents ADD COLUMN heartbeat_model_id VARCHAR(100);  -- 心跳专用模型（可为空）
ALTER TABLE agents ADD COLUMN heartbeat_interval_minutes INT DEFAULT 30;

-- API Key 安全存储（不存明文，引用环境变量名）
CREATE TABLE provider_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID NOT NULL REFERENCES servers(id),
  provider     VARCHAR(50) NOT NULL,   -- anthropic / moonshot / openai
  key_env_ref  VARCHAR(100) NOT NULL,  -- 环境变量名，如 "MOONSHOT_API_KEY"
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (server_id, provider)
);
```

### 5.3 Agent 心跳检测

```
Agent                    Backend
  │                        │
  │── heartbeat ping ──►   │  (每 30s，WebSocket 或 HTTP)
  │                        │  更新 agents.last_heartbeat_at
  │                        │
  │                        │  Scheduler 每 60s 扫描：
  │                        │  last_heartbeat_at > 90s → 标记 offline
  │                        │  触发 agent:offline 事件推送给前端
```

---

## 6. Scheduler 实现方案

### 推荐：使用 `node-cron` + Bull Queue

```
node-cron  →  触发定时任务  →  Bull Queue  →  Worker 处理
                                              ├── 调用 LLMProvider
                                              ├── 发送消息到频道
                                              └── 写入 agent_logs
```

**Bull Queue** 的优势：
- 任务持久化（Redis），服务重启不丢任务
- 支持重试、延迟、优先级
- 可视化监控（Bull Board）

```typescript
// 心跳调度器示例
const heartbeatQueue = new Bull('agent-heartbeat', { redis: REDIS_URL })

// 每分钟检查哪些 Agent 需要心跳
cron.schedule('* * * * *', async () => {
  const agents = await db.query(`
    SELECT * FROM agents
    WHERE enabled = true
    AND (last_heartbeat_triggered_at IS NULL
      OR last_heartbeat_triggered_at < NOW() - INTERVAL '1 minute' * heartbeat_interval_minutes)
  `)
  for (const agent of agents) {
    await heartbeatQueue.add({ agentId: agent.id })
  }
})

// Worker 处理心跳
heartbeatQueue.process(async (job) => {
  const agent = await getAgent(job.data.agentId)
  const heartbeatMd = readWorkspaceFile(agent, 'HEARTBEAT.md')
  const pendingTasks = extractUncheckedItems(heartbeatMd)
  if (pendingTasks.length === 0) return

  const model = createProvider(agent.heartbeat_model_id || agent.model_id, ...)
  const response = await model.chat([
    { role: 'system', content: agent.system_prompt },
    { role: 'user', content: pendingTasks.join('\n') }
  ])

  await sendMessageToChannel(agent.last_active_channel_id, response, agent.id)
  await logAgentAction(agent.id, 'heartbeat', response)
})
```

---

## 7. 与 Obsidian 的集成

心跳任务可以直接操作 Obsidian 文件：

```markdown
# Alice HEARTBEAT.md

- [ ] 检查 ~/JwtVault/slock-clone/项目进度.md 中是否有逾期任务
- [ ] 如果 ~/JwtVault/slock-clone/开发日志/ 今日无记录，创建今日日志
- [ ] git -C ~/JwtVault add -A && git commit -m "auto sync" && git push
```

Scheduler 执行心跳时，Agent 有完整的文件系统访问权限，可以读写 Obsidian vault，然后将摘要结果发到频道。

---

## 8. 总结：技术栈选型

| 组件 | 技术 |
|------|------|
| 定时触发 | node-cron |
| 任务队列 | Bull + Redis |
| 多模型路由 | 自研 LLMProvider 接口 |
| 心跳配置 | HEARTBEAT.md（参考 nanobot） |
| Agent 在线检测 | WebSocket ping + 90s 超时判定 |

---

---

## 9. Scheduler 监控 + Token 耗尽转派

### 9.1 Token 使用量追踪

每次 LLM 调用后，Agent 上报 token 消耗：

```sql
CREATE TABLE agent_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id),
  parent_run_id   UUID REFERENCES agent_runs(id),  -- 子 Agent 关联父 run
  task_id         UUID REFERENCES tasks(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'running',  -- running/completed/handoff/failed
  tokens_used     INT NOT NULL DEFAULT 0,
  tokens_limit    INT NOT NULL DEFAULT 200000,
  context_snapshot JSONB,   -- token 耗尽时保存的上下文快照
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);
```

### 9.2 Token 耗尽转派流程

```
Agent 每次调用 LLM 后：
  tokens_used += response.usage.total_tokens
  if tokens_used / tokens_limit > 0.90:
    1. 发出 context_exhausted 信号（更新 agent_runs.status = 'handoff'）
    2. 序列化当前工作状态到 context_snapshot（已完成步骤、剩余任务、关键变量）
    3. Scheduler 检测到 handoff 信号
    4. 选择接班 Agent（同类型空闲 Agent 或启动新实例）
    5. 将 context_snapshot + 剩余任务作为系统 prompt 注入新 Agent
    6. 新 Agent 接续工作，在频道发布 "接续 @OldAgent 的工作..."
    7. 原 Agent 标记 idle，等待 context 刷新
```

### 9.3 接班 Agent 的系统 prompt 格式

```
你接替 @Alice 继续以下工作。
已完成：
  - [x] 设计数据库 Schema
  - [x] 实现 /auth 路由
待完成：
  - [ ] 实现 /channels 路由
  - [ ] 实现 WebSocket 事件处理

上下文摘要：
  - 技术栈：Node.js + Fastify + PostgreSQL
  - 当前文件：src/routes/channels.ts
  - 已知问题：...

请继续完成剩余工作。
```

---

## 10. 子 Agent（Sub-agent）机制

### 10.1 设计概念

父 Agent 可以派生子 Agent 并行处理子任务：

```
Alice（父 Agent，Run #001）
├── SubAgent-Alice-1（Run #002）：实现 /messages 路由
├── SubAgent-Alice-2（Run #003）：实现 /channels 路由
└── SubAgent-Alice-3（Run #004）：实现 /auth 路由
```

子 Agent 共享父 Agent 的身份（同一个 agent_id），但有独立的 run_id，通过 `parent_run_id` 关联。

### 10.2 子 Agent 创建流程

```
父 Agent：
  子任务列表 = 拆分当前大任务
  for 子任务 in 子任务列表:
    创建 agent_run（parent_run_id = 当前 run_id）
    启动子 Agent 进程（或协程），传入子任务上下文
    子 Agent 开始执行，日志写入 agent_logs（带 run_id）

父 Agent 等待所有子 Agent 完成（轮询 agent_runs 状态）
汇总结果，继续后续步骤
```

### 10.3 Activity 页面展示（树状结构）

```
▼ Alice                        [working]  09:30
  ▼ 拆分任务：实现 API 路由层
    ▼ SubAgent-1               [done]     09:31
      · 读取 src/routes/messages.ts
      · 实现 GET /messages/channel/:id
      · 实现 POST /messages
      · 写入文件完成
    ▼ SubAgent-2               [working]  09:31
      · 读取 src/routes/channels.ts
      · 实现 GET /channels ...
    ▼ SubAgent-3               [waiting]  -
```

- 父 Agent 行展开/折叠子 Agent 列表
- 每个子 Agent 的日志条目实时追加
- 状态颜色：running(黄) / done(绿) / failed(红) / waiting(灰)

### 10.4 子 Agent 日志 Schema

```sql
-- agent_logs 新增字段
ALTER TABLE agent_logs ADD COLUMN run_id UUID REFERENCES agent_runs(id);

-- 查询某个父 run 的所有子 Agent 日志
SELECT al.*, ar.parent_run_id
FROM agent_logs al
JOIN agent_runs ar ON al.run_id = ar.id
WHERE ar.id = $parentRunId OR ar.parent_run_id = $parentRunId
ORDER BY al.created_at;
```

### 10.5 WebSocket 推送

子 Agent 的每个动作实时推送到前端：

```
服务端事件：subagent:action
{
  parentRunId: "run-001",
  subRunId: "run-002",
  agentName: "SubAgent-Alice-1",
  action: "file:write",
  detail: "src/routes/messages.ts",
  timestamp: "2026-03-12T09:31:05Z"
}
```

前端 Activity 页面订阅此事件，实时更新树状视图。

---

参考：
- [nanobot Heartbeat System](https://deepwiki.com/HKUDS/nanobot/7.2-heartbeat-system)
- [HKUDS/nanobot GitHub](https://github.com/HKUDS/nanobot)

*文档由 @Alice 撰写，如有更新请同步 PRD。*
