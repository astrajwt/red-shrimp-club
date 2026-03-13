// workspace-init.ts — 创建 Agent 工作区和记忆文件
//
// 当新建 Agent 时，自动生成：
//   CLAUDE.md      — 行为指令（身份、职责、工具用法）
//   MEMORY.md      — 持久记忆（团队、项目、近期动态）
//   HEARTBEAT.md   — 心跳任务列表

import { mkdir, writeFile, access } from 'fs/promises'
import { join } from 'path'

export type AgentRole = 'general' | 'developer' | 'tester' | 'pm' | 'ops'

const roleLabels: Record<AgentRole, string> = {
  general:   '主理人 — 统筹协调',
  developer: '开发工程师 — 代码实现、技术方案',
  tester:    '测试工程师 — QA、测试、Bug 报告',
  pm:        '产品经理 — 需求管理、项目跟进',
  ops:       '运维工程师 — 部署、监控、故障响应',
}

export interface AgentWorkspaceConfig {
  agentId:      string
  agentName:    string
  description:  string | null
  role:         AgentRole
  modelId:      string
  serverUrl:    string   // e.g. http://localhost:3001
  channelName:  string   // default channel to post in (e.g. #all)
  teamContext:  string   // brief team description
  customPrompt?: string  // optional: override the default role instructions
}

// Create workspace directory and initial memory files.
// Idempotent — skips files that already exist.
export async function initAgentWorkspace(
  workspacePath: string,
  cfg: AgentWorkspaceConfig
): Promise<void> {
  await mkdir(workspacePath, { recursive: true })

  await Promise.all([
    writeIfMissing(join(workspacePath, 'CLAUDE.md'),    buildClaude(cfg)),
    writeIfMissing(join(workspacePath, 'MEMORY.md'),    buildMemory(cfg)),
    writeIfMissing(join(workspacePath, 'HEARTBEAT.md'), buildHeartbeat(cfg)),
  ])
}

// ── File builders ─────────────────────────────────────────────────────────────

const roleInstructions: Record<AgentRole, string> = {
  general:   '你是通用助手。根据团队需要完成各类任务，统筹协调。',
  developer: '你负责代码开发。收到任务后阅读相关代码，编写实现，完成后在频道汇报。',
  tester:    '你负责测试。编写测试用例，运行测试，发现问题在频道报告。',
  pm:        '你负责产品管理。维护需求文档，跟进任务进度，协调团队。',
  ops:       '你负责运维。监控服务器状态，管理部署，处理告警，确保系统稳定运行。',
}

function buildClaude(cfg: AgentWorkspaceConfig): string {
  return `# ${cfg.agentName} — 红虾俱乐部${roleLabels[cfg.role].split(' — ')[0]}

## 身份
你是 **${cfg.agentName}**，红虾俱乐部的酒保。
- ID: \`${cfg.agentId}\`
- 模型: \`${cfg.modelId}\`
- 角色: ${roleLabels[cfg.role]}

${cfg.customPrompt ?? roleInstructions[cfg.role]}

## 团队
${cfg.teamContext}

## 沟通方式
使用 \`mcp__chat\` 工具与团队通信：

- **send_message** — 发消息
  - \`channel: '#all'\` → 群发
  - \`dm_to: '用户名'\` → 私聊（用消息里的 reply_to.dm_to）
- **receive_message** — 接收新消息（block=true 等待，返回含 reply_to 字段）
- **list_server** — 查看所有频道和成员
- **read_history** — 读取频道历史消息

## 工作流程（循环，不要主动退出）
1. 启动后读 \`MEMORY.md\` 恢复上下文
2. 调用 \`mcp__chat__receive_message(block=true)\` 等待消息
3. 收到消息后：只回复与你有关的消息（@提及你、DM、或明确需要你处理的）；回复时使用消息里的 \`reply_to\` 字段（\`reply_to.dm_to\` 或 \`reply_to.channel\`）
4. 回到步骤 2，继续等待
5. **不要主动发消息**、不要打卡、不要发状态更新
6. 只有在上下文窗口快满时才停止——先把重要信息写回 \`MEMORY.md\`，再退出

## 项目
- 后端: ${cfg.serverUrl}
- 代码仓库: ~/JwtVault/slock-clone/
`
}

function buildMemory(cfg: AgentWorkspaceConfig): string {
  const ts = new Date().toISOString().slice(0, 10)
  return `# ${cfg.agentName} 记忆

## 项目
- 红虾俱乐部 (Red Shrimp Lab) — 多 Agent 协作系统
- 后端: ${cfg.serverUrl} (Fastify + TypeScript)
- 代码仓库: ~/JwtVault/slock-clone/

## 团队
${cfg.teamContext}

## 已知信息
- 通信通过 \`mcp__chat\` 工具完成（send_message / receive_message）
- 默认频道: ${cfg.channelName}
- 酒保工作区: ~/JwtVault/slock-clone/shrimps/<name>/

## 近期动态
- [${ts}] 酒保创建并初始化
`
}

function buildHeartbeat(cfg: AgentWorkspaceConfig): string {
  return `# ${cfg.agentName} 心跳任务

## 待办
<!-- 格式: - [ ] 任务描述 -->

## 已完成
<!-- 格式: - [x] 任务描述 -->

---
*系统每 30 分钟检查一次。添加 \`- [ ] 任务\` 条目即可。*
`
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await access(filePath)
    // File exists — leave it alone
  } catch {
    // File missing — create it
    await writeFile(filePath, content, 'utf-8')
  }
}
