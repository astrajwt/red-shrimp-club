# Red Shrimp Lab — 我的贡献

## 核心贡献

### 独立设计并实现全栈系统
- **独立完成**全部架构设计、数据库建模、前后端开发
- 从零到一搭建了完整的 AI Agent 协作平台，包含 35+ REST API 端点 + 13 种 WebSocket 事件
- 设计并实现 19 张 PostgreSQL 表，覆盖用户、频道、消息、Agent、任务、文档、Cron 全链路

### Daemon 子系统设计
- 独立设计类 systemd 的 Agent 进程管理器，支持 spawn/stop/restart + 心跳监控 + 崩溃恢复
- 实现多模型 LLM 统一抽象层（Anthropic/Moonshot/OpenAI），含 429 限流退避
- 设计 Token 耗尽自动交接机制，通过 Markdown 文件传递上下文

### Agent Memory 架构迁移
- 将 Agent 记忆从数据库 JSONB 迁移到 Obsidian Markdown 文件系统
- 设计 `agent-memory/{agentName}/` 目录结构（MEMORY.md + handoff/ + logs/）
- 使人类可直接在 Obsidian 中审查和编辑 Agent 工作状态

### 赛博朋克 UI 设计系统
- 定义完整的视觉规范：深紫黑底 + 深红主色 + 青色辅助 + 3px 粗边框像素风
- 参考 Notion 可读性 + VA-11 Hall-A 赛博朋克美学
- 实现 6 个页面组件 + 自定义 Markdown 渲染器

## 技术决策

| 决策点 | 选择方案 | 决策理由 |
|--------|---------|---------|
| 框架选型 | Fastify (非 Express) | 更快的性能、原生 TypeScript 支持、插件化架构 |
| 状态管理 | Zustand (非 Redux) | MVP 阶段复杂度低、API 简洁、bundle 更小 |
| Agent 进程模型 | child_process (非 Worker) | 独立环境变量、独立崩溃隔离、更接近真实系统设计 |
| 日志存储 | Markdown 文件 (非纯 DB) | 人类可读可编辑、Obsidian 双链互引、去中心化 |
| 部署方式 | 裸机 systemd (非 Docker) | 目标场景是个人/小团队，减少运维成本 |
| 数据库 | 纯 SQL (非 ORM) | 表结构稳定，直接 SQL 更透明，性能更优 |

## 量化成果

| 维度 | 数据 |
|------|------|
| 代码规模 | ~4,600 行 TypeScript（前后端合计） |
| 数据库设计 | 19 张表 + 多个复合索引 |
| API 覆盖 | 35+ REST 端点 + 13 WebSocket 事件 |
| LLM 集成 | 3 家提供商统一接口 |
| 文档产出 | 9 篇技术设计文档（中文） |
| 开发周期 | Phase 1 核心功能从设计到实现 |
| 架构决策 | 6 项关键技术选型（均有书面理由） |

## 相关文档
- [[project_overview]] — 项目概览
- [[resume_project]] — 简历项目描述
- [[interview_story]] — 面试故事线
