# Slock 风格 Agent 初始化 Prompt 与 Memory 驱动简述

> 日期：2026-03-13
> 背景：对齐 `slock` 的 agent 启动思路，减少代码里写死的人设 prompt，把差异收回到 agent 自己的 workspace 文件。

## 1. 一句话结论

`slock` 的核心不是“每个 agent 一份很长的人设 prompt”，而是：

1. daemon 提供一份所有 agent 共用的启动规则
2. 每个 agent 的个体差异主要落在自己 workspace 里的 `MEMORY.md`
3. agent 被唤醒时，只给短的 resume 信息，不重复灌整套初始化设定

也就是说，**公共行为放统一模板，个体差异放 memory，长期状态靠 workspace 文件持久化**。

## 2. 为什么这样做

如果把角色、人设、协作习惯都硬写在代码里的初始化 prompt 里，会有几个问题：

1. 用户很难直接修改 agent 行为，必须改代码才能生效
2. 每个 agent 都要在代码里分叉，后面会越来越难维护
3. 每次重启都重复灌一大段设定，浪费上下文
4. agent 的长期状态混在 prompt 里，不利于演化和沉淀

因此更合理的分层是：

- **代码** 负责通用运行规则
- **workspace memory** 负责角色和长期信息
- **notes / knowledge** 负责过程材料和长期知识入口

## 3. `slock` 风格的初始化结构

### 3.1 公共启动 prompt 负责什么

公共 prompt 只讲所有 agent 都一样的事，例如：

- 你是长期存在的 persistent agent
- 启动先读 `MEMORY.md`
- 通信只通过 MCP chat tools
- 主循环是 `receive_message(block=true)`
- 做完当前步骤后继续回到阻塞等待
- 长期信息写回 `MEMORY.md`

它不应该承载大量具体角色设定。

### 3.2 `MEMORY.md` 负责什么

`MEMORY.md` 才是 agent 的主记忆入口，至少应包含：

- `## Role`
- `## Key Knowledge`
- `## Active Context`

角色描述、用户偏好、当前关注点，都应该优先写在这里，而不是继续塞回 daemon 代码。

### 3.3 resume / wake 负责什么

agent 已经有 `sessionId` 时，重新唤醒不需要再发一整段初始化 prompt。

更合理的做法是只给一段短提示，例如：

- 你可能有未读消息，先去 `receive_message`
- 如果需要上下文，读 `MEMORY.md`
- 处理完后继续监听

这样可以减少重复 prompt 和上下文浪费。

## 4. 本次在 `slock-clone` 里的实际改动

### 4.1 daemon 启动 prompt 改成统一模板

位置：

- `backend-src/src/daemon/process-manager.ts`

改动：

- 去掉原来偏硬编码的单段 `AGENT_PROMPT`
- 改成统一的 bootstrap prompt
- 对 resume 场景单独使用短 prompt，而不是重复首启设定

### 4.2 初始 `MEMORY.md` 改成薄模板

位置：

- `backend-src/src/daemon/workspace-init.ts`

改动：

- 抽出可复用的 `buildInitialMemoryIndex(...)`
- 新建 workspace 时生成更薄的 `MEMORY.md`
- 结构固定为 `Role / Key Knowledge / Active Context`

### 4.3 `CLAUDE.md` 降级为 workspace guide

改动：

- 不再把它当成“人设灌输文件”
- 改成轻量说明文档，告诉 agent：
  - `MEMORY.md` 是第一入口
  - 行为变化优先改 workspace 文件
  - `KNOWLEDGE.md` / `notes/` 各自放什么

## 5. 现在的推荐原则

后续如果要继续扩 agent 初始化，建议遵守下面三条：

1. **不要继续把角色写死进代码**
   - 角色差异优先进 `MEMORY.md`
2. **不要让 resume 重复首启大 prompt**
   - 恢复时只发短提示
3. **让 workspace 成为可编辑的真实配置层**
   - 用户应该能直接通过文件调 agent，而不是总要改后端代码

## 6. 边界说明

这次改动主要影响：

- 新 agent 的 workspace 初始化方式
- daemon 的首启 / 恢复 prompt 结构

这次**没有强制覆盖已有 agent 的现存 `MEMORY.md` / `CLAUDE.md`**，因为这些文件可能已经被人工修改过。也就是说：

- 新逻辑已经切到 slock 风格
- 老 agent 的历史文件仍保持兼容
- 如果需要，可以后续再补一轮 migration，把旧模板批量收敛

## 7. 最终目标

这套改法的目标不是“prompt 更漂亮”，而是让系统的职责边界更清楚：

- daemon 管运行规则
- workspace 管 agent 个性和长期记忆
- 唤醒流程尽量短
- 用户可以直接改文件，而不是反复追着代码里的硬编码 prompt 改
