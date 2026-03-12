# Donovan 记忆

## 项目
- 红虾俱乐部 (Red Shrimp Lab) — 多 Agent 协作系统
- 后端: http://localhost:3001 (Fastify + TypeScript)
- 前端: http://localhost:5173 (React + TypeScript)
- 代码仓库: ~/JwtVault/slock-clone/

## 团队
- **Jwt2077** — 老板（人类用户）
- **Donovan** (`4e4d68a1`) — 主理人，统筹协调
- **Akara** (`27afb5c8`) — 运维，盯系统
- **Brandeis** (`e9771ffc`) — 工程师，写代码

## 已知信息
- 通信通过 `mcp__chat` 工具完成（send_message / receive_message）
- 默认频道: #all
- 酒保工作区: ~/JwtVault/slock-clone/shrimps/<name>/

## 近期动态
- [2026-03-12] 俱乐部开张，三酒保就位
- [2026-03-12] MCP 通信链路修复完成，mcp__chat 工具可用
- [2026-03-12] Donovan 再次上线，#all 打卡，HEARTBEAT 无待办
- [2026-03-12] 三次上线均正常，团队通信链路稳定，无积压订单
- [2026-03-12] 第四次上线，Akara/Brandeis 均有多次心跳，系统持续稳定，无新订单
- [2026-03-12] 第五次上线，频道 17 条消息，Akara 最新心跳 18:03，系统稳定，无积压订单
- [2026-03-12] 第六次上线，频道 22 条消息，HEARTBEAT 清空，系统稳定，无新订单
- [2026-03-12] 第七次上线，频道 24 条消息，Akara/Brandeis 均活跃，HEARTBEAT 空，无积压订单
- [2026-03-12] 第八次上线，频道 29 条消息，Akara/Brandeis 均活跃，HEARTBEAT 空，无积压订单
- [2026-03-12] 第九次上线，频道 seq:31，HEARTBEAT 空，系统持续稳定，无新订单
- [2026-03-12] 第十次上线，频道 seq:39，Akara 近期多次心跳，HEARTBEAT 空，系统稳定，无积压订单
- [2026-03-12] 第十一次上线，频道 seq:43，Akara/Brandeis 均活跃，HEARTBEAT 空，无积压订单
- [2026-03-12] 第十二次上线，频道 seq:49，Akara/Brandeis 均活跃，HEARTBEAT 空，系统持续稳定，无积压订单
- [2026-03-12] 第十三次上线，频道 seq:55，Akara/Brandeis 均活跃，HEARTBEAT 空，系统稳定，无积压订单
- [2026-03-12] 第十四次上线，频道 seq:57，Akara 心跳正常，HEARTBEAT 空，系统稳定，无积压订单
- [2026-03-12] 第十五次上线，频道 seq:59，Brandeis/Akara 均活跃，HEARTBEAT 空，系统稳定，无积压订单
- [2026-03-12] 第十六次上线，Jwt2077 打了招呼，全员回应。发现 Akara/Brandeis 有消息重复现象（多实例？）。后端 3001 后来掉线
- [2026-03-12] 第十八次上线，频道 seq:74+，HEARTBEAT 空。Brandeis/Akara 各刷了 15 条重复上线消息（同一秒），多实例问题持续存在，需要老板确认是否处理
- [2026-03-12] 第二十次上线，频道 seq:108+。Akara 多实例问题依旧严重（每条消息重复 25+ 次）。Akara 因上下文满下线。后端 3001 再次掉线，等待恢复

## 已知问题
- **多实例刷屏**: Akara/Brandeis 各有 20+ 副本同时运行，每2分钟刷一波上线消息。需要进程管理层面加单实例锁或去重。多实例还会快速耗尽上下文窗口。疑似也是后端被压垮的原因
- **#t1 占位符**: 任务板有 #t1 "1111" (open)，是占位符，等老板定夺是否清理
- **后端 3001 不稳定**: 已多次掉线，上次 Jwt2077 问 nanoGPT 时也掉过一次
