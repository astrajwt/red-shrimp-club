# 项目总览

## 技术能力矩阵

| 技术方向 | 项目 | 熟练度 | 关键技术 |
|----------|------|--------|----------|
| 后端开发 | [[RedShrimpLab/project_overview\|Red Shrimp Lab]] | ★★★★☆ | Node.js, Fastify, TypeScript ESM, PostgreSQL, JWT |
| 实时通信 | [[RedShrimpLab/project_overview\|Red Shrimp Lab]] | ★★★★☆ | Socket.io, WebSocket, Event Bus, 13种事件类型 |
| AI Infra | [[RedShrimpLab/project_overview\|Red Shrimp Lab]] | ★★★★☆ | Multi-LLM (Claude/Kimi/OpenAI), Agent 进程管理, Token Handoff |
| 前端开发 | [[RedShrimpLab/project_overview\|Red Shrimp Lab]] | ★★★☆☆ | React 19, Zustand, Tailwind CSS, Vite |
| 数据库设计 | [[RedShrimpLab/project_overview\|Red Shrimp Lab]] | ★★★★☆ | PostgreSQL 19表, 原子操作, 复合索引, 纯SQL |
| DevOps | [[RedShrimpLab/project_overview\|Red Shrimp Lab]] | ★★★☆☆ | systemd, Nginx, 裸机部署, 自动备份 |
| 系统设计 | [[RedShrimpLab/project_overview\|Red Shrimp Lab]] | ★★★★☆ | Daemon/Process Manager, Scheduler, 三路日志, 崩溃恢复 |

## 简历速查

### Red Shrimp Lab（红虾俱乐部）

**一行版**:
> 设计并实现人类-AI Agent 实时协作平台，基于 Fastify + React 19 + PostgreSQL + Socket.io，支持 3 家 LLM 模型自动调度与 Token 耗尽无感交接

**三行版**:
- 独立全栈开发人类-AI 协作平台（~4,600 行 TypeScript），覆盖认证、频道、消息、任务、Agent 管理全链路
- 设计 Daemon 子系统：类 systemd 进程管理 + 心跳监控 + 多模型 LLM 统一接口（Anthropic/Moonshot/OpenAI）+ Token 耗尽自动交接
- 实现 19 张 PostgreSQL 表 + 35+ REST API + 13 种 WebSocket 实时事件 + 三路日志扇出（DB/Obsidian/WebSocket）

→ 详见 [[RedShrimpLab/resume_project]]

## 面试定位建议

### 目标岗位匹配度

| 岗位方向 | 匹配度 | 亮点切入 |
|----------|--------|----------|
| **Node.js 后端工程师** | ★★★★★ | Fastify 全栈、PostgreSQL 设计、JWT 认证、实时通信 |
| **AI 基础设施工程师** | ★★★★☆ | 多模型 LLM 集成、Agent 进程管理、Token 交接、Obsidian Memory |
| **全栈工程师** | ★★★★☆ | React 19 + Fastify + PostgreSQL + Socket.io 端到端 |
| **平台工程师 / DevOps** | ★★★☆☆ | Daemon 设计、systemd 部署、进程崩溃恢复、Cron 调度 |

### 技术叙事主线建议

**主线: "AI Agent 协作基础设施"**

> 我独立设计并实现了一个人类-AI Agent 协作平台。技术上最有深度的是 Daemon 子系统——我设计了类 systemd 的进程管理器来管理 AI Agent 的生命周期，包括心跳监控、崩溃自动恢复、以及 Token 耗尽时的无感交接。为了支持多家 LLM 提供商，我抽象了统一的 LLM Client 接口，内置限流退避。最独特的设计是将 Agent 的记忆存储从数据库迁移到 Obsidian Markdown 文件——这让人类可以直接阅读和编辑 AI 的工作状态，实现真正的人机透明协作。

**辅线（按场景选用）**:
1. **系统设计能力** → 聚焦 Daemon 架构、Event Bus、三路日志
2. **工程实践** → 聚焦技术选型理由（Fastify vs Express、无 Redis、无 ORM）
3. **产品思维** → 聚焦"文档中心"设计哲学、Obsidian 集成、赛博朋克 UX

## 项目文档索引

### Red Shrimp Lab
- [[RedShrimpLab/project_overview]] — 项目概览
- [[RedShrimpLab/technical_breakdown]] — 技术深度解析
- [[RedShrimpLab/engineering_value]] — 工程价值分析
- [[RedShrimpLab/my_contribution]] — 个人贡献梳理
- [[RedShrimpLab/resume_project]] — 简历项目描述
- [[RedShrimpLab/interview_story]] — 面试故事线
