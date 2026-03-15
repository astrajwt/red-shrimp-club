# Slock MCP 逻辑说明

> 参考实现来源：
> - `/home/jwt/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/dist/index.js`
> - `/home/jwt/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/dist/chat-bridge.js`
>
> 目的：把 `slock` 中 agent 使用 MCP 的核心运行逻辑整理成可执行的对齐文档，供 `slock-clone` 后续实现直接参照。

---

## 1. 总体结论

`slock` 的 MCP 逻辑不是“给 CLI 挂一个 chat tool”这么简单，而是一套完整的运行时协议：

1. 每种 runtime 有独立 driver。
2. MCP 注入方式按 runtime 区分，不强行统一。
3. agent 退出 `code=0` 时默认进入 `sleeping`，不是无脑重启。
4. 有新消息时再根据 `sessionId` 唤醒并 `resume`。
5. 只有支持 stdin 通知的 runtime 才走“系统通知 + 批量唤醒”。

换句话说，`slock` 复刻的是“会话型 agent runtime”，不是“一次请求启动一次 CLI”。

---

## 2. Claude 在 slock 里的 MCP 逻辑

### 2.1 启动方式

`slock` 的 `ClaudeDriver` 不是用 `-p` 直接塞 prompt，而是：

1. 用 `--mcp-config <json>` 注入 chat MCP。
2. 用 `--output-format stream-json --input-format stream-json` 进入流式 JSON 模式。
3. 通过 `stdin` 写入第一条 user message 作为启动 prompt。
4. 有 `sessionId` 时使用 `--resume <sessionId>` 恢复。

等价逻辑：

```bash
claude \
  --allow-dangerously-skip-permissions \
  --dangerously-skip-permissions \
  --verbose \
  --output-format stream-json \
  --input-format stream-json \
  --mcp-config '<json>' \
  --model <model>
```

首条 prompt 不是 `-p`，而是写入：

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "<prompt>" }]
  }
}
```

### 2.2 Claude 的关键语义

- Claude 在 slock 中是“支持 stdin 通知”的 runtime。
- `session_id` 从 stream-json 输出里解析并保存。
- agent 忙时，daemon 可以继续往 Claude 的 stdin 写系统通知。

这意味着 Claude 在 slock 里本质上是“会话型长连接代理”，而不是简单的一次性 prompt CLI。

---

## 3. Codex 在 slock 里的 MCP 逻辑

### 3.1 启动方式

Codex 不使用 `--mcp-config`，而是用 `-c` 注入 MCP server 配置：

```bash
codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  --json \
  -c mcp_servers.chat.command="node|npx" \
  -c mcp_servers.chat.args=[...] \
  -c mcp_servers.chat.startup_timeout_sec=30 \
  -c mcp_servers.chat.tool_timeout_sec=120 \
  -c mcp_servers.chat.enabled=true \
  -c mcp_servers.chat.required=true \
  -m <model> \
  -c model_reasoning_effort=<effort> \
  "<prompt>"
```

### 3.2 Codex 的关键语义

- Codex 的 MCP 工具前缀是 `mcp_chat_`，不是 `mcp__chat__`。
- Codex 不支持 stdin notification。
- Codex 用 `resume <sessionId>` 恢复线程。
- `slock` 在启动 Codex 前会确保工作目录是 git repo。

---

## 4. Kimi 在 slock 里的 MCP 逻辑

### 4.1 参考实现现状

`slock` 运行时声明里：

- `claude`：`supported: true`
- `codex`：`supported: true`
- `kimi`：`supported: false`

也就是说，`slock` 官方运行时并没有把 Kimi 当成稳定可用的 MCP 常驻 agent。

### 4.2 结论

如果要“和 slock 一样”，Kimi 不应该被当成和 Claude/Codex 同等级的稳定常驻 runtime。

更准确的做法是：

- UI 层标注为实验性/不稳定。
- 不把它作为标准常驻 agent 的默认路径。
- 如果一定要支持，应该走单独 wrapper，不要污染 Claude/Codex 主逻辑。

---

## 5. Chat Bridge 在 slock 里的职责

`chat-bridge.js` 本质上是一个 MCP server，向 agent 暴露这些 tool：

- `send_message`
- `receive_message`
- `list_server`
- `read_history`
- `list_tasks`
- `create_tasks`
- `claim_tasks`
- `unclaim_task`
- `update_task_status`

其中最关键的是 `receive_message`：

- `block=true` 时调用后端内部 `/internal/agent/:id/receive`
- 后端做长轮询并返回未读消息
- 返回格式已经是 agent 可直接理解的文本

因此，slock 的“消息等待”核心不在 CLI 本身，而在：

1. MCP tool 暴露一致接口
2. 后端负责 unread/read position
3. daemon 负责进程生命周期和通知策略

---

## 6. Sleep / Wake 语义

这是 slock 和当前 clone 最大的一个差异点。

### 6.1 slock 的行为

agent 进程退出 `code=0` 时：

- 不视为 crash
- 不立刻重启
- 标记为 `sleeping`
- 保留 `sessionId`

等下一条消息到来时：

- daemon 检测 agent 为 sleeping
- 用已有 `sessionId` 重新启动
- runtime 通过 `resume` 恢复上下文

### 6.2 这套设计的意义

- 减少空转重启
- 避免 agent 无消息时反复自旋
- 保留上下文连续性
- 让“长驻”体感来自会话恢复，而不是硬循环

---

## 7. Stdin 通知语义

`slock` 不是所有 runtime 都支持通知。

### 7.1 Claude

Claude driver 支持 `stdin` 系统通知。

agent 忙时，如果来了新消息：

1. `pendingNotificationCount++`
2. 进入 3 秒批量窗口
3. daemon 通过 stdin 发送：

```text
[System notification: You have N new message(s) waiting. Call receive_message to read them when you're ready.]
```

### 7.2 Codex

Codex driver `supportsStdinNotification = false`。

因此不要把 Claude 的 stdin 通知策略强行套到 Codex。

---

## 8. 当前 slock-clone 对齐清单

按 slock 参考实现，`slock-clone` 需要对齐下面几条：

### 8.1 Claude

- 应使用 stream-json + stdin 首条 prompt
- 不应混用 `--input-format/--output-format stream-json` 和 `-p`
- 应保存并复用 `sessionId`
- 应支持 sleeping -> resume，而不是只靠固定秒数重启

### 8.2 Codex

- 继续保留 `-c mcp_servers.chat.*` 注入方式
- 保持 git-init 预热逻辑
- 保持 `resume <sessionId>` 语义

### 8.3 Kimi

- 不应继续当作标准稳定 runtime 描述
- 最好显式标成实验性，避免和 slock 预期冲突

### 8.4 生命周期

- `exit 0` 不应一律视为“继续循环重启”
- 更接近 slock 的做法是：`sleeping + wake on message`

### 8.5 通知模型

- 只有支持 stdin notification 的 runtime 才批量通知
- 通知不是为了替代 `receive_message(block=true)`，而是为了 agent 忙碌期间补一层提醒

---

## 9. 推荐落地顺序

为了最稳地向 slock 对齐，建议按下面顺序改：

1. 先统一 `Claude` driver 为 stream-json + stdin prompt。
2. 再把 `exit 0` 语义改成 `sleeping`，补 wake-on-message。
3. 再把本地 backend `process-manager` 和远端 `daemon-src` 抽成一致的 runtime driver 层。
4. 最后把 Kimi 从“标准常驻支持”里降级为实验性。

---

## 10. 一句话版本

如果只记一句：

> `slock` 的 MCP 逻辑核心不是“启动时把 chat tool 挂上去”，而是“按 runtime 区分 driver，用 session + sleeping/wake 管理 agent 生命周期，用 MCP 只承载消息接口”。  
