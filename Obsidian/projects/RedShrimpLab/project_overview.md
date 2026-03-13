# Red Shrimp Lab (红虾俱乐部)

## 项目定位
- **一句话定义**: 人类与 AI Agent 协作的 Slack-like 实时通信平台，支持多 LLM 模型切换与 Obsidian 知识库集成
- **解决什么问题**: 让人类与 AI Agent 在统一的频道中协同工作——对话、分配任务、生成文档、自动交接上下文
- **技术领域**: AI Infra / Agent Orchestration / Real-time Collaboration

## 技术架构

### 整体架构
```
┌──────────────────┐     WebSocket/HTTP     ┌──────────────────────────┐
│   React 19 SPA   │ ◄──────────────────► │  Fastify HTTP + Socket.io │
│  (Vite + Zustand) │                       │     (Node.js ESM)         │
└──────────────────┘                       ├──────────────────────────┤
                                            │   Daemon 子系统           │
                                            │  ┌─ Process Manager      │
                                            │  ├─ Scheduler (Cron)     │
                                            │  ├─ LLM Client (多模型)  │
                                            │  └─ Event Bus → Socket   │
                                            └────────┬─────────────────┘
                                                     │
                                    ┌────────────────┼────────────────┐
                                    │                │                │
                              ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
                              │ PostgreSQL │   │ Obsidian   │   │ Agent     │
                              │ 19 tables  │   │ ~/JwtVault │   │ 子进程    │
                              └───────────┘   └───────────┘   └───────────┘
```

### 核心模块划分
1. **认证层** — JWT (15min access + 30天 refresh) + bcrypt 密码哈希
2. **频道与消息** — 支持公共频道 + DM，per-channel 序列号保证有序
3. **Agent 管理** — 多 LLM 提供商（Claude/Kimi/OpenAI），子进程生命周期管理
4. **任务系统** — Kanban 工作流，per-channel 编号 (#t1, #t2)，原子认领
5. **Daemon 守护** — 进程管理 + 心跳监控 + Cron 调度 + Token 耗尽交接
6. **文档系统** — Obsidian vault 集成，writing/unread/read 状态追踪

### 数据流向
- 用户/Agent → HTTP API → PostgreSQL → Socket.io 广播 → 前端实时更新
- Agent 日志 → 三路输出（DB + Obsidian markdown + WebSocket）
- Token 耗尽 → 写 handoff 文件 → 重启新进程 → 读取上下文继续

## 技术栈

| 类别 | 技术 | 用途 |
|------|------|------|
| 后端框架 | Fastify 5 | HTTP 服务器，插件化架构 |
| 运行时 | Node.js 22 + tsx | TypeScript ESM 直接运行，无编译步骤 |
| 实时通信 | Socket.io 4 | WebSocket 双向事件推送 |
| 数据库 | PostgreSQL 16 | 19 表关系型存储，pgcrypto UUID |
| 认证 | @fastify/jwt + bcryptjs | JWT HS256 + 密码散列 |
| AI 接口 | @anthropic-ai/sdk, OpenAI SDK | 多模型统一抽象层 |
| 定时任务 | node-cron | Cron 调度 + 心跳检测 |
| 前端框架 | React 19 | SPA 单页应用 |
| 构建工具 | Vite 6 | 开发代理 + HMR + 生产构建 |
| 状态管理 | Zustand 5 | 轻量全局状态（auth store）|
| 样式 | Tailwind CSS 3 | 原子化 CSS，赛博朋克主题 |
| 部署 | systemd + Nginx | 裸机 Ubuntu，无容器化 |

## 关键指标

| 指标 | 数值 |
|------|------|
| 后端代码量 | 2,533 行 TypeScript |
| 前端代码量 | 2,071 行 TypeScript |
| 数据库表数 | 19 张 |
| API 端点数 | ~35 个 REST + 13 个 WebSocket 事件 |
| 文件总数 | 后端 16 个 + 前端 12 个源文件 |
| 设计文档 | 9 篇中文文档（PRD、API、架构等）|
| LLM 提供商 | 3 个（Anthropic / Moonshot / OpenAI）|

## 相关文档
- [[technical_breakdown]] — 技术深度解析
- [[engineering_value]] — 工程价值分析
- [[my_contribution]] — 个人贡献梳理
- [[resume_project]] — 简历项目描述
- [[interview_story]] — 面试故事线
