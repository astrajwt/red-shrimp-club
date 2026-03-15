# Slock 逆向分析报告

> **版本**: v1.0
> **分析人**: aa, bb
> **日期**: 2026-03-13
> **来源**: `/opt/slock/` 生产部署目录

---

## 1. 整体架构

Slock 采用 **Slack 式消息总线 + 轻量 Swarm 协作 + CLI Runtime Driver** 的架构，核心分为三层：

| 层 | 组件 | 职责 |
|---|------|------|
| Web 前端 | React SPA | 频道聊天、任务看板、Agent 管理 |
| 后端服务 | Node.js (Fastify) | REST API、WebSocket、Agent 生命周期 |
| 运行时驱动 | Claude / Codex / Kimi Driver | 将 CLI 包装为常驻 runtime，通过 MCP 桥接消息 |

### 1.1 与常见 Swarm 框架的差异

Slock **不是** LangGraph 那种重状态图编排系统。它更像是：

- **nanobot**: Heartbeat / 定时唤醒机制有明确参考
- **OpenAI Swarm / AutoGen / CrewAI**: 多 agent 分工、handoff、claim task 的协作思路
- **Slack/Discord**: 频道消息总线 + presence + 未读模型
- **Claude Code / Codex CLI**: 把现成 CLI 包成常驻 runtime，而不是每次临时调用

---

## 2. Agent 生命周期与 Driver 模式

### 2.1 Driver 架构

每种 LLM CLI 都有对应的 Driver，负责：
- 构建启动参数
- 注入 MCP chat bridge
- 管理进程生命周期（start / stop / resume）
- 解析 JSON 输出流（trajectory events）

支持的 Driver：

| Driver | CLI 工具 | MCP 注入方式 | 输出格式 |
|--------|---------|-------------|---------|
| `claude` | `claude` CLI | `--mcp-config <json-file>` | JSON stream (`--output-format stream-json`) |
| `codex` | `codex exec` | `-c mcp_servers.chat.*` (inline flags) | `--json` |
| `kimi` | `kimi` CLI | `--mcp-config <json-file>` | JSON stream |

### 2.2 Claude Driver 启动参数

```bash
claude \
  --output-format stream-json \
  --verbose \
  --model <model_id> \
  --max-turns 200 \
  --mcp-config /tmp/mcp-<agentId>.json \
  --allowedTools "mcp__chat__*" \
  --permission-mode acceptEdits \
  --resume <sessionId>  # 仅 resume 时
  -p "<prompt>"
```

### 2.3 Codex Driver 启动参数

```bash
codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  --json \
  -c 'mcp_servers.chat.command="node"' \
  -c 'mcp_servers.chat.args=["/path/to/chat-bridge.mjs","--agent-id","<id>","--server-url","http://..."]' \
  -c 'mcp_servers.chat.startup_timeout_sec=30' \
  -c 'mcp_servers.chat.tool_timeout_sec=120' \
  -c 'mcp_servers.chat.enabled=true' \
  -c 'mcp_servers.chat.required=true' \
  -m o4-mini \
  "<prompt>"
```

**关键发现**: Codex CLI **不支持** `--mcp-config` 参数，必须用 `-c` flags 逐项传入 MCP server 配置。

### 2.4 环境变量处理

```typescript
// Slock 的 buildEnv() 逻辑
// 1. 不传空的 API key（避免覆盖 CLI 自身的认证）
// 2. 只传非空的 key
const anthropicKey = process.env.ANTHROPIC_API_KEY
if (anthropicKey && anthropicKey.trim()) {
  env.ANTHROPIC_API_KEY = anthropicKey
}
```

**Bug 复现**: 如果 `.env` 中有空的 `ANTHROPIC_API_KEY=`，会覆盖 Claude CLI 的 `~/.claude/` 本地认证，导致 "Invalid API key" 错误。

---

## 3. 消息投递架构

### 3.1 MCP Chat Bridge

每个 Agent 进程都会启动一个 MCP server（`chat-bridge.mjs`），提供以下工具：

| Tool | 功能 |
|------|------|
| `send_message` | 发消息到频道或 DM |
| `receive_message` | 接收新消息（支持阻塞等待） |
| `list_server` | 列出频道和成员 |
| `read_history` | 读取消息历史 |
| `list_tasks` | 查看任务看板 |
| `create_tasks` | 创建任务 |
| `claim_tasks` | 认领任务 |
| `unclaim_task` | 释放任务 |
| `update_task_status` | 更新任务状态 |

### 3.2 Inbox 队列 + pendingReceive 模式

```
外部消息 → POST /internal/agent/:id/inbox
                    ↓
              agent.inbox[] (内存队列)
                    ↓
          有 pendingReceive？
            ├── 是 → 立即 resolve，返回消息
            └── 否 → 消息留在队列中等待下次 receive_message
```

核心机制：
1. **inbox 队列**: 每个 Agent 实例维护一个内存消息队列
2. **pendingReceive**: 当 Agent 调用 `receive_message(block=true)` 时，如果队列为空，创建一个 Promise 挂起
3. **消息到达**: 新消息推入 inbox，如果有 pendingReceive 就立即 resolve
4. **超时**: pendingReceive 有 59 秒超时，超时后返回空

### 3.3 Stdin 通知批量化

Slock 不是每条消息都通过 stdin 通知 Agent，而是：

```
新消息到达 → 3秒延迟去抖
              ↓
        批量 stdin 通知:
        "[System notification: You have N new messages waiting.
         Call receive_message to read them when you're ready.]"
```

- 使用 3 秒延迟进行去抖（debounce）
- 合并多条消息为一条通知
- 通知内容不包含消息正文，Agent 需要主动调用 `receive_message` 获取

### 3.4 Sleep/Wake 生命周期

```
Agent 空闲 → 无消息一段时间 → sleep()
              ↓
        保存 sessionId
        杀死 CLI 进程
        状态设为 sleeping
              ↓
新消息到达 → wake()
              ↓
        用 --resume <sessionId> 重启 CLI
        恢复上下文继续对话
```

---

## 4. 任务系统

### 4.1 状态流转（我们的实现）

```
open → claimed → in_progress → reviewing → completed
  ↑       |          |             |
  └───────┘          |             |
  (unclaim)          └─────────────┘
                      (reopen)
```

| 状态 | 含义 | 谁可以触发 |
|------|------|-----------|
| `open` | 新建，待认领 | 系统 |
| `claimed` | 已认领，尚未开始 | Agent / Human |
| `in_progress` | 正在执行 | Agent (update_task_status) |
| `reviewing` | 提交审核 | Agent (需已读所有文档) |
| `completed` | 审核通过 | Human only |

### 4.2 Task Documents

每个 Task 可以关联多个文档（Obsidian vault 中的 markdown 文件）：
- 文档状态: `writing` → `unread` → `read`
- Agent 提交 review 前，必须确保所有文档已被 reviewer 阅读
- 支持通过 `memory-note` 接口追加笔记

### 4.3 Todo Intake

一站式创建任务 + 文档：
1. 创建父任务 + 子任务
2. 在 Obsidian vault 中生成 index.md（含 Meta、Summary、Subtasks）
3. 自动关联 task_documents
4. 触发 `task:created` 事件

---

## 5. Trajectory 事件流

Agent 的 JSON 输出被解析为 trajectory 事件，实时推送给前端：

| 事件类型 | 触发时机 |
|---------|---------|
| `thinking` | Agent 正在推理 |
| `text` | Agent 输出文本 |
| `tool_call` | Agent 调用工具 |
| `tool_result` | 工具返回结果 |
| `turn_end` | 一轮对话结束 |

这些事件通过 WebSocket 推送，前端可以实时展示 Agent 的思考过程。

---

## 6. 关键设计决策总结

| 决策 | Slock 的选择 | 原因 |
|------|------------|------|
| Agent 运行时 | 包装 CLI 为常驻进程 | 复用成熟 CLI 的能力（MCP、权限、工具） |
| 消息投递 | Inbox 队列 + 阻塞 receive | Agent 主动拉取，避免打断当前任务 |
| 通知机制 | 3秒批量 stdin | 减少干扰，合并多条通知 |
| 上下文保持 | sleep/wake + resume | 节省资源，保持对话连续性 |
| 协作模型 | Claim-based task board | 简单有效，避免冲突 |
| 编排方式 | 消息总线（非状态图） | 灵活，不需要预定义工作流 |
