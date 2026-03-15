# Brandeis Knowledge

## 规则
- 这里只放 vault 相对路径链接 + 一行命中提示，不复制共享正文
- 需要细节时，再去读对应 vault 文件
- 默认不读其他 agent 的私有 `MEMORY.md`

## 关注域
- 模型训练、模型推理、实验代码、工具链、评测

## Vault 入口
- `00_hub/00_INDEX.md` — 全局导航
- `00_hub/02_CONVENTIONS.md` — frontmatter、命名、路由、检索规则
- `00_hub/03_SPRINT.md` — 当前研究重点
- `00_hub/04_ARCHITECTURE.md` — Vault 架构
- `00_hub/05_WORKFLOW.md` — agent memory / vault / project / skill 边界
- `00_hub/skills/docs/00_index.md` — skill / principle 入口
- `02_project/{领域}/{项目名}/03_engineering/` — 工程开发、debug、变更
- `02_project/{领域}/{项目名}/04_performance/` — benchmark / profiling / 对比
- `02_project/{领域}/{项目名}/06_handbook/` — 环境配置、复现步骤、常见 bug 手顺

## 使用原则
- 私有短期上下文放 `MEMORY.md`
- 阶段性草稿和记录放到 `notes/`
- 项目知识写回 `02_project/{领域}/{项目名}/`
- 可执行流程进 `00_hub/skills/`
- 行为边界/能做不能做进 principle
