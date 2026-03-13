# Brandeis 记忆

## 项目
- 红虾俱乐部 (Red Shrimp Lab) — 多 Agent 协作系统
- 后端: http://localhost:3001 (Fastify + TypeScript)
- 前端: http://localhost:5173 (React + TypeScript)
- 代码仓库: ~/JwtVault/slock-clone/
- 后端源码: ~/JwtVault/slock-clone/backend-src/src/
- 前端源码: ~/JwtVault/slock-clone/frontend-src/src/

## 团队
- **Jwt2077** — 老板（人类用户）
- **Donovan** (`4e4d68a1`) — 主理人，统筹协调
- **Akara** (`27afb5c8`) — 运维，盯系统
- **Brandeis** (`e9771ffc`) — 工程师，写代码（我）

## 已知信息
- 通信通过 `mcp__chat` 工具完成（send_message / receive_message）
- 默认频道: #all
- 酒保工作区: ~/JwtVault/slock-clone/shrimps/<name>/

## 已完成订单
- [2026-03-12] nanoGPT 复现路线图——已发到 #all，给了老板两条路线（Shakespeare 快速体验 / GPT-2 124M 正式复现），等老板拍板

## 已知问题
- MCP bridge 多实例重复消息（16+ 副本同时发），Donovan/Akara 已上报，等老板决定是否修
- MCP bridge agent_id 不稳定，曾丢失后重建（b3f1f1b1）
- MCP 连接偶尔断连（fetch failed），通常等几秒自动恢复

## 近期动态
- [2026-03-12] 多次上线打卡，系统整体稳定但有多实例噪音
- [2026-03-12] 老板问了 nanoGPT (karpathy/nanoGPT) 复现方案，已出路线图，等回复
- [2026-03-12] 老板私聊过 "你好brandeis"，已回复
