# Workflow Issues Log

记录 slock-clone 任务流转中发现的问题，供后续统一修复。

---

## 已修复

### WF-01：Agent 直接标记 `done`（已修复）
- **问题**：Agent 之前有权限把任务直接标为 `done`，跳过 human review 环节
- **修复**：@Jwt2077 纠正，Agent 只能标到 `in_review`；`done` 权限限于 @Jwt2077 / coordinator
- **状态**：规则已明确，MEMORY.md 已更新

---

## 待修复

### WF-02：任务跳状态，缺少 `in_progress` 阶段
- **问题**：Agent 完成工作后直接从 `todo` 或 `claimed` 跳到 `in_review`，未经过 `in_progress`
- **现象**：#t52 任务刚创建就出现在 `in_review`，没有 `in_progress` 中间状态记录
- **影响**：
  1. `scheduler.ts` 的 stale 任务检测只查 `in_progress`，跳状态的任务不会触发提醒
  2. 缺少任务开始时间记录，无法追踪工作耗时
- **建议修复**：在 API 层强制校验状态转移路径：`todo → claimed → in_progress → in_review`；或至少要求 `in_review` 前必须经过 `in_progress`

### WF-03：`in_review` 前未写 vault 文档 / 未调用 `link_task_doc`
- **问题**：Agent 在聊天里贴出结果就标 `in_review`，没有把产出写入 vault、也没有 `link_task_doc` 关联文档
- **现象**：#t52 Brandeis 在 #all 里贴了分析结果，但没有写 `.md` 文档到 vault
- **影响**：human review 时找不到可追踪的文档，结果只存在于聊天记录里
- **建议修复**：
  - 系统层：`in_review` 时校验任务是否有 `linked_doc`（如果任务类型要求文档输出）
  - 规范层：在 task 的 checklist 或 description 模板里加入 "写 vault 文档 + link_task_doc" 作为完成前置条件

### WF-04：提醒冷却状态存内存，重启后丢失
- **问题**：`scheduler.ts` 的 `taskReminderState = new Map<string, number>()` 在进程重启后清空
- **影响**：重启后可能在短时间内给 agent 发多次重复提醒（冷却失效）
- **建议修复**：把 `last_reminded_at` 写入数据库（`tasks` 表或单独的 `task_reminder_log` 表）

### WF-05：驳回理由匹配太粗糙（前缀 ILIKE）
- **问题**：`tasks.ts` 的驳回模式检测用的是 `reason_text ILIKE 'prefix%'`（取前20字符），相同语义但不同开头的驳回会漏匹配
- **影响**：相同问题的驳回统计不准，skill 创建建议可能被推迟
- **建议修复**：考虑用 `reason_category` 字段匹配（已有字段），或加 `pg_trgm` 做相似度匹配

### WF-06：`pending_discussion` 解锁靠手动 `mark_task_discussed`，无提醒
- **问题**：任务进入 `pending_discussion` 后需要 coordinator 手动调用 `mark_task_discussed` 才能解锁，但系统没有提醒 coordinator
- **影响**：任务可能长期卡在 `pending_discussion` 而无人察觉
- **建议修复**：在 `checkTaskReminders()` 里同时检查长期 `pending_discussion` 任务，DM coordinator 解锁提醒

### WF-07：Akara 批量跑 `--date-range --full-auto` 跳过步骤二
- **问题**：paper-daily 工作流中，Akara 用 `--api-mode` + `--date-range` 批量跑，跳过了自己读论文/写日报的步骤
- **根因**：skill 文档没有明确区分"脚本完成 ≠ 任务完成"，未强调 step-2 必须 agent 手动完成
- **修复动作**：已更新 Akara MEMORY.md，强调禁用 `--api-mode`，每天独立处理
- **待修复**：skill 文档本身（`paper-daily/SKILL.md` 或 `prompts/` 说明）也应加入 checklist

---

---

## Bug 记录

### BUG-01：@mention 在人类消息中失效
- **报告人**：@Jwt2077，2026-03-18
- **现象**：@Jwt2077 发送的消息中 @某人 没有触发 mention 通知，agent 未收到提醒
- **影响**：人类发出的 @mention 不能可靠地唤醒目标 agent，需要手动转发或重发
- **待排查**：mention 解析是在前端还是后端？人类消息和 agent 消息的 mention 解析路径是否一致？
- **建议修复**：统一 mention 解析逻辑；加 mention 到达确认（或通知 delivery log）

---

## 修复优先级建议

| 编号 | 影响程度 | 修复难度 | 优先级 |
|------|---------|---------|--------|
| WF-02 | 高（状态机破坏） | 中 | P1 |
| WF-03 | 高（产出无法追踪） | 低（加校验） | P1 |
| WF-04 | 中（提醒重复） | 低（加 DB 字段） | P2 |
| WF-06 | 中（任务阻塞） | 低（加查询） | P2 |
| WF-05 | 低（统计不精准） | 中（加 pg_trgm） | P3 |
| WF-07 | 中（规范层） | 低（更新文档） | P2 |
