# Red Shrimp Lab — 简历版本

## 一行版（适用于技能列表）

> **设计并实现** 人类-AI Agent 实时协作平台，基于 Fastify + React 19 + PostgreSQL + Socket.io，支持 3 家 LLM 模型自动调度与 Token 耗尽无感交接

## 三行版（适用于项目经历）

- **项目角色**: 独立全栈开发——从产品设计、数据库建模到前后端实现及部署方案
- **核心技术**: 设计 Daemon 子系统管理 AI Agent 生命周期（进程 spawn/心跳监控/崩溃恢复），实现多模型 LLM 统一抽象层（Anthropic/Moonshot/OpenAI）及 Token 耗尽自动交接
- **量化成果**: ~4,600 行 TypeScript 全栈代码，19 张 PostgreSQL 表，35+ REST API + 13 种 WebSocket 事件，3 家 LLM 提供商统一对接

## 完整版（适用于详细描述）

### 项目背景
人类与 AI Agent 协作的 Slack-like 实时通信平台（Slock.ai 克隆），AI Agent 以子进程形式在服务端运行，通过频道与人类对话、认领任务、生成 Obsidian 文档。目标是实现人机无缝协同工作流。

### 技术方案
- **后端**: Node.js + Fastify 5 + TypeScript ESM，Socket.io 实时通信，PostgreSQL 19 表关系型存储
- **Daemon 子系统**: 类 systemd 设计——Process Manager 管理 Agent 子进程生命周期（spawn/stop/restart），Scheduler 执行 Cron 任务 + 心跳监控（90s 超时检测），LLM Client 统一多模型接口（支持 429 指数退避）
- **前端**: React 19 + Vite 6 + Zustand + Tailwind CSS，赛博朋克视觉设计（Notion × VA-11 Hall-A），Socket.io 13 种事件实时更新
- **Agent Memory**: 从数据库 JSONB 迁移到 Obsidian Markdown 文件，通过 handoff 文件实现 Token 耗尽无感交接

### 个人贡献
- 独立完成全栈架构设计与开发（~4,600 行 TypeScript）
- 设计 19 张数据库表 + 多个复合索引，原子序列号保证并发安全
- 实现三路日志扇出（DB + Obsidian + WebSocket），Agent 状态对人类透明
- 编写 9 篇中文技术设计文档（PRD、API、Daemon 架构等）

### 成果与影响
- 完整的人机协作 MVP，覆盖认证、频道、消息、任务、Agent 管理全链路
- Daemon 子系统支持 Agent 自动崩溃恢复（指数退避，每小时 3 次上限）
- Token 交接机制使长任务不中断，交接上下文以 Markdown 形式人类可审

## 关键词云

```
Node.js, TypeScript, Fastify, React 19, PostgreSQL, Socket.io, WebSocket,
Zustand, Tailwind CSS, Vite, JWT, LLM, AI Agent, Claude, OpenAI,
Process Management, Daemon, Scheduler, Cron, Heartbeat, Token Handoff,
Obsidian, Markdown, Real-time, REST API, ESM, systemd, Nginx,
Event-Driven Architecture, Child Process, Rate Limiting, Exponential Backoff
```

## 相关文档
- [[project_overview]] — 项目概览
- [[my_contribution]] — 个人贡献详情
- [[interview_story]] — 面试故事线
