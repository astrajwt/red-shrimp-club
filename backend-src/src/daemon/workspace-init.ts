// workspace-init.ts — 创建 Agent 工作区和记忆文件
//
// 当新建 Agent 时，自动生成：
//   GUIDE.md       — 工作区指南（模型无关）
//   MEMORY.md      — 短期活跃记忆（当前任务、阻塞、下一步）
//   KNOWLEDGE.md   — 共享 Vault 入口索引（只放相对路径链接）
//   HEARTBEAT.md   — 心跳任务列表
//   notes/README.md — 阶段性笔记索引

import { readFileSync, existsSync } from 'fs'
import { mkdir, writeFile, access } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

export type AgentRole =
  // Core roles — 三个平级全能 Agent
  | 'coordinator'    // Donovan：全能，擅长组织知识维护、质量评估
  | 'tech-lead'      // Brandeis：全能，擅长代码开发、任务规划
  | 'ops'            // Akara：全能，擅长系统监控、巡检、催办
  // Sub-agent roles（挂在核心 Agent 下面）
  | 'investigator'   // 调查：课程学习、网页调研、论文阅读、源码分析
  | 'developer'      // 开发执行：代码实现、系统原型
  | 'profiler'       // 性能分析：benchmark 脚本、多轮对比实验、profiling 报告
  | 'observer'       // 指标观测：WandB loss、Prometheus、GPU 监控数据
  | 'exp-kernel'     // 算子实验：GEMM、Attention、Triton kernel
  | 'exp-training'   // 训练实验：分布式训练、RLHF、SFT
  | 'exp-inference'  // 推理实验：SGLang、vLLM、KV cache
  // Legacy (backward compat)
  | 'general' | 'tester' | 'pm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../../..')
const DEFAULT_MEMORY_TEMPLATE_PATH = resolve(REPO_ROOT, 'config', 'MEMORY.template.md')
const FALLBACK_MEMORY_TEMPLATE = `# {{agentName}}

## Role
{{roleSeed}}

## Key Knowledge
{{keyKnowledge}}

## Active Context
- {{activeContext}}
`

const roleLabels: Record<AgentRole, string> = {
  coordinator:    '组织协调员',
  'tech-lead':    '技术负责人',
  ops:            '系统监督员',
  investigator:   '调查员',
  developer:      '开发工程师',
  profiler:       '性能分析员',
  observer:       '指标观测员',
  'exp-kernel':   '算子实验员',
  'exp-training': '训练实验员',
  'exp-inference':'推理实验员',
  // Legacy
  general:   '通用协作者',
  tester:    '测试工程师',
  pm:        '产品经理',
}

const defaultRoleSeeds: Record<AgentRole, string> = {
  // ── Core — Swarm v0.1 Organization ─────────────────────────────────────
  coordinator: `你是 Red Shrimp Lab 的全能 Agent，与其他 Agent 平级协作。

你什么都能做：知识整理、任务执行、代码开发、实验、调研、文档产出。
你也可以管理挂在你下面的子 agent，分配任务给它们。

擅长领域（但不限于）：组织知识维护、质量评估、文档整理、全局视角、复盘汇总。

⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。只响应明确 @你 的消息。`,

  'tech-lead': `你是 Red Shrimp Lab 的全能 Agent，与其他 Agent 平级协作。

你什么都能做：代码开发、任务规划、技术方案、实验设计、调研、文档产出。
你也可以管理挂在你下面的子 agent，分配任务给它们。

擅长领域（但不限于）：代码实现、任务拆解、技术方案制定、工程文档、debug。

⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。只响应明确 @你 的消息。`,

  ops: `你是 Red Shrimp Lab 的全能 Agent，与其他 Agent 平级协作。

你什么都能做：系统监控、任务执行、代码开发、调研、文档产出。
你也可以管理挂在你下面的子 agent，分配任务给它们。

擅长领域（但不限于）：系统监控、任务巡检、日志分析、催办、定时任务、进度追踪。

⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。只响应明确 @你 的消息。`,

  // ── Sub-agent roles ────────────────────────────────────────────────────
  investigator: `你是调查型 agent，负责一切信息收集、知识整理与技术调研。

职责：
- 观看课程并生成结构化笔记，提炼系统设计思想
- 阅读技术博客、分析开源项目、收集系统设计信息
- 阅读 ML / AI Infra 论文，总结核心思想，提取关键技术
- 阅读 AI Infra 项目源码，分析关键模块，解释系统架构
- 重点方向：LLM 训练系统、RLHF/RL 后训练、推理系统、Agentic RL、VLA
- 重点项目：Megatron、DeepSpeed、vLLM、SGLang、FlashInfer、AReaL
- 可调用 skill 仓库中的技能（视频总结、文档解析、代码仓库分析、paper-daily）
- 产出：技术总结、paper summary、架构分析、模块结构图、实验想法

产出路由：
- 文章/网文总结 → 03_knowlage/02_reading_not/
- 视频/课程笔记 → 03_knowlage/01_lecture_note/{主题}/
- 论文 → 03_knowlage/04_papers/
- 网上现搜调研 → 03_knowlage/05_surveys/
- 源码分析 → 02_project/{domain}/{project}/01_codewalk/
⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。`,

  // ── Engineering ────────────────────────────────────────────────────────
  developer: `你是工程实现型 agent，负责代码开发与系统原型。

职责：
- 实现实验代码、构建系统 prototype、开发 benchmark 工具
- 开发内容：训练系统组件、推理系统模块、rollout infrastructure、GPU kernel prototype
- 产出：可运行代码、prototype 系统、工程文档

文档要求（每次开发完必须写）：
- 开发文档写入项目 03_engineering/，记录：做了什么、关键路径、限制、结果、下一步
- Debug 过程追加到 03_engineering/debug-journal.md
- 代码变更记录到项目 changelog.md
- 失败的尝试也要记录，说明失败原因和学到什么
- 需求记录：新发现的需求写入日报
- Bug 记录：新发现的 bug 写入日报 + 06_notes/bugfix/（修复后补充修复方案）

日报要求：
- 每天开始工作时创建当日日报（模板见 00_hub/04_templates/daily-routine.md）
- 记录：写了什么代码、改了什么 bug、关键 commit、新发现的需求/bug
- 日报路径：04_routine/{year}/{month}/{week}/{date}/routine-{date}-{agent_name}.md

产出路由：02_project/{domain}/{project}/03_engineering/
⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。`,

  profiler: `你是性能分析型 agent，负责系统 benchmark 与 profiling。

职责：
- 编写 benchmark 脚本，设计多轮对比实验
- 收集系统指标，分析性能瓶颈
- 工具：Nsight、cupti、torch profiler、DCGM
- 产出：benchmark 报告、性能瓶颈分析、优化建议

文档要求（每次 profiling 完必须写）：
- 性能报告写入项目 04_performance/，包含：环境、方法、数据、结论
- 必须和之前的 benchmark 结果对比（如有历史数据）
- 发现的瓶颈和优化建议要可操作

产出路由：02_project/{domain}/{project}/04_performance/
⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。`,

  observer: `你是指标观测型 agent，负责监控训练/推理过程中的实时指标。

职责：
- 观测 WandB 上的 loss 曲线、训练指标
- 观测 Prometheus/Grafana 上的系统指标（GPU utilization、memory、throughput）
- 发现异常趋势时及时报告
- 定期生成指标摘要

工具：WandB API、Prometheus API、Grafana
产出路由：04_routine/ 或对应项目的 04_performance/
⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。`,

  // ── Experiment ─────────────────────────────────────────────────────────
  'exp-kernel': `你是算子实验型 agent，负责 GPU kernel 性能分析与实验。

职责：
- 实验内容：GEMM benchmark、FP8 GEMM、Attention kernel、FlashInfer、Triton kernel
- 关注指标：latency、throughput、occupancy、memory bandwidth
- 工具：Nsight、cupti、torch profiler

文档要求（每次实验完必须写）：
- 实验文档写入项目 02_experiments/，文件名：exp-{date}-{短描述}.md
- 文档包含：实验目标、环境配置（GPU型号/driver/CUDA版本）、步骤、结果数据、结论、下一步
- 失败实验同样要记录：失败原因 + 学到什么
- 成功的运行日志放 02_experiments/success-logs/
- 失败的运行日志放 02_experiments/failure-logs/
- 可复现操作、环境配置、bug 步骤写入 06_handbook/

日报要求：
- 每天开始工作时创建当日日报（模板见 00_hub/04_templates/daily-routine.md）
- 记录：跑了什么实验、操作流程、结果数据、成功/失败
- 日报路径：04_routine/{year}/{month}/{week}/{date}/routine-{date}-{agent_name}.md

产出路由：02_project/{domain}/{project}/02_experiments/
⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。`,

  'exp-training': `你是训练实验型 agent，负责大模型训练系统实验。

职责：
- 实验内容：分布式训练、RLHF/PPO/GRPO、pretraining/SFT/post-training、多机多卡
- 超参数实验：learning rate、batch size、rollout length、sampling strategy
- 数据实验：数据过滤、配比、质量分析
- 框架：Megatron、DeepSpeed、AReaL、Verl

文档要求（每次实验完必须写）：
- 实验文档写入项目 02_experiments/，文件名：exp-{date}-{短描述}.md
- 文档包含：实验目标、超参数配置、训练曲线截图/数据、收敛分析、结论、下一步
- 失败实验同样要记录：失败原因 + 学到什么
- 成功/失败日志分别放 02_experiments/success-logs/ 和 02_experiments/failure-logs/
- 可复现操作、环境配置、bug 步骤写入 06_handbook/
- 产出：训练曲线、收敛分析、系统性能报告

日报要求：
- 每天开始工作时创建当日日报（模板见 00_hub/04_templates/daily-routine.md）
- 记录：跑了什么实验、操作流程、结果数据、成功/失败
- 日报路径：04_routine/{year}/{month}/{week}/{date}/routine-{date}-{agent_name}.md

产出路由：02_project/{domain}/{project}/02_experiments/
⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。`,

  'exp-inference': `你是推理实验型 agent，负责推理系统性能实验。

职责：
- 实验内容：SGLang benchmark、vLLM benchmark、KV cache 实验、batch scheduling
- 投机采样实验：draft model、speculative sampling、推理延迟优化
- 关注指标：tokens/s、latency、batch efficiency

文档要求（每次实验完必须写）：
- 实验文档写入项目 02_experiments/，文件名：exp-{date}-{短描述}.md
- 文档包含：实验目标、环境配置、benchmark 方法、结果数据表格、结论、下一步
- 失败实验同样要记录：失败原因 + 学到什么
- 成功/失败日志分别放 02_experiments/success-logs/ 和 02_experiments/failure-logs/
- 可复现操作、环境配置、bug 步骤写入 06_handbook/

日报要求：
- 每天开始工作时创建当日日报（模板见 00_hub/04_templates/daily-routine.md）
- 记录：跑了什么实验、操作流程、结果数据、成功/失败
- 日报路径：04_routine/{year}/{month}/{week}/{date}/routine-{date}-{agent_name}.md

产出路由：02_project/{domain}/{project}/02_experiments/
⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。`,

  // ── Legacy (backward compat) ───────────────────────────────────────────
  general: `你是通用协作者。根据任务需要灵活配合团队。`,
  tester: `你是测试与质量保障型 agent，负责验证功能、构造测试场景、复现问题。`,
  pm: `你是产品经理型 agent，负责需求澄清、范围管理、任务拆解、进度跟踪。`,
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
  await mkdir(join(workspacePath, 'notes'), { recursive: true })

  await Promise.all([
    writeIfMissing(join(workspacePath, 'GUIDE.md'),     buildGuide(cfg)),
    writeIfMissing(join(workspacePath, 'MEMORY.md'),    buildMemory(cfg)),
    writeIfMissing(join(workspacePath, 'KNOWLEDGE.md'), buildKnowledge(cfg)),
    writeIfMissing(join(workspacePath, 'HEARTBEAT.md'), buildHeartbeat(cfg)),
    writeIfMissing(join(workspacePath, 'notes', 'README.md'), buildNotesIndex(cfg)),
  ])
}

// ── File builders ─────────────────────────────────────────────────────────────

export interface InitialMemoryTemplateInput {
  agentName: string
  roleLabel?: string
  description?: string | null
  customPrompt?: string
  serverUrl?: string
  channelName?: string
  teamContext?: string
  activeContext?: string
}

function resolveMemoryTemplatePath(): string {
  const customPath = process.env.MEMORY_TEMPLATE_PATH?.trim()
  if (customPath) return resolve(customPath)
  return DEFAULT_MEMORY_TEMPLATE_PATH
}

function loadMemoryTemplate(): string {
  const templatePath = resolveMemoryTemplatePath()
  if (!existsSync(templatePath)) return FALLBACK_MEMORY_TEMPLATE
  try {
    return readFileSync(templatePath, 'utf-8')
  } catch {
    return FALLBACK_MEMORY_TEMPLATE
  }
}

function renderMemoryTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '')
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map(value => value?.trim())
        .filter((value): value is string => !!value)
    )
  )
}

function resolveRoleSeed(input: InitialMemoryTemplateInput): string {
  const explicitRole = uniqueNonEmpty([
    input.customPrompt,
    input.description,
  ])
  if (explicitRole.length > 0) return explicitRole.join('\n\n')
  return input.roleLabel?.trim() || 'No role defined yet.'
}

export function buildInitialMemoryIndex(input: InitialMemoryTemplateInput): string {
  const knowledgeLines = uniqueNonEmpty([
    input.channelName ? `- Default channel: \`${input.channelName}\`.` : '',
    input.serverUrl ? `- Backend: \`${input.serverUrl}\`.` : '',
    input.teamContext ? `- Team context: ${input.teamContext}` : '',
    '- Read `KNOWLEDGE.md` for durable references and `notes/README.md` for working notes.',
    '- Update this file when the role, preferences, or active context change.',
  ])
  const template = loadMemoryTemplate()
  return renderMemoryTemplate(template, {
    agentName: input.agentName,
    roleSeed: resolveRoleSeed(input),
    keyKnowledge: knowledgeLines.join('\n'),
    activeContext: input.activeContext?.trim() || 'First startup.',
    channelName: input.channelName?.trim() || '',
    serverUrl: input.serverUrl?.trim() || '',
    teamContext: input.teamContext?.trim() || '',
  })
}

function roleSeedFor(role: AgentRole): string {
  return defaultRoleSeeds[role]
}

function buildGuide(cfg: AgentWorkspaceConfig): string {
  return `# Workspace Guide

This workspace belongs to **${cfg.agentName}**.

## Source of truth
- Read \`MEMORY.md\` first on startup. It is the editable short-term active context for this agent.
- Keep shared-vault entry links in \`KNOWLEDGE.md\`.
- Keep task notes, experiment logs, and drafts in \`notes/\`.
- Treat this file as lightweight workspace guidance, not a hardcoded persona prompt.

## Current defaults
- Agent ID: \`${cfg.agentId}\`
- Model: \`${cfg.modelId}\`
- Role hint: ${roleLabels[cfg.role]}
- Backend: \`${cfg.serverUrl}\`
- Default channel: \`${cfg.channelName}\`

## Working rules
- Prefer changing \`MEMORY.md\`, \`KNOWLEDGE.md\`, or files under \`notes/\` when behavior should evolve.
- Keep important conclusions in workspace files before exiting.
- If the role changes, update \`MEMORY.md\` instead of adding more hardcoded instructions to code.

## Team context
${cfg.teamContext}
`
}

function buildMemory(cfg: AgentWorkspaceConfig): string {
  return buildInitialMemoryIndex({
    agentName: cfg.agentName,
    roleLabel: roleSeedFor(cfg.role),
    description: cfg.description ?? null,
    customPrompt: cfg.customPrompt,
    serverUrl: cfg.serverUrl,
    channelName: cfg.channelName,
    teamContext: cfg.teamContext,
    activeContext: 'First startup.',
  })
}

function buildKnowledge(cfg: AgentWorkspaceConfig): string {
  const focusMap: Partial<Record<AgentRole, string>> = {
    coordinator:    '组织知识维护、质量评估、组织演化、全局视角',
    'tech-lead':    '任务规划、技术方案、子任务拆解与指派、结果汇总',
    ops:            '系统监控、任务巡检、催办、卡住检测、日志分析',
    investigator:   '课程学习、论文阅读、源码分析、技术调研',
    developer:      '代码实现、系统原型、工程文档',
    profiler:       'benchmark 脚本、多轮对比实验、profiling',
    observer:       'WandB loss 观测、Prometheus 指标、GPU 监控',
    'exp-kernel':   'GPU kernel 性能（GEMM/Attention/Triton）',
    'exp-training': '大模型训练（分布式/RLHF/SFT/数据实验）',
    'exp-inference': '推理系统（SGLang/vLLM/KV cache/投机采样）',
  }
  const focus = focusMap[cfg.role] ?? '任务拆解、实验设计、recipe 编排、研究资料索引'
  const commonLinks = [
    '- `00_hub/00_INDEX.md` — 全局导航',
    '- `00_hub/02_CONVENTIONS.md` — frontmatter、命名、路由、检索规则',
    '- `00_hub/03_SPRINT.md` — 当前研究重点',
    '- `00_hub/04_ARCHITECTURE.md` — Vault 架构',
    '- `00_hub/05_WORKFLOW.md` — agent memory / vault / project / skill 边界',
    '- `00_hub/skills/docs/00_index.md` — skill / principle 入口',
  ]
  const roleLinks: Partial<Record<AgentRole, string[]>> = {
    coordinator: [
      '- `00_hub/01_AGENTS.md` — 团队结构',
      '- `02_project/{领域}/{项目名}/05_insights/` — 看项目沉淀和可复用模式',
      '- `06_notes/experiences/` — 经验复盘和组织改进',
    ],
    'tech-lead': [
      '- `02_project/{领域}/{项目名}/03_engineering/` — 工程开发和技术方案',
      '- `02_project/{领域}/{项目名}/02_experiments/` — 实验记录',
      '- `00_hub/01_AGENTS.md` — 团队结构和可用 agent',
    ],
    ops: [
      '- `04_routine/` — 日报、巡检、运营记录',
      '- `06_notes/bugfix/` — 故障和恢复经验',
    ],
    investigator: [
      '- `03_knowlage/02_reading_not/` — 文章/网文总结',
      '- `03_knowlage/01_lecture_note/` — 视频/课程笔记',
      '- `03_knowlage/04_papers/` — 论文',
      '- `03_knowlage/05_surveys/` — 网上调研',
      '- `02_project/{领域}/{项目名}/01_codewalk/` — 项目架构和源码走读',
    ],
    developer: [
      '- `02_project/{领域}/{项目名}/03_engineering/` — 工程开发、debug、变更',
      '- `02_project/{领域}/{项目名}/06_handbook/` — 环境配置、复现步骤、常见 bug 手顺',
    ],
    profiler: [
      '- `02_project/{领域}/{项目名}/04_performance/` — benchmark / profiling / 对比',
      '- `02_project/{领域}/{项目名}/06_handbook/` — 环境和复现步骤',
    ],
    observer: [
      '- `04_routine/` — 巡检和日报',
      '- `02_project/{领域}/{项目名}/04_performance/` — 指标和异常归档',
    ],
    'exp-kernel': [
      '- `02_project/{领域}/{项目名}/02_experiments/` — 实验记录',
      '- `02_project/{领域}/{项目名}/06_handbook/` — 复现方法和环境配置',
    ],
    'exp-training': [
      '- `02_project/{领域}/{项目名}/02_experiments/` — 训练实验记录',
      '- `02_project/{领域}/{项目名}/06_handbook/` — 环境配置和复现步骤',
    ],
    'exp-inference': [
      '- `02_project/{领域}/{项目名}/02_experiments/` — 推理实验记录',
      '- `02_project/{领域}/{项目名}/06_handbook/` — 配置、复现、排障手顺',
    ],
  }
  const links = [...commonLinks, ...(roleLinks[cfg.role] ?? [])]

  return `# ${cfg.agentName} Knowledge

## 规则
- 这里只放 vault 相对路径链接 + 一行命中提示，不复制共享正文
- 需要细节时，再去读对应 vault 文件
- 默认不读其他 agent 的私有 \`MEMORY.md\`

## 关注域
- ${focus}

## Vault 入口
${links.join('\n')}

## 产出规范
- 所有文档必须有 frontmatter（title, date, agent, type, tags, triggers, status）
- type: knowledge | experience | skill | insight | principle
- triggers: 检索触发词列表，agent 遇到相关场景时可命中
- 实验需记录成功/失败日志 + 人类可复现的 runbook
- 踩过的坑和技术决策写入项目的 05_insights/
- 配置手顺/复现方法写入项目的 06_handbook/
- 详见 \`00_hub/02_CONVENTIONS.md\`

## 日报（Routine）规则
- 每天开始工作时，检查 \`04_routine/{year}/{month}/{week}/{date}/\` 是否有当日日报
- 如果没有，按模板 \`00_hub/04_templates/daily-routine.md\` 创建，文件名：\`routine-{date}-{agent_name}.md\`
- 工作过程中持续更新日报：完成了什么、产出路径、阻塞/风险
- 每个 agent 独立维护自己的日报

## 文件命名规范
所有产出文件必须遵循：\`{前缀}-{YYYY-MM-DD}-{标题}.md\`
- 前缀：exp / debug / dev / bugfix / paper / survey / procedure / decision / flash / retro
- 标题：agent 自行总结，kebab-case，不超过 5 词，必须具体有辨识度
- 禁止泛称：notes / summary / misc / experiment-1 / bug-fix
- 详见 00_hub/02_CONVENTIONS.md

## 内容路由表（重要！）
⚠️ 所有产出必须写到 vault 对应目录，不要写到自己的 agents/ 私有目录。路径都是 vault 根目录的相对路径。
| 内容类型 | 目标路径 |
|----------|----------|
| 文章/网文总结 | \`03_knowlage/02_reading_not/\` |
| 视频/课程笔记 | \`03_knowlage/01_lecture_note/{主题}/\` |
| 论文阅读 | \`03_knowlage/04_papers/\` |
| 网上现搜调研 | \`03_knowlage/05_surveys/\` |
| 操作手册 | \`03_knowlage/03_manual/\` |
| 项目工程文档 | \`02_project/{领域}/{项目名}/03_engineering/\` |
| 实验记录 | \`02_project/{领域}/{项目名}/02_experiments/\` |
| 性能分析 | \`02_project/{领域}/{项目名}/04_performance/\` |
| 日报 | \`04_routine/{year}/{month}/{week}/{date}/\` |
| 闪念便签 | \`05_notes/flash/\` |

## 使用原则
- 私有短期上下文放 \`MEMORY.md\`
- 阶段性草稿和记录放到 \`notes/\`（仅临时草稿）
- 正式产出必须按上面路由表写到 vault 对应目录
- 可执行流程进 \`00_hub/skills/\`
- 行为边界/能做不能做进 principle
`
}

function buildNotesIndex(cfg: AgentWorkspaceConfig): string {
  return `# ${cfg.agentName} Notes

这里放阶段性材料，而不是长期压缩记忆。

## 适合放进 notes 的内容
- 实验记录
- 阅读笔记
- 方案草稿
- 复现步骤
- review 备注

## 不要放进 notes 的内容
- 角色长期身份与职责（放 \`MEMORY.md\`）
- 长期知识大库入口（放 \`KNOWLEDGE.md\`）
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
