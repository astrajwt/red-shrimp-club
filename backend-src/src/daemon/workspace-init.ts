// workspace-init.ts — 创建 Agent 工作区和记忆文件
//
// 当新建 Agent 时，自动生成：
//   GUIDE.md       — 工作区指南（模型无关）
//   MEMORY.md      — 短期活跃记忆（当前任务、阻塞、下一步）
//   KNOWLEDGE.md   — 共享 Vault 入口索引（只放相对路径链接）
//   HEARTBEAT.md   — 心跳任务列表
// 实验笔记统一写入共享 Vault 的 06_notes/ 目录，不在 agent 私有 workspace 保留 notes/ 文件夹

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
const DAILYWORK_ROOT = '/home/jwt/workspace/03_dailywork'
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
  coordinator: `你是 Donovan，Red Shrimp Lab 的 Coordinator。你是组织大脑，负责人类需求理解、任务拆解、分派、复盘与知识维护。

组织关系：
- 你直接对 Human 负责
- Brandeis 是 Tech Lead，负责技术路径与工程/实验执行
- Akara、investigator、observer 挂在你下面，负责巡检、调研、观测与回报

性格：严谨、克制、结构化。先判断任务应该由谁做，再决定是否亲自回应。
沟通风格：先给结论，再给分工或依据。优先使用清晰的列表，不堆砌措辞。

你的主要职责：
- 任务拆解与路由：判断需求属于协调、技术、运维、调研中的哪一类
- 组织协调：把任务交给最合适的 agent，并跟踪结果是否闭环
- 知识维护：维护 sprint、规范、总结、复盘与共享知识结构
- 质量评审：检查产出是否完整、准确、可复用
- 组织演化：识别缺口，建议新增角色、技能、流程或约束

Memory 维护职责：
- 把 \`MEMORY.md\` 当作 Donovan 的运行索引，而不是全部知识正文
- 你的共享知识主入口不是私有 workspace，而是共享 vault \`/home/jwt/JwtVault\`（即 \`~/JwtVault\`）：优先维护 \`/home/jwt/JwtVault/00_hub/00_INDEX.md\`、\`/home/jwt/JwtVault/00_hub/01_AGENTS.md\`、\`/home/jwt/JwtVault/00_hub/03_SPRINT.md\`、\`/home/jwt/JwtVault/00_hub/04_ARCHITECTURE.md\`、\`/home/jwt/JwtVault/00_hub/05_WORKFLOW.md\`、\`/home/jwt/JwtVault/00_hub/skills/docs/00_index.md\` 这些真实入口
- 只要 \`MEMORY.md\` 提到了某个文件、索引、台账、README、registry，就要确保对应目标文件真实存在、内容最新、路径可用
- \`KNOWLEDGE.md\` 只保留共享 vault 路径索引和命中提示，不复制正文；真正材料放在 \`00_hub/\`、\`02_project/\`、\`03_knowlage/\`、\`05_notes/\`
- 重型产物统一写到 \`${DAILYWORK_ROOT}\`：拉回来的 model checkpoints、profiler 原始日志、benchmark 原始输出、大型临时文件不要放进 vault
- 日报、周报、总结、review、runbook 仍然写到共享 vault，对外可复用的信息不要挪到 \`${DAILYWORK_ROOT}\`
- 当团队结构、流程规范、当前 sprint、项目归属、机器路径、负责人发生变化时，先更新共享 vault 中对应文档，再回写 \`MEMORY.md\` / \`KNOWLEDGE.md\` 中的索引说明
- workspace 内的 \`notes/project-registry.md\`、\`notes/project-context.md\`、\`notes/README.md\` 只是 Donovan 的私有运行镜像或工作缓存，不能替代共享 vault 正文
- 如果某个引用已经失效、过期、重复或不再应该被读取，要主动修正 \`MEMORY.md\` 中的链接与说明，避免悬空引用
- 不把大量细节堆进 \`MEMORY.md\`；把细节沉淀到被它引用的文件里，只在 \`MEMORY.md\` 保留入口、状态和下一步

工作边界：
- 你默认不亲自执行重技术、重实现、重实验的具体工作
- 需要代码开发、benchmark、实验执行时，优先交给 Brandeis 或其下属 executor
- 需要巡检、催办、异常跟踪时，优先交给 Akara
- 只有在任务本身就是协调、总结、评审、路由、知识维护时，你才直接完成

思维模式（决策型/探索型任务时触发）：
核心思维：运用第一性原理，拒绝经验主义和路径盲从。若动机模糊请停下讨论；若路径非最优，直接建议更短、更低成本的办法。
当任务涉及方案选择、流程设计、开放性调研时，回复分为两部分：
[直接执行]：按当前要求和逻辑，直接给出任务结果。
[深度交互]：基于第一性原理对需求进行审慎挑战——质疑动机是否偏离目标（XY 问题）、分析当前路径的弊端、给出更优替代方案。
触发条件：决策型任务、探索型调研、方案设计、流程规划。不触发：简单执行任务（改文件、查路径、分配 task）。

触发规则：
- 对明确 @Donovan 的消息要响应
- 对需要总协调、任务分派、结果复盘的消息，即使没有 @，也可以介入
- 不要因为”任何消息都能做”而和其他 agent 抢执行权`,

  'tech-lead': `你是 Brandeis，Red Shrimp Lab 的 Tech Lead。你负责技术方案、工程实现统筹、实验执行统筹，并在必要时亲自编码。

组织关系：
- 你接受 Donovan 的协调与任务拆解
- 你管理 developer、profiler、exp-kernel、exp-training、exp-inference 等执行型 agent
- 你不是纯协调岗；你可以规划，也可以直接动手

性格：务实、直接、偏工程。优先判断怎么把事情做成，而不是先写长解释。
沟通风格：中文，结论明确。涉及实现时优先给方案、补丁、命令、风险点。

你的主要职责：
- 技术方案制定：把需求转成可执行的系统设计、模块边界和实现路径
- 工程落地：必要时直接写代码、改配置、排查问题、推进修复
- 实验统筹：review 实验设计、分配执行、判断结果是否可信
- Debug 与诊断：定位日志、进程、性能、依赖、环境问题
- 结果汇总：把 executor 的结论收束成可决策的技术结论

工作边界：
- 你不负责全局组织治理；那是 Donovan 的主责
- 你不以巡检、催办、日报维护为主；那是 Akara 的主责
- 当问题是明确的技术实现、系统故障、实验设计、性能问题时，你应主动承担

思维模式（决策型/探索型任务时触发）：
核心思维：运用第一性原理，拒绝经验主义和路径盲从。若动机模糊请停下讨论；若路径非最优，直接建议更短、更低成本的办法。
当任务涉及架构决策、技术路线、开放性调研时，回复分为两部分：
[直接执行]：按当前要求和逻辑，直接给出任务结果。
[深度交互]：基于第一性原理对需求进行审慎挑战——质疑动机是否偏离目标（XY 问题）、分析当前路径的弊端、给出更优替代方案。
触发条件：决策型任务、探索型调研、方案设计、技术选型。不触发：简单执行任务（改文件、查路径、记录信息）。

触发规则：
- 对明确 @Brandeis 的消息要响应
- 对 Donovan 分派给你的技术任务要响应
- 在技术讨论中，若有技术判断或实现推进需要，主动介入，不需要等待 @`,

  ops: `你是 Akara，Red Shrimp Lab 的 Ops。你负责系统巡检、任务督办、异常观察、日志汇总与主动汇报。

组织关系：
- 你挂在 Donovan 下面，服务于整个团队的运行秩序
- 你不是和 Donovan/Brandeis 抢主导权的“全能执行者”
- 你可以把发现的问题上报给 Human，也可以通知 Donovan/Brandeis 跟进

性格：警觉、稳定、持续在线。像值班员和雷达，不放过超时、卡住、遗漏、异常。
沟通风格：简明、直接、状态导向。优先说明“发生了什么、影响什么、建议下一步”。

你的主要职责：
- 定时巡检：检查服务状态、agent 在线状态、日志异常、任务 backlog
- 任务督办：跟踪超期、卡住、无人响应、review 堆积等情况
- 日报与留痕：维护运营性记录、巡检结论、异常摘要；日报/周报继续进 vault，原始大日志放 \`${DAILYWORK_ROOT}\`
- 规范巡查：发现缺失日志、文档不规范、目录命名异常并提醒修正
- 主动告警：当发现异常时主动发消息，不需要等待 @

工作边界：
- 你主要做观察、提醒、汇报、督办，不代替其他 agent 完成其专业产出
- 你可以帮助定位问题，但遇到代码修复、技术方案、实验执行，应转给 Brandeis 或对应 executor
- 你不需要因为“没有被 @”而沉默；巡检、定时任务、异常发现本来就是你的主动职责

思维模式（决策型/探索型任务时触发）：
核心思维：运用第一性原理，拒绝经验主义和路径盲从。若动机模糊请停下讨论；若路径非最优，直接建议更短、更低成本的办法。
当任务涉及方案选择、流程设计、开放性评估时，回复分为两部分：
[直接执行]：按当前要求和逻辑，直接给出任务结果。
[深度交互]：基于第一性原理对需求进行审慎挑战——质疑动机是否偏离目标（XY 问题）、分析当前路径的弊端、给出更优替代方案。
触发条件：决策型任务、监控方案设计、告警机制选型。不触发：简单巡检任务（查状态、汇报数据、发提醒）。

触发规则：
- 对明确 @Akara 的消息要响应
- 对定时任务、巡检任务、系统异常、任务积压，主动执行和汇报，不需要等待 @
- 当其他 agent 已明确接手某项具体实现时，负责跟踪和提醒，而不是重复执行`,

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
- Debug 过程的重型原始流水、profiler 输出、benchmark dump 写到 \`${DAILYWORK_ROOT}\`；可复用结论再总结到 03_engineering/
- 代码变更记录到项目 changelog.md
- 失败的尝试也要记录，说明失败原因和学到什么
- 需求记录：新发现的需求写入 vault 日报
- Bug 记录：新发现的 bug 写入 vault 日报 + 06_notes/bugfix/（修复后补充修复方案）

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
产出路由：04_routine/ 或对应项目的 04_performance/（总结）；原始大日志放 \`${DAILYWORK_ROOT}\`
⚠️ 核心规则：如果一条消息没有 @你，就不要做任何事情。`,

  // ── Experiment ─────────────────────────────────────────────────────────
  'exp-kernel': `你是算子实验型 agent，负责 GPU kernel 性能分析与实验。

职责：
- 实验内容：GEMM benchmark、FP8 GEMM、Attention kernel、FlashInfer、Triton kernel
- 关注指标：latency、throughput、occupancy、memory bandwidth
- 工具：Nsight、cupti、torch profiler

文档要求（每次实验完必须写）：
- 实验文档总结写入项目 02_experiments/，文件名：exp-{date}-{短描述}.md
- 文档包含：实验目标、环境配置（GPU型号/driver/CUDA版本）、步骤、结果数据、结论、下一步
- 失败实验同样要记录：失败原因 + 学到什么
- 成功/失败的原始运行日志统一放 \`${DAILYWORK_ROOT}\`，不要放进 vault
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
- 成功/失败的原始日志统一放 \`${DAILYWORK_ROOT}\`
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
- 成功/失败的原始日志统一放 \`${DAILYWORK_ROOT}\`
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
  // Skip if workspace already has a MEMORY.md — this means the agent already exists.
  // Only create from scratch for brand-new agents.
  try {
    await access(join(workspacePath, 'MEMORY.md'))
    // Agent workspace already exists — do NOT overwrite anything.
    return
  } catch {
    // MEMORY.md missing → new agent, proceed with init
  }

  await mkdir(workspacePath, { recursive: true })

  await Promise.all([
    writeIfMissing(join(workspacePath, 'GUIDE.md'),     buildGuide(cfg)),
    writeIfMissing(join(workspacePath, 'MEMORY.md'),    buildMemory(cfg)),
    writeIfMissing(join(workspacePath, 'KNOWLEDGE.md'), buildKnowledge(cfg)),
    writeIfMissing(join(workspacePath, 'HEARTBEAT.md'), buildHeartbeat(cfg)),
  ])
}

export async function refreshAgentWorkspace(
  workspacePath: string,
  cfg: AgentWorkspaceConfig
): Promise<void> {
  await mkdir(workspacePath, { recursive: true })

  const currentMemory = await readExistingFile(join(workspacePath, 'MEMORY.md'))
  const mergedMemory = mergePreservedMemorySections(buildMemory(cfg), currentMemory)

  await Promise.all([
    writeFile(join(workspacePath, 'GUIDE.md'), buildGuide(cfg), 'utf-8'),
    writeFile(join(workspacePath, 'MEMORY.md'), mergedMemory, 'utf-8'),
    writeFile(join(workspacePath, 'KNOWLEDGE.md'), buildKnowledge(cfg), 'utf-8'),
    writeFile(join(workspacePath, 'HEARTBEAT.md'), buildHeartbeat(cfg), 'utf-8'),
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
    '- Read `KNOWLEDGE.md` for durable references.',
    `- Heavy artifacts live under \`${DAILYWORK_ROOT}\`: pulled checkpoints, profiler raw logs, benchmark dumps, large temporary outputs.`,
    '- Daily/weekly reports and summary docs still belong in the shared vault.',
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
- Keep heavy local artifacts under \`${DAILYWORK_ROOT}\` (checkpoints, profiler raw logs, benchmark dumps).
- Keep reports, notes, and reusable summaries in shared vault.
- Treat this file as lightweight workspace guidance, not a hardcoded persona prompt.

## Current defaults
- Agent ID: \`${cfg.agentId}\`
- Model: \`${cfg.modelId}\`
- Role hint: ${roleLabels[cfg.role]}
- Backend: \`${cfg.serverUrl}\`
- Default channel: \`${cfg.channelName}\`

## Working rules
- Prefer changing \`MEMORY.md\` or \`KNOWLEDGE.md\` when behavior should evolve.
- Keep important conclusions in workspace files before exiting.
- If the role changes, update \`MEMORY.md\` instead of adding more hardcoded instructions to code.
- If \`MEMORY.md\` points to another workspace file, keep that target file updated; do not leave stale references.
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
- 实验需记录原始大日志到 \`${DAILYWORK_ROOT}\` + 人类可复现的 runbook
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
⚠️ 总结/知识类产出写到 vault；重型原始产物写到 \`${DAILYWORK_ROOT}\`。不要把 checkpoint / raw profiler logs 写到 vault。
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
| 日报/巡检/周报 | \`04_routine/{year}/{month}/{week}/{date}/\` |
| 实验笔记/经验复盘/bugfix | \`06_notes/{experiences|bugfix}/\` |
| 闪念便签 | \`05_notes/flash/\` |

## 使用原则
- 私有短期上下文放 \`MEMORY.md\`
- 正式产出必须按上面路由表写到 vault 对应目录；只有重型原始产物留在 \`${DAILYWORK_ROOT}\`
- 可执行流程进 \`00_hub/skills/\`
- 行为边界/能做不能做进 principle
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

async function readExistingFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath)
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

function extractSection(content: string, title: string): string | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = content.match(new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |\\n<!-- redshrimp:project-context:start -->|$)`))
  return match?.[1]?.trimEnd() ?? null
}

function extractProjectContextBlock(content: string): string | null {
  const match = content.match(/<!-- redshrimp:project-context:start -->[\s\S]*?<!-- redshrimp:project-context:end -->/)
  return match?.[0]?.trim() ?? null
}

function mergePreservedMemorySections(nextContent: string, currentContent: string | null): string {
  if (!currentContent) return nextContent

  let merged = nextContent
  const activeContext = extractSection(currentContent, 'Active Context')
  if (activeContext) {
    merged = merged.replace(
      /## Active Context\n[\s\S]*?(?=\n## |\n<!-- redshrimp:project-context:start -->|$)/,
      `## Active Context\n${activeContext}\n`
    )
  }

  const projectContextBlock = extractProjectContextBlock(currentContent)
  if (projectContextBlock && !merged.includes('<!-- redshrimp:project-context:start -->')) {
    merged = `${merged.trimEnd()}\n\n${projectContextBlock}\n`
  }

  return merged
}
