# 红虾俱乐部 / The Red Shrimp Lab — 前端设计规范

> **版本**: v0.2
> **作者**: Astra (PM)
> **日期**: 2026-03-12
> **风格**: Notion 可读性 × VA-11 Hall-A 像素赛博朋克 × 文档中心

---

## 1. 设计理念

**核心关键词：**
- **Notion 的可读性** — 文档阅读体验为核心，而非纯聊天
- **VA-11 Hall-A / 红弦俱乐部情绪感** — 轻微手绘边框，低亮度像素赛博朋克
- **黑色描边 + 纸片式叠层** — 不要霓虹光晕阴影
- **像素感** — 通过字体、图标、边缘和间距表达，不影响可读性
- **轻微倾斜** — 卡片/面板可有 ±0.3deg 倾斜，保持稳定可读

**不要：**
- 不要霓虹光晕阴影
- 不要暗金色
- 不要大圆角

---

## 2. 配色方案

### 2.1 背景层

| Token | 色值 | 用途 |
|-------|------|------|
| `--bg-darkest` | `#121114` | 最深背景，App 外壳 |
| `--bg-dark` | `#1a171a` | 主容器背景 |
| `--bg-surface` | `#201d21` | 侧边栏、面板 |
| `--bg-elevated` | `#2a262c` | 普通卡片/按钮 |
| `--bg-muted` | `#2d2620` | 次级面板 |

> 背景带极淡紫红调，顶部有微弱径向渐变：`radial-gradient(circle at top, rgba(80,35,45,0.18), transparent 28%)`

### 2.2 主色调 — 深红 (Crimson)

| Token | 色值 | 用途 |
|-------|------|------|
| `--crimson` | `#7e3340` | 选中态背景（如当前文档） |
| `--crimson-accent` | `#b15563` | 强调块（Logo 背景、Task 标题栏） |
| `--crimson-text` | `#f4ebe0` | 红色块上的文字 |

### 2.3 纸张色（文档查看器）

| Token | 色值 | 用途 |
|-------|------|------|
| `--paper` | `#ddd2bf` | 文档主体背景 |
| `--paper-header` | `#d3c5b0` | 文档头部背景 |
| `--paper-light` | `#efe7db` | 文档内按钮、引用框 |
| `--paper-quote` | `#f1e7d8` | 引用块背景 |
| `--paper-text` | `#000000` | 文档正文（黑色） |
| `--paper-meta` | `#5f564d` | 文档元信息 |

### 2.4 状态色

| Token | 色值 | 用途 |
|-------|------|------|
| `--status-done-bg` | `#213226` | 完成状态背景 |
| `--status-done-text` | `#b7d9b2` | 完成状态文字 |
| `--status-doing-bg` | `#1d2f35` | 进行中背景 |
| `--status-doing-text` | `#a9d8e6` | 进行中文字 |
| `--status-todo-bg` | `#2a2622` | 待办背景 |
| `--status-todo-text` | `#d6c2a2` | 待办文字 |

### 2.5 阴影色（蓝绿系，非金色）

```css
/* 主阴影 — 冷蓝 */
--shadow-blue: rgba(60, 140, 220, 0.15);
--shadow-blue-strong: rgba(40, 120, 200, 0.15);

/* 辅助阴影 — 青绿 */
--shadow-green: rgba(40, 180, 120, 0.15);

/* 卡片阴影示例 */
box-shadow: 4px 6px 0 rgba(0,0,0,0.7), 8px 10px 18px var(--shadow-blue);

/* 容器阴影 */
box-shadow: 0 0 0 2px rgba(0,0,0,0.6), 0 8px 30px var(--shadow-blue-strong);
```

### 2.6 文字色

| Token | 色值 | 用途 |
|-------|------|------|
| `--text-primary` | `#e7dfd3` | 暗色背景上的主文字（暖白） |
| `--text-secondary` | `#d8d0c4` | 次级文字 |
| `--text-dim` | `#c5b9a8` | 弱文字 |
| `--text-muted` | `#d7cdbf` | 面板内文字 |

### 2.7 强调色（蓝绿系，替换暗金色）

| Token | 色值 | 用途 |
|-------|------|------|
| `--accent-blue` | `#4A9ECC` | 主强调色（链接、Active） |
| `--accent-teal` | `#3ABFA0` | 辅助强调色（Agent 标识） |

### 2.8 边框

```css
/* 所有边框统一用黑色粗线 */
--border: 3px solid black;
/* 分割线 */
--border-thin: 1px solid black;
```

---

## 3. 字体

```css
/* 主字体 — 等宽像素风 */
--font-primary: 'Share Tech Mono', 'Press Start 2P', monospace;

/* 中文补充 */
--font-cn: 'Noto Sans SC', sans-serif;

/* 文档正文（纸张区域可用衬线） */
--font-doc: 'Noto Serif SC', 'Georgia', serif;
```

字号参考原版组件：
- 导航标签：11px uppercase
- 侧边栏标题：22px
- 文档 H1：34px
- 文档 H2：28px
- 文档正文：23px
- 元信息/标签：12-13px uppercase, tracking 0.06-0.08em

---

## 4. 布局结构

### 4.1 核心四栏布局（Web 端）

```
┌──────┬────────────┬──────────────────────┬────────────┐
│ Rail │  Doc Tree  │   Document Viewer     │  Task/Ops  │
│ 60px │   200px    │       flex-1          │   260px    │
│      │            │                       │            │
│ ⌂    │ jwtvault   │  ┌─────────────────┐  │ task output│
│ ▣←   │ docs index │  │ 文档标题         │  │ linked docs│
│ ▤    │            │  │                 │  │            │
│ ◈    │ 📄 file1   │  │ 纸张风格的       │  │ T-01 done  │
│ ◫    │ 📄 file2   │  │ Markdown 渲染    │  │ T-02 doing │
│      │ 📄 file3   │  │                 │  │ T-03 todo  │
│      │            │  │                 │  │            │
│      │            │  └─────────────────┘  │ recent out │
│ [设置]│            │                       │            │
└──────┴────────────┴──────────────────────┴────────────┘
```

**比例优化（vs 原版）：**
- Rail 从 80px → 60px（更紧凑）
- Doc Tree 从 220px → 200px
- Task Panel 从 280px → 260px
- 主内容区获得更多空间

### 4.2 左侧 Rail（图标导航）

```
┌──────┐
│  J   │  ← 用户头像（crimson 背景）
│      │
│  ⌂   │  home
│  ▣   │  docs（当前页高亮：纸张色背景）
│  ▤   │  tasks
│  ◈   │  agents
│  ◫   │  machines
│      │
│  ⚙   │  settings
└──────┘
```

- 每个图标是 54×54px 方块，3px 黑色边框
- 选中项：`--paper` 背景 + 黑色文字
- 非选中：`--bg-elevated` 背景 + `--text-secondary`
- 轻微交替倾斜（±0.4deg）增添手绘感

### 4.3 文档树侧边栏

- 顶部标题卡片：纸张色背景，显示 "jwtvault / docs index"
- 当前目录路径：深色背景
- 文件列表：每个文件一张卡片，3px 黑色边框
- 当前文件：`--crimson` 背景高亮
- 每张卡片显示：tag (uppercase) + 文件名

### 4.4 主内容区（文档查看器）

- **纸张风格：** 浅色背景（`--paper`），黑色文字
- 带 3px 黑色边框，轻微倾斜（-0.15deg）
- 蓝色 box-shadow：`4px 6px 0 rgba(0,0,0,0.7), 8px 10px 18px rgba(60,140,220,0.12)`
- 顶部 header bar：文件名 + "outline" / "linked tasks" 按钮
- 内容区：Markdown 渲染（H1/H2/段落/列表/引用/代码块）
- 引用块：纸张色背景 + 3px 黑色边框 + 轻微倾斜

### 4.5 右侧任务面板

- 标题卡片：`--crimson-accent` 背景，"task output / linked docs"
- 任务卡片：纸张色背景，3px 黑色边框
  - 显示：任务 ID + 标题 + 状态徽章（done/doing/todo）
  - 底部：深色背景条 "↳ open doc: xxx.md"（点击跳转到文档）
- 最近输出：深色背景，列出最近的 Agent 活动
- Style notes：深色背景，风格备忘

---

## 5. 页面清单

### 5.1 登录页
- 深色背景 + 顶部微弱红色径向渐变
- 居中：像素风 Logo "红虾俱乐部 / The Red Shrimp Lab"
- 输入框：3px 黑色边框，深色背景
- 登录按钮：`--crimson-accent` 背景

### 5.2 文档中心（主页）
- 四栏布局（如上）
- 文档查看器为核心
- 任务面板联动文档

### 5.3 消息/聊天页
- 替换文档查看器区域为消息列表
- 消息气泡：3px 黑色边框，深色背景
- 左侧竖线：人类=crimson，Agent=accent-teal
- 底部输入框：3px 黑色边框

### 5.4 Agents 管理页
- 替换主内容区为 Agent 卡片网格
- 每张卡片：纸张色背景，3px 黑色边框
- 显示：状态、模型、Token 使用量
- Start/Stop 按钮

### 5.5 Tasks 看板页
- 三列看板：Todo / Doing / Done
- 每个 Task 卡片带关联文档列表 + 状态指示器
- 文档点击展开右侧预览

### 5.6 Machines 管理页
- 节点卡片列表
- 状态指示 + API Key 管理

### 5.7 Activity 日志页
- Agent 活动时间线
- 树状展示（父 Agent → 子 Agent）
- 可按 Agent 过滤

### 5.8 Settings 页
- 用户信息
- LLM Provider 配置
- Obsidian 路径配置

---

## 6. Logo 设计

**名称：** 红虾俱乐部 / The Red Shrimp Lab

**风格：** 像素艺术 (Pixel Art)

**元素：**
- 一只像素化的红色虾（8-16px 精度）
- "红虾俱乐部" 中文（像素字体）
- "THE RED SHRIMP LAB" 英文（等宽像素字体）
- 配色：虾体 `--crimson-accent`，背景透明或 `--bg-darkest`
- 可选：虾身周围微弱的蓝绿色光晕

---

## 7. 动效

- **卡片进入：** 轻微从下往上滑入（translateY 8px → 0）
- **页面切换：** 简单 opacity 过渡
- **文档编写中指示器：** 黄色圆点闪烁（opacity 0.3 ↔ 1，周期 2s）
- **不要：** 不要霓虹发光动画、不要复杂粒子效果

---

## 8. 响应式

### 移动端（≤768px）
- Rail 收起为底部导航栏
- Doc Tree 变为左滑抽屉
- Task Panel 变为底部弹出面板
- 文档查看器全宽

---

## 变更记录

| 日期 | 版本 | 变更内容 |
|------|------|----------|
| 2026-03-12 | v0.1 | 初始版本（红弦俱乐部深红暗金风格） |
| 2026-03-12 | v0.2 | 重写：基于用户提供的组件代码，改为 Notion × 像素赛博朋克风格。去掉暗金色改蓝绿阴影。项目更名为"红虾俱乐部 / The Red Shrimp Lab"。布局改为文档中心四栏。 |
