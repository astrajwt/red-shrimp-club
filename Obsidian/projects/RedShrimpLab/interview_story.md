# Red Shrimp Lab — 面试故事线

## STAR 故事

### Situation（背景）
希望构建一个人类与 AI Agent 协同工作的平台——类似 Slack 的实时频道，但 AI Agent 可以像团队成员一样参与对话、认领任务、生成文档。市面上的 AI 工具多为单轮对话，缺少真正的"协作"体验。

### Task（任务）
独立设计并实现完整的 MVP，包括：
- 后端 API 服务 + 实时 WebSocket 通信
- Daemon 子系统管理多个 AI Agent 的生命周期
- 支持多家 LLM 提供商（Claude / Kimi / OpenAI）无缝切换
- 前端赛博朋克风格的协作界面
- Agent 运行状态对人类完全透明（通过 Obsidian 知识库）

### Action（行动）
1. **架构设计**: 选择 Fastify + PostgreSQL 单机架构，避免过度工程化；设计 19 张数据库表覆盖全业务
2. **Daemon 子系统**: 实现类 systemd 的进程管理器——Agent 作为子进程独立运行，心跳监控 + 崩溃自动恢复 + Token 耗尽交接
3. **LLM 抽象层**: 设计 Provider 路由模式，按模型前缀自动选择 SDK，统一请求/响应格式，内置 429 限流退避
4. **Agent Memory 迁移**: 将 Agent 上下文从 DB JSONB 迁移到 Obsidian Markdown，使交接状态人类可读可编辑
5. **前端实现**: React 19 + Socket.io 13 种事件实时更新，Zustand 轻量状态管理，自定义 Markdown 渲染

### Result（结果）
- ~4,600 行 TypeScript 全栈代码，35+ API 端点 + 13 种实时事件
- Daemon 支持 Agent 自动恢复（指数退避）和 Token 无感交接
- 三路日志扇出让 Agent 行为完全透明
- 完整中文技术文档体系（9 篇设计文档）

---

## 预期追问与应答

| 可能的面试问题 | 答案要点 |
|----------------|----------|
| **为什么选 Fastify 而不是 Express？** | Fastify 性能更优（基于 Pino 日志+find-my-way 路由），原生 TypeScript 支持好，插件系统更规范。Express 在中间件链上有性能开销，且 TypeScript 装饰器支持弱 |
| **为什么不用 Redis？** | 单机 MVP 阶段，PostgreSQL 的原子操作（`ON CONFLICT DO UPDATE`）足以处理序列号和任务认领的并发需求，减少运维依赖。如果需要水平扩展，Socket.io Redis adapter 可以后续引入 |
| **Token 交接的可靠性怎么保证？** | 1) Scheduler 每 2 分钟轮询，不依赖 Agent 主动上报；2) handoff 文件是持久化 Markdown，重启不丢失；3) parent_run_id 构成链条，可追溯完整交接历史；4) 人类可在 Obsidian 中审查和修改交接内容 |
| **Agent 崩溃恢复策略是什么？** | 指数退避重启（3s→6s→12s→...→60s），每小时最多 3 次。超限后进入 error 状态停止重启，需人工介入。心跳超时分三级：<90s 正常, 90-180s 警告, >180s 离线 |
| **如何处理 LLM API 的限流（429）？** | 指数退避：base 3s, max 60s, 最多 6 次重试。优先读取 `Retry-After` 响应头。不同 Provider 的 429 响应格式不同，统一在 LLM Client 层处理 |
| **为什么用 Markdown 而不是 JSON 存 Agent 状态？** | 1) 人类可直接在 Obsidian 中阅读和编辑；2) 支持 Obsidian 双链互引；3) Git 版本控制友好（diff 可读）；4) 去除对数据库的依赖，Agent 状态可离线查看 |
| **Socket.io vs 原生 WebSocket？** | Socket.io 提供：自动重连（指数退避）、房间机制（`channel:{id}`）、ACK 确认、二进制支持、Transport 降级。原生 WS 需要自己实现这些，MVP 阶段不值得 |
| **前端为什么只用一个 Zustand store？** | MVP 阶段只有 auth 是全局状态，消息/任务/Agent 列表都是页面级数据，用 `useState` 配合 `useEffect` 获取即可。避免过早引入复杂状态管理增加维护成本 |
| **数据库为什么用原生 SQL 不用 ORM？** | 19 张表结构稳定明确，不需要 ORM 的动态 schema 映射。直接 SQL 更透明可控，性能更好（无额外查询生成层），且团队只有一人，ORM 的团队协作优势不适用 |
| **如何保证任务认领不冲突？** | SQL 原子操作：`UPDATE tasks SET claimed_by_id = $1 WHERE id = $2 AND claimed_by_id IS NULL RETURNING *`。如果返回空结果，说明已被其他人/Agent 认领，前端返回 409 Conflict |

---

## 技术深度展示点

### 1. Daemon 进程管理的设计权衡
- 可以深入讨论为什么选子进程而非 Worker Thread（环境隔离 vs 通信开销）
- 心跳超时的三级策略设计思路（参考 Kubernetes Pod Ready/Liveness Probe）
- 崩溃恢复的上限设计（为什么是每小时 3 次，参考 systemd RestartSec/StartLimitBurst）

### 2. 多模型 LLM 集成的工程实践
- Provider 路由模式（类似 Strategy Pattern）的可扩展性
- 不同 Provider API 差异的适配经验（Claude 的 system prompt vs OpenAI 的 messages 结构）
- 限流退避的实际调优经验（Moonshot/Kimi 限流更激进）

### 3. Agent Memory 从 DB 到 Markdown 的迁移决策
- 展示对"AI Agent 可观测性"的思考
- Markdown vs JSONB 在不同场景下的优劣分析
- Obsidian 双链如何帮助人类快速定位 Agent 工作上下文

### 4. 赛博朋克设计系统的技术实现
- 如何用纯 Tailwind CSS 实现像素手绘感（3px 边框 + 双色阴影 + 微旋转）
- Share Tech Mono 等宽字体的选择理由（赛博朋克氛围 + 代码可读性）
- 自定义 Markdown 渲染器的正则实现（无外部依赖，bundle 更小）

## 相关文档
- [[project_overview]] — 项目概览
- [[resume_project]] — 简历项目描述
- [[my_contribution]] — 个人贡献梳理
