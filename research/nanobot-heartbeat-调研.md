# Nanobot 心跳系统调研

> 作者：Astra (PM)
> 日期：2026-03-12
> 目的：调研 nanobot 的 24 小时心跳监控能力，为红虾俱乐部 Agent 持续运行方案提供参考
> 参考：[HKUDS/nanobot](https://github.com/HKUDS/nanobot) · [DeepWiki 文档](https://deepwiki.com/HKUDS/nanobot)

---

## 1. Nanobot 概述

Nanobot 是一个轻量级 AI Agent 框架（~4,000 行 Python），核心特点：
- **Pub/Sub 消息总线** — 所有输入（用户消息、Cron 触发、心跳检查）统一为 InboundMessage
- **多平台接入** — 9+ 平台（Telegram、Discord、Slack 等）
- **17+ LLM Provider** — 通过 ProviderRegistry 抽象
- **Workspace 文件系统** — `MEMORY.md` / `HEARTBEAT.md` / `HISTORY.md` / `skills/`
- **持久会话** — 按 channel:chat_id 维度保存对话历史

Nanobot 的 Agent 是 **长期驻留型**（gateway 模式），不是一次性调用。它通过 `nanobot gateway` 启动，所有服务（消息处理、Cron、心跳）在同一个 asyncio 事件循环中并发运行。

---

## 2. 心跳系统架构

```
┌─────────────────────────────────────────────────────┐
│                  Gateway Runtime                     │
│                                                      │
│  ┌──────────────────┐    ┌──────────────────────┐   │
│  │  HeartbeatService │    │     CronService       │   │
│  │  (每 N 分钟 tick) │    │  (cron 表达式定时)   │   │
│  └────────┬─────────┘    └──────────┬───────────┘   │
│           │                         │               │
│           │ process_direct()        │ InboundMessage │
│           └──────────┬──────────────┘               │
│                      ▼                              │
│              ┌──────────────┐                       │
│              │  AgentLoop   │                       │
│              │ (LLM + 工具) │                       │
│              └──────┬───────┘                       │
│                     │                               │
│              OutboundMessage                        │
│                     ▼                               │
│              ChannelManager                         │
│              → 最近活跃频道                          │
└─────────────────────────────────────────────────────┘
```

**关键设计：**
- HeartbeatService 不走消息总线，直接调 `AgentLoop.process_direct()`
- CronService 走消息总线，发 InboundMessage
- 两者最终都收敛到 `_process_message()` — 同一套处理逻辑

---

## 3. HeartbeatService 核心实现

### 3.1 源码分析（`heartbeat/service.py`）

**初始化参数：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `workspace` | Path | — | Agent 工作目录 |
| `provider` | LLMProvider | — | 心跳用的 LLM provider |
| `model` | str | — | 心跳用的模型 ID |
| `on_execute` | Callback | None | 绑定到 `AgentLoop.process_direct()` |
| `on_notify` | Callback | None | 绑定到频道消息发送 |
| `interval_s` | int | 1800 | 心跳间隔（秒），默认 30 分钟 |
| `enabled` | bool | True | 是否启用 |

### 3.2 两阶段执行（v0.1.4 重新设计）

v0.1.4 版本做了重大改动：**用虚拟工具调用替代了 token 检测**，解决了空转时不必要的 LLM 调用问题。

```python
# Phase 1: 决策阶段 — LLM 判断是否有任务需要执行
_HEARTBEAT_TOOL = [{
    "type": "function",
    "function": {
        "name": "heartbeat",
        "description": "Report heartbeat decision after reviewing tasks.",
        "parameters": {
            "properties": {
                "action": {"enum": ["skip", "run"]},   # skip=无事, run=有活
                "tasks":  {"type": "string"},            # 任务摘要
            }
        }
    }
}]

async def _decide(self, content: str) -> tuple[str, str]:
    response = await self.provider.chat_with_retry(
        messages=[
            {"role": "system", "content": "You are a heartbeat agent..."},
            {"role": "user", "content": f"Review HEARTBEAT.md:\n\n{content}"},
        ],
        tools=_HEARTBEAT_TOOL,
        model=self.model,
    )
    args = response.tool_calls[0].arguments
    return args.get("action", "skip"), args.get("tasks", "")
```

```python
# Phase 2: 执行阶段 — 只在 action="run" 时调用 AgentLoop
async def _tick(self):
    content = self._read_heartbeat_file()  # 读 HEARTBEAT.md
    if not content: return

    action, tasks = await self._decide(content)  # Phase 1: LLM 判断

    if action != "run": return  # 无事可做，静默跳过

    response = await self.on_execute(tasks)  # Phase 2: 执行任务
    if response and self.on_notify:
        await self.on_notify(response)  # 结果发到频道
```

**这个设计的优点：**
1. 空转时只消耗一次轻量 LLM 调用（可用便宜模型）
2. 只有真正有任务时才调用完整 Agent 处理链
3. 避免了 v0.1.3 中的"心跳时 Agent 总是回复一堆废话"的问题

### 3.3 主循环

```python
async def _run_loop(self):
    while self._running:
        try:
            await asyncio.sleep(self.interval_s)  # 等待 N 分钟
            if self._running:
                await self._tick()                # 执行心跳
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error("Heartbeat error: {}", e)  # 错误不会终止服务
```

**关键行为：**
- `asyncio.sleep` 实现非阻塞等待
- 任何异常都被捕获并记录，**不会终止心跳服务**
- 支持 `trigger_now()` 手动触发

### 3.4 HEARTBEAT.md 格式

```markdown
# Alice 心跳任务

- [ ] 检查是否有未认领的开发任务，如有则认领并汇报
- [ ] 检查昨日开发日志是否已推送到 Obsidian
- [ ] 如果有待 Review 的 PR，提醒 @Jwt2077
- [x] ~~每日站会汇报（已完成）~~
```

- `- [ ]` 格式的未完成项会被执行
- `- [x]` 格式的已完成项会被跳过
- Agent 执行完后会自动将 `[ ]` 改为 `[x]`

---

## 4. CronService 核心实现

### 4.1 源码分析（`cron/service.py`）

CronService 比 HeartbeatService 更复杂，支持三种调度模式：

| 模式 | 配置 | 示例 |
|------|------|------|
| `at` | 一次性定时 | `{"kind": "at", "atMs": 1710288000000}` |
| `every` | 固定间隔 | `{"kind": "every", "everyMs": 300000}` (5分钟) |
| `cron` | Cron 表达式 | `{"kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Shanghai"}` |

### 4.2 任务存储（`jobs.json`）

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "abc12345",
      "name": "早间日报",
      "enabled": true,
      "schedule": {
        "kind": "cron",
        "expr": "0 9 * * 1-5",
        "tz": "Asia/Shanghai"
      },
      "payload": {
        "kind": "agent_turn",
        "message": "生成今日工作计划并发到 #all",
        "deliver": true,
        "channel": "#all"
      },
      "state": {
        "nextRunAtMs": 1710316800000,
        "lastRunAtMs": 1710230400000,
        "lastStatus": "ok",
        "lastError": null
      },
      "deleteAfterRun": false
    }
  ]
}
```

### 4.3 定时器机制

不使用 `setInterval` / `cron` 库轮询，而是**精确定时器**：

```python
def _arm_timer(self):
    next_wake = self._get_next_wake_ms()  # 找最近需要执行的任务
    delay_ms = max(0, next_wake - _now_ms())

    async def tick():
        await asyncio.sleep(delay_ms / 1000)  # 精确等到下次触发
        await self._on_timer()                 # 执行到期任务

    self._timer_task = asyncio.create_task(tick())
```

**优点：**
- 不需要每秒/每分钟轮询
- 只在任务需要执行时唤醒
- 任务变更（添加/删除）后重新 `_arm_timer()`

### 4.4 Agent 可自行管理 Cron

Agent 通过 `CronTool` 可以自己创建/删除/修改定时任务：

```
Agent: "我需要每天 9 点生成日报"
→ Agent 调用 CronTool.add_job("daily-report", "0 9 * * *", "生成日报")
→ CronService 注册任务
→ 每天 9 点自动触发
```

---

## 5. 24 小时持续运行的关键设计

### 5.1 为什么 nanobot 能 24 小时运行

1. **asyncio 事件循环** — 所有服务共享一个事件循环，非阻塞
2. **心跳决策降噪** — 没任务时只做一次轻量 LLM 调用（skip），不消耗大量 token
3. **异常不终止** — 所有 `_tick()` 异常被捕获记录，服务持续运行
4. **文件驱动** — HEARTBEAT.md 和 jobs.json 支持热更新，不需重启
5. **模型分层** — 心跳检查用便宜模型，实际执行用强模型

### 5.2 与我们的差距

| 能力 | Nanobot | 红虾俱乐部当前 | 差距 |
|------|---------|---------------|------|
| Agent 长驻 | asyncio gateway 模式 | spawn Claude Code CLI 子进程 | **架构差异大** |
| 心跳检查 | LLM 读 HEARTBEAT.md 判断 | 进程存活检查 (process.kill(0)) | 只检查存活，不检查任务 |
| 任务驱动心跳 | 有（读 checkbox 决定是否执行） | 无 | **缺失** |
| Cron 定时 | 三种模式 (at/every/cron) | 后端有 cron 表 + API，但无执行器 | **缺执行层** |
| 心跳模型分层 | 支持（配置 heartbeat_model） | DB schema 有字段，未接入 | **缺实现** |
| 自动恢复 | asyncio 异常捕获 + 重试 | processManager 指数退避重启 | 基本对等 |
| 结果投递 | 自动发到最近活跃频道 | 无 | **缺失** |
| Agent 自管理 Cron | CronTool（Agent 自己加/删任务） | 无 | **缺失** |

### 5.3 核心差距总结

**最大差距不在心跳本身，而在 Agent 运行模式：**

- Nanobot Agent 是**长驻服务**（asyncio 协程），可以接收心跳回调
- 我们的 Agent 是**临时进程**（spawn Claude Code CLI），用完就退出
- Claude Code CLI 不支持被外部回调，只能通过 stdin/stdout 交互

这意味着我们不能直接复制 nanobot 的 `process_direct()` 回调模式。

---

## 6. 适配方案：红虾俱乐部心跳系统

### 方案 A：进程级心跳 + 外部调度（推荐 MVP）

保持当前 Claude Code CLI spawn 模式，在后端 Scheduler 层实现心跳调度：

```
                    Backend Scheduler
                         │
           ┌─────────────┼──────────────┐
           │             │              │
    ┌──────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐
    │ Heartbeat   │ │  Cron    │ │  Health    │
    │ Checker     │ │  Runner  │ │  Monitor   │
    │(读HEARTBEAT │ │(cron表   │ │(进程存活   │
    │ .md判断)    │ │ 触发)    │ │ 心跳超时)  │
    └──────┬──────┘ └────┬─────┘ └─────┬──────┘
           │             │              │
           │  需要执行    │  到期        │  超时/崩溃
           │             │              │
           ▼             ▼              ▼
    Spawn Agent     Spawn Agent    Restart Agent
    (带心跳任务)    (带 prompt)    (指数退避)
```

**实现步骤：**

1. **HeartbeatChecker 类**
   ```typescript
   class HeartbeatChecker {
     // 每 N 分钟读取 agent 的 HEARTBEAT.md
     // 用便宜模型（Kimi）判断是否有未完成项
     // 有 → spawn Agent 执行任务
     // 无 → 静默跳过
   }
   ```

2. **CronRunner 类**
   ```typescript
   class CronRunner {
     // 读取 cron_jobs 表
     // 用 node-cron 或精确定时器
     // 到期 → spawn Agent（带 prompt 参数）
     // 执行结果 → 发到指定频道
   }
   ```

3. **HealthMonitor 类**（当前 ProcessManager 已有）
   ```typescript
   class HealthMonitor {
     // 每 60s 检查进程存活
     // 超时 90s → 标记 offline
     // 崩溃 → 指数退避重启
   }
   ```

**优点：** 不需要改 Agent 运行时，MVP 可行
**缺点：** 每次心跳触发都要 spawn 新进程，冷启动开销大

### 方案 B：Agent 长驻模式（Phase 2+）

把 Claude Code CLI 包装为长驻服务：

```
┌──────────────────────────────────────┐
│         Agent Gateway 进程           │
│                                      │
│  ┌────────────────┐                  │
│  │ Claude Code    │                  │
│  │ CLI (子进程)   │ ← stdin prompt  │
│  │                │ → stdout result  │
│  └────────────────┘                  │
│                                      │
│  ┌────────────────┐                  │
│  │ Heartbeat Loop │ ← HEARTBEAT.md  │
│  │ (30min间隔)    │                  │
│  └────────────────┘                  │
│                                      │
│  ┌────────────────┐                  │
│  │ WebSocket      │ ← 频道消息      │
│  │ Client         │ → Agent 回复    │
│  └────────────────┘                  │
└──────────────────────────────────────┘
```

**优点：** 真正的长驻 Agent，冷启动开销一次
**缺点：** 需要开发 Gateway 包装层，工作量大

### 方案 C：自研 Agent 运行时（Phase 3）

完全自研，不依赖 Claude Code CLI：

```typescript
class AgentRuntime {
  private llm: LLMClient
  private tools: ToolRegistry
  private memory: MemoryStore
  private heartbeat: HeartbeatService

  async processMessage(msg: string): Promise<string> { /* ... */ }
  async processHeartbeat(): Promise<void> { /* ... */ }
  async processCron(job: CronJob): Promise<void> { /* ... */ }
}
```

**优点：** 完全控制，最灵活
**缺点：** 开发量最大

---

## 7. MVP 心跳实现方案（方案 A 详细）

### 7.1 HeartbeatChecker 实现

```typescript
// backend-src/src/daemon/heartbeat-checker.ts

import { readFile } from 'fs/promises'
import { join } from 'path'
import { query } from '../db/client'
import { LLMClient } from './llm-client'
import { ProcessManager } from './process-manager'

interface HeartbeatConfig {
  checkIntervalMs: number    // 心跳检查间隔，默认 30 分钟
  decisionModel: string      // 决策用模型（便宜的）
  executionModel: string     // 执行用模型（强的）
}

export class HeartbeatChecker {
  private timer: NodeJS.Timeout | null = null
  private llm: LLMClient
  private processManager: ProcessManager

  constructor(
    private config: HeartbeatConfig,
    llm: LLMClient,
    processManager: ProcessManager,
  ) {
    this.llm = llm
    this.processManager = processManager
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.config.checkIntervalMs)
    console.log(`HeartbeatChecker started (every ${this.config.checkIntervalMs / 60000}min)`)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private async tick() {
    // 查询所有启用心跳的 Agent
    const agents = await query(`
      SELECT id, name, workspace_path, heartbeat_model_id, model_id,
             heartbeat_interval_minutes
      FROM agents
      WHERE status IN ('running', 'idle')
        AND workspace_path IS NOT NULL
    `)

    for (const agent of agents) {
      try {
        await this.checkAgent(agent)
      } catch (err) {
        console.error(`Heartbeat check failed for ${agent.name}:`, err)
      }
    }
  }

  private async checkAgent(agent: any) {
    // 1. 读取 HEARTBEAT.md
    const heartbeatPath = join(agent.workspace_path, 'HEARTBEAT.md')
    let content: string
    try {
      content = await readFile(heartbeatPath, 'utf-8')
    } catch {
      return // 文件不存在，跳过
    }

    // 2. 检查是否有未完成项
    if (!content.includes('- [ ]')) return

    // 3. 用便宜模型判断是否需要执行（参考 nanobot 的 _decide 模式）
    const decisionModel = agent.heartbeat_model_id || this.config.decisionModel
    const decision = await this.llm.chat(decisionModel, [
      { role: 'system', content: 'You are a heartbeat checker. Decide if there are tasks to execute.' },
      { role: 'user', content: `Review this HEARTBEAT.md and respond with JSON {"action":"skip"} or {"action":"run","tasks":"summary"}:\n\n${content}` },
    ])

    const parsed = JSON.parse(decision)
    if (parsed.action !== 'run') return

    // 4. 有任务 → Spawn Agent 执行
    console.log(`Heartbeat: ${agent.name} has tasks: ${parsed.tasks}`)
    // 注入心跳任务到 Agent prompt
    await this.processManager.spawnForHeartbeat(agent.id, parsed.tasks)
  }
}
```

### 7.2 Scheduler 服务入口

```typescript
// backend-src/src/daemon/scheduler-service.ts

import { HeartbeatChecker } from './heartbeat-checker'
import { CronRunner } from './cron-runner'
import { ProcessManager } from './process-manager'
import { LLMClient } from './llm-client'

export class SchedulerService {
  private heartbeat: HeartbeatChecker
  private cron: CronRunner

  constructor(processManager: ProcessManager, llm: LLMClient) {
    this.heartbeat = new HeartbeatChecker({
      checkIntervalMs: 30 * 60 * 1000,  // 30 分钟
      decisionModel: 'kimi-k1-8k',       // 便宜模型做判断
      executionModel: 'claude-sonnet-4-6', // 强模型做执行
    }, llm, processManager)

    this.cron = new CronRunner(processManager, llm)
  }

  async start() {
    this.heartbeat.start()
    await this.cron.start()
    console.log('SchedulerService started')
  }

  stop() {
    this.heartbeat.stop()
    this.cron.stop()
  }
}
```

### 7.3 前端心跳监控 UI

在 AgentsPage 的 agent 卡片中添加：

```
┌─────────────────────────────────┐
│ ◈ Alice         [running] ●    │
│ claude-sonnet-4-6               │
│ workspace: ~/JwtVault/agents/al │
│ last heartbeat: 14:32           │
│ heartbeat tasks: 2 pending      │
│ ┌─ context usage ──────── 35% ┐│
│ └──────────────────────────────┘│
│ [stop]   [view logs]  [config] │
└─────────────────────────────────┘
```

---

## 8. 我们后端已有的心跳基础设施

| 组件 | 文件 | 状态 | 说明 |
|------|------|------|------|
| ProcessManager 心跳超时 | `process-manager.ts` | ✅ 完成 | 90s 超时检测 + 自动重启 |
| Scheduler DB 心跳扫描 | `scheduler.ts` | ✅ 完成 | 每 60s 扫描 DB，标记 offline |
| Agent heartbeat API | `routes/agents.ts` | ✅ 完成 | `POST /agents/:id/heartbeat` |
| Machine heartbeat API | `routes/machines.ts` | ✅ 完成 | `POST /machines/:id/heartbeat` |
| Socket.IO 心跳 | `socket/index.ts` | ⚠️ 部分 | 只更新内存，不更新 DB |
| Token 耗尽监控 | `scheduler.ts` | ✅ 完成 | 检测 >90% token 使用 |
| HeartbeatChecker | — | ❌ 缺失 | 读 HEARTBEAT.md 判断任务 |
| CronRunner 执行层 | — | ❌ 缺失 | Cron 表有 API，但无实际执行 |
| 心跳模型分层 | DB schema | ⚠️ 部分 | 字段有，LLMClient 未接入 |
| 结果投递到频道 | — | ❌ 缺失 | 心跳结果不会发到频道 |

---

## 9. 实施建议

### Phase 1 优先级（立即可做）

1. **修复 Socket 心跳不更新 DB** — 5 分钟改动
2. **给 Agent heartbeat API 加鉴权** — 当前无验证，任何人可伪造
3. **HeartbeatChecker MVP** — 读 HEARTBEAT.md + 简单判断（先不用 LLM，直接检查 `- [ ]`）

### Phase 2 优先级

4. **LLM 决策层** — 用便宜模型判断心跳任务
5. **CronRunner 实际执行** — 连接 cron_jobs 表 → Spawn Agent
6. **结果投递** — 心跳/Cron 结果自动发到频道

### Phase 3 优先级

7. **Agent Gateway 模式** — 长驻 Agent + 回调
8. **Agent 自管理 Cron** — CronTool 让 Agent 自己创建定时任务
9. **自研 Agent 运行时** — 完全脱离 Claude Code CLI

---

## 10. 总结

Nanobot 的 24 小时心跳能力来自三个核心设计：

1. **Agent 长驻运行**（asyncio gateway）— 我们用子进程模式，需要适配
2. **两阶段心跳**（先决策 skip/run，再执行）— 节省 token，我们可以直接采用
3. **文件驱动 + 自管理**（HEARTBEAT.md + CronTool）— 简单实用，我们可以直接复制

**MVP 行动项：**
- 实现 HeartbeatChecker（方案 A）
- 复用现有 ProcessManager + Scheduler 基础设施
- 用 HEARTBEAT.md checkbox 格式（和 nanobot 一致）
- 心跳检查用便宜模型（Kimi），实际执行用强模型（Claude）

---

*参考资料：*
- [HKUDS/nanobot GitHub](https://github.com/HKUDS/nanobot)
- [DeepWiki: Heartbeat System](https://deepwiki.com/HKUDS/nanobot/7.2-heartbeat-system)
- [DeepWiki: Scheduled Tasks](https://deepwiki.com/HKUDS/nanobot/7-scheduled-and-periodic-tasks)
- [Nanobot v0.1.4 Release](https://github.com/HKUDS/nanobot/releases/tag/v0.1.4.post2) — 心跳系统重新设计
