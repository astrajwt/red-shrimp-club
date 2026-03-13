# Red Shrimp Lab — 工程价值

## 技术难点

### Top 1: Agent 生命周期与 Token 交接

**挑战**: AI Agent 长时间运行时 token 会耗尽，需要"无感"交接给新进程，保持任务连续性

**解决方案**:
- Scheduler 每 2 分钟轮询 `agent_runs` 表，检测 token 用量 >90%
- 将当前 Agent 的工作状态序列化为 markdown handoff 文件
- 通过 `parent_run_id` 构建 run 链条，新进程读取 handoff 继续工作
- handoff 文件存储在 Obsidian vault 中，人类可随时审查交接质量

**技术亮点**: 将 Agent 上下文从 JSONB (数据库) 迁移到 Markdown (文件系统)，使交接状态对人类透明可编辑

### Top 2: 多模型 LLM 统一接口 + 限流容错

**挑战**: 同时对接 3 家 LLM 提供商（Anthropic/Moonshot/OpenAI），API 格式不同，限流策略各异

**解决方案**:
- 统一 `CompletionRequest/Response` 接口，按模型前缀路由到对应 SDK
- 指数退避重试（3s→6s→...→60s），解析 `Retry-After` 响应头
- 每次请求返回标准化的 `tokensUsed` 用于预算追踪
- API Key 以环境变量引用名存储在 DB（`key_env_ref`），运行时读取 env

### Top 3: 实时事件的三路扇出

**挑战**: Agent 日志需要同时持久化到 DB、同步到 Obsidian 文件、推送到前端

**解决方案**:
- EventBus 中心化事件总线，支持通配符监听
- `ObsidianLogWriter` 按日期切分 markdown 日志文件
- Socket.io 桥接 daemon 事件到客户端，13 种事件类型全覆盖
- 解耦架构：日志生产者只发事件，不关心消费端

## 性能指标

| 指标 | 数据 |
|------|------|
| 后端启动时间 | <2s（tsx 直接运行，无编译） |
| API 响应时间 | <50ms（Fastify + 直接 SQL，无 ORM 开销） |
| WebSocket 延迟 | <100ms（单机 Socket.io，无 Redis adapter） |
| Agent 重启耗时 | 3-60s（指数退避） |
| Token 监控频率 | 每 2 分钟（scheduler 轮询） |
| 心跳检测间隔 | 60s（90s 超时 → 告警，180s → 离线） |
| 代码总量 | ~4,600 行 TypeScript（前后端合计） |

## 工程实践

### 开发流程
- **ESM 原生**: 全栈 TypeScript ESM，import 使用 `.js` 扩展名约定
- **tsx 热运行**: 开发时用 tsx 直接运行 .ts，无需编译步骤
- **Vite 代理**: 前端 dev server 代理 `/api`、`/uploads`、`/socket.io` 到后端

### 数据库管理
- 纯 SQL schema（`schema.sql` 265 行），无 ORM migration
- pgcrypto `gen_random_uuid()` 全表使用 UUID 主键
- 原子操作保证序列号和任务认领的并发安全

### 安全实践
- JWT 短期 access token (15min) + 长期 refresh token (30天)
- refresh token 哈希存储，支持服务端撤销
- LLM API Key 以 env 引用名存储，不暴露原始密钥
- 文件上传大小限制（图片 10MB / PDF 50MB）
- bcrypt 12 轮盐值密码哈希

### 部署方案
- systemd 管理后端 + daemon 进程
- Nginx 反向代理（80/443 → 3001）
- 一键部署脚本 `deploy.sh`
- 每日 PostgreSQL 备份 + 7 天保留

## 可复用组件

### 1. LLM Client 统一抽象
- 模式: Provider 路由 + 指数退避 + Token 追踪
- 可直接复用于任何多模型 LLM 应用

### 2. Daemon 进程管理器
- 模式: spawn + PID 追踪 + 心跳 + 崩溃恢复
- 类似 PM2/systemd 的轻量实现

### 3. JWT 认证中间件
- 模式: Fastify decorator + auto refresh + 双 token 旋转
- 适用于任何 Fastify 项目

### 4. 三路日志系统
- 模式: EventBus + 多消费者（DB/文件/WebSocket）
- 可扩展为通用日志扇出框架

### 5. Socket.io 类型化事件客户端
- 模式: SocketManager 类 + 事件订阅/退订 + 自动重连
- 完整 TypeScript 类型定义，13 种事件接口

## 相关文档
- [[project_overview]] — 项目概览
- [[technical_breakdown]] — 技术深度解析
- [[my_contribution]] — 个人贡献梳理
