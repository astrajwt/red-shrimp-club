# Swarm 自我进化与 Donovan 决策卡简述

## 目标

把当前多 agent 系统从“会对话、会做 task”推进到“会积累反馈、会产出改进、会复用经验”。

核心闭环不是继续堆 prompt，而是：

`反馈 -> 归因 -> task/doc 关联 -> skill 沉淀 -> 下次复用`

## 四个工程阶段

1. `结构化反馈 spine`
   - 统一记录 task review、reject、Donovan 汇报反馈。
   - 关键表：`task_feedbacks`、`message_feedbacks`。

2. `任务图谱`
   - 让 task、subtask、vault 文档、产物之间有正式关联。
   - 关键表：`task_dependencies`、`task_artifacts`。

3. `skill 版本与使用统计`
   - skill 不只是 md 文件，还要能知道版本、调用次数、成功率。
   - 关键表：`skill_versions`、`skill_usages`。

4. `自动提炼`
   - 从重复成功模式、重复 reject reason、重复 task 结构里自动提出 candidate skill。

## Donovan 决策卡

Donovan 不应该只给“对 / 错”反馈，更常见的是给人类几条可选路径，让人类直接选路。

因此在 DM / 汇报消息里支持一种轻量协议：

```md
本轮建议先选一条：

[A] 继续做 profiling
    next: 给 Brandeis 建一个 profiling 子任务
    why: 先拿性能瓶颈，再决定是否重写 kernel

[B] 直接提炼成 skill
    next: 写入 05_skills/candidates/profiling.md
    why: 这个套路已经重复了 3 次

[C] 暂停，先补上下文
    next: 让 Donovan 继续追问实验环境和 batch 配置
```

约束：

- `[A] / [B] / [C]` 这种行是可点击选项。
- 后续带缩进的行会作为该选项的说明一起展示。
- 一个用户对同一条 Donovan 汇报只保留一个 `selected` 结果。
- 选择后不只是数据库记一条 `selected`，还要在对话里自动回写一条“我选择了哪个方案”的消息，让 Donovan 和其他协作者看到决策。

## 最小实现

### 后端

- `message_feedbacks` 扩展：
  - `verdict`: `correct | wrong | selected`
  - `item_label`
  - `item_text`
- `POST /api/messages/:messageId/feedback`
  - `selected` 时校验所选项确实存在于 Donovan 消息中。
  - 自动清掉同一用户对同一消息的旧 `selected`。
  - 自动在原频道回写一条“已选择方案”的人类消息。

### 前端

- Donovan 私聊中的反馈面板支持 `decision card`。
- `[A] ...` 选项下方的缩进行会渲染成次级说明。
- 选项点击后显示已选状态，并把选择同步回对话。

## 为什么先做这个

这一步把“人类拍板”从口头交流变成了结构化事件：

- Donovan 知道人类选了哪条路。
- 系统知道哪些建议被采纳。
- 后面可以把“被频繁采纳的建议模式”继续提炼成 skill / workflow。

没有这层，swarm 只是在聊天；有了这层，swarm 才开始形成可学习的决策记录。
