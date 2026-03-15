# 红虾俱乐部 — Daemon 架构设计

> **版本**: v0.1
> **作者**: Astra (PM)
> **日期**: 2026-03-12

---

## 1. 概述

Daemon 是常驻后台进程，负责管理所有 Agent 的生命周期。
类比：操作系统的 init/systemd，管理所有服务进程的启停和健康。

---

## 2. 架构

```
┌────────────────────────────────────────────┐
│              Daemon (主进程)                 │
│                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ 进程管理  │  │ 心跳监控  │  │ 调度器   │ │
│  │ Manager  │  │ Monitor  │  │ Scheduler│ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │              │       │
│  ┌────▼──────────────▼──────────────▼────┐ │
│  │          事件总线 (Event Bus)           │ │
│  └────┬──────────────┬──────────────┬────┘ │
│       │              │              │       │
│  ┌────▼────┐   ┌─────▼────┐  ┌─────▼────┐ │
│  │ Agent A │   │ Agent B  │  │ Agent C  │ │
│  │(Claude) │   │ (Kimi)   │  │ (Codex)  │ │
│  └─────────┘   └──────────┘  └──────────┘ │
└────────────────────────────────────────────┘
```

Daemon 与 API Server 分离，通过 Unix Socket 通信。

---

## 3. 进程管理器 (Process Manager)

### 3.1 启动 Agent

```
用户点 Start → API Server → Daemon

Daemon 执行：
1. 从数据库读取 Agent 配置（model, workspace, env）
2. child_process.spawn('claude', ['--agent', ...], {
     cwd: agentWorkspacePath,
     env: { AGENT_ID, SERVER_URL, AUTH_TOKEN, ... }
   })
3. 记录 PID 到内存 Map + 数据库
4. 监听子进程 stdout/stderr → 写入 agent_logs
5. 监听子进程 'exit' 事件 → 触发崩溃恢复
6. 状态改为 running，WebSocket 广播 agent:activity
```

### 3.2 停止 Agent

```
用户点 Stop → API Server → Daemon

Daemon 执行：
1. 发送 SIGTERM 给子进程
2. 启动 5s 超时计时器
3. 子进程正常退出 → 清理完成
4. 5s 超时 → 发送 SIGKILL 强制终止
5. 状态改为 stopped
```

### 3.3 崩溃恢复

```
子进程异常退出（exit code ≠ 0）→ 'exit' 事件触发

Daemon 执行：
1. 记录崩溃日志（exit code, signal, 时间）
2. 检查重启次数：同一小时内 ≤ 3 次？
   ├─ 是 → 等待 3s → 自动重启
   └─ 否 → 状态改为 error
          → 在频道通知用户："Agent X 多次崩溃，已暂停"
```

---

## 4. 心跳监控 (Health Monitor)

### 4.1 Agent 端上报

```
Agent 每 30s 上报心跳：
POST /agents/:id/heartbeat
Body: {
  pid: number,
  status: 'idle' | 'working' | 'thinking',
  tokenUsage: { prompt: number, completion: number },
  memoryMB: number,
  uptime: number
}
```

### 4.2 Daemon 端巡检

```
每 60s 扫描一次所有运行中的 Agent：

foreach agent in runningAgents:
  timeSinceLastHeartbeat = now - agent.lastHeartbeat

  if timeSinceLastHeartbeat < 90s:
    → 正常，无操作

  elif timeSinceLastHeartbeat < 180s:
    → 标记 warning
    → 尝试 kill(pid, 0) 检查进程是否存活

  else (> 180s):
    → 标记 offline
    → 检查进程：
      ├─ 进程存在但无心跳 → 可能卡死 → SIGKILL + 重启
      └─ 进程不存在 → 已崩溃 → 按崩溃恢复处理
```

---

## 5. 调度器 (Scheduler)

### 5.1 心跳巡检
- 间隔：60s
- 动作：扫描所有 Agent 心跳状态

### 5.2 Token 监控
- 间隔：5 min
- 动作：汇总 token 用量，超 90% 触发转派

### 5.3 Cron 定时任务
- 引擎：node-cron
- 存储：数据库 cron_jobs 表
- 触发方式：到点时往指定频道发送消息，走标准消息处理管线
- 例："每天 09:00 让 PM Agent 发进度汇报"

### 5.4 Obsidian 自动同步
- 间隔：5 min
- 动作：`cd ~/JwtVault && git add -A && git commit -m "auto sync" && git push`

---

## 6. API 限流与错误处理

### 6.1 LLM API 429 (Rate Limit)

```
Agent 调用 LLM API → 收到 429

处理流程：
1. 读取 Retry-After header（秒数）
2. 如果没有 header → 用指数退避：3s → 6s → 12s → 24s → 60s
3. 重试最多 5 次
4. 仍然失败：
   → Agent 状态改为 rate_limited
   → 在频道通知："Agent X 暂停：API 限制，将在 N 分钟后恢复"
   → 设置定时器，到期后自动恢复
5. 前端显示清晰错误信息（非空白页面）
```

### 6.2 LLM API 500/502/503

```
同样指数退避重试，重试 3 次后暂停 Agent。
```

### 6.3 关键原则

- **一个 API 错误不能杀死整个 Agent**
- **用户永远能看到发生了什么**（错误信息 + 恢复时间）
- **自动恢复优先**，只在无法恢复时才需要人工介入

---

## 7. Daemon 自身可靠性

### 7.1 systemd 托管

```ini
# /etc/systemd/system/redshrimp-daemon.service
[Unit]
Description=Red Shrimp Lab Agent Daemon
After=network.target postgresql.service

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/redshrimp/daemon/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
WorkingDirectory=/opt/redshrimp

[Install]
WantedBy=multi-user.target
```

### 7.2 启动恢复

```
Daemon 启动时：
1. 读取数据库中 status = 'running' 的 Agent 列表
2. 检查对应 PID 是否存活
   ├─ 存活 → 重新挂载监听（stdout/stderr/exit）
   └─ 不存活 → 重新 spawn
3. 恢复所有 Cron 定时任务
4. 启动心跳巡检循环
```

### 7.3 优雅关闭

```
收到 SIGTERM（systemd stop）：
1. 停止接受新的 Agent 启动请求
2. 向所有子进程发 SIGTERM
3. 等待所有子进程退出（最多 30s）
4. 超时的强制 SIGKILL
5. 保存所有 Agent 状态到数据库
6. 退出
```

---

## 8. Daemon ↔ API Server 通信

```
通信方式：Unix Domain Socket (/var/run/redshrimp.sock)

API Server → Daemon 的命令：
  { action: 'start', agentId: '...' }
  { action: 'stop', agentId: '...' }
  { action: 'status', agentId: '...' }
  { action: 'list' }

Daemon → API Server 的事件（通过 Socket 推送）：
  { event: 'agent:started', agentId, pid }
  { event: 'agent:stopped', agentId, exitCode }
  { event: 'agent:crashed', agentId, error }
  { event: 'agent:heartbeat', agentId, data }
  { event: 'agent:rate_limited', agentId, retryAfter }
```

---

## 变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-03-12 | v0.1 | 初始版本 |
