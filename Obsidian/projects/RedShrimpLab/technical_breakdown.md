# Red Shrimp Lab — 技术深度解析

## 核心算法与实现

### 1. Daemon 进程管理（类 systemd 设计）

**文件**: `backend-src/src/daemon/process-manager.ts` (243行)

- 通过 `child_process.spawn()` 启动 Agent 子进程，每个 Agent 独立运行
- PID 追踪 + stdout/stderr 结构化日志解析（`[ISO-TIME] [LEVEL] message` 格式）
- 崩溃恢复策略：指数退避重启（3s → 6s → 12s → ... → 60s 上限），每小时最多 3 次
- 进程间通信通过环境变量注入（`SLOCK_HANDOFF_FILE` 传递上下文快照路径）

### 2. 多模型 LLM 统一抽象层

**文件**: `backend-src/src/daemon/llm-client.ts` (252行)

- **Provider 路由**: 按模型前缀自动选择 SDK
  - `claude-*` → Anthropic SDK（原生）
  - `moonshot-*` → OpenAI-compatible endpoint（Kimi）
  - `gpt-*`, `o1-*` → OpenAI SDK
- **429 限流处理**: 指数退避（3s base → 60s max），支持 `Retry-After` 响应头
- **Token 追踪**: 每次请求返回 `tokensUsed`，汇总到 `agent_runs` 表用于预算管理
- **超时控制**: 120s 全局超时，避免挂起

### 3. Token 耗尽自动交接（Handoff）

**关键路径**: Scheduler → Process Manager → MemoryWriter

```
Agent 运行中 → token 使用达 90% 阈值
  → Scheduler 检测到 (每2分钟轮询 agent_runs)
  → 写 handoff markdown: ~/JwtVault/agent-memory/{name}/handoff/{runId}.md
     内容包括: 已完成步骤、剩余任务、当前上下文摘要
  → 创建新 run 记录 (parent_run_id 链接前任)
  → Process Manager 停止旧进程 → 启动新进程
  → 新进程通过 SLOCK_HANDOFF_FILE 环境变量读取上下文
  → 继续未完成的工作
```

### 4. 三路日志系统

**文件**: `backend-src/src/daemon/logger.ts` (160行)

| 输出路径 | 格式 | 用途 |
|----------|------|------|
| PostgreSQL `agent_logs` | 结构化 JSON | 前端 Activity 页面查询 |
| Obsidian markdown | `- [LEVEL] message` | 人类审计 + Obsidian 双链 |
| WebSocket event | `agent:log` 事件 | 前端实时日志流 |

### 5. Per-Channel 原子序列号

**实现**: PostgreSQL `ON CONFLICT ... DO UPDATE` 原子递增

- `channel_sequences` 表存储每个频道的 `last_seq`
- `task_sequences` 表存储每个频道的任务编号 `last_num`
- 消息按 `(channel_id, seq DESC)` 索引，支持高效游标分页
- 任务按频道独立编号 (#t1, #t2)，避免全局锁争用

### 6. Socket.io 事件桥接

**文件**: `backend-src/src/socket/index.ts` (91行) + `daemon/events.ts` (119行)

- Daemon EventBus 使用通配符监听 `eventBus.on('*')`
- 所有 daemon 事件自动桥接到 Socket.io 广播
- 客户端订阅 13 种事件类型，覆盖 Agent 状态、日志、文档、任务、子代理

## 系统设计亮点

### 架构决策与权衡

| 决策 | 选择 | 权衡理由 |
|------|------|----------|
| 无 Redis | PostgreSQL only | 单机 MVP 减少运维复杂度，序列号用 PG 原子操作实现 |
| 无 Docker | systemd 直接部署 | 目标用户是个人/小团队，减少学习曲线 |
| 无 ORM | 原生 SQL (pg) | 19 张表结构明确，ORM 抽象收益不大 |
| Agent 日志用 Markdown | 非 JSON/DB | 人类可直接在 Obsidian 中阅读审计，双链互引 |
| JWT 无状态 + DB refresh | 非 Session | 15min 短 access 降低泄露风险，refresh 可主动失效 |
| 子进程 spawn 而非 Worker | child_process | Agent 需独立环境变量、独立崩溃隔离 |

### 可扩展性设计

- **LLM Provider 扩展**: 只需在 `llm-client.ts` 添加新的模型前缀路由
- **Agent 运行时扩展**: `runtime` 字段预留，当前仅 `claude`，未来可扩展
- **Sub-Agent 树**: `agent_runs.parent_run_id` 支持任意深度的父子关系
- **Skills 系统**: `skills` + `task_skills` 表预留，为 Agent 能力标签做准备

### 容错机制

- 心跳超时分级: <90s 正常, 90-180s 警告, >180s 离线 → 自动重启
- 进程崩溃自动恢复（带退避），每小时 3 次上限后进入 error 状态
- JWT refresh token 哈希存储，泄露后可服务端主动失效
- 任务认领原子操作（SQL `UPDATE ... WHERE claimed_by_id IS NULL`），防止并发冲突

## 前端架构亮点

### 赛博朋克设计系统

- **色彩体系**: 深紫黑底(#0e0c10) + 深红主色(#c0392b) + 青色辅助(#6bc5e8)
- **像素手绘感**: 3px 黑色粗边框 + 双色阴影（黑+青） + ±0.2° 微旋转
- **字体**: Share Tech Mono 等宽字体，全界面统一赛博朋克氛围
- **参考**: Notion 可读性 + VA-11 Hall-A 赛博朋克 + 文档中心设计

### 前端状态管理

- 单一 Zustand store (auth)，页面级 useState 管理局部状态
- Socket.io 事件驱动更新，无 Redux middleware
- API client 自动 401 refresh，去重并发刷新请求
- 自定义 Markdown 渲染器（无外部依赖），正则解析 headings/code/quotes/lists

## 相关文档
- [[project_overview]] — 项目概览
- [[engineering_value]] — 工程价值分析
