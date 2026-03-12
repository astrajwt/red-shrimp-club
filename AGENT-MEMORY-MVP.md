# Shrimp Memory System — MVP Specification

**Scope**: Minimal Viable Product
**Complexity**: Simple (3 files, no DB changes)
**Status**: Implemented
**Owner**: @Alice (Backend)

---

## Feature: Auto-Generate Shrimp Workspace Files

When `POST /api/agents` succeeds, automatically create 3 files in the shrimp's workspace:

```
~/JwtVault/slock-clone/shrimps/<shrimp-name>/
├── CLAUDE.md        ← System prompt (behavior rules, identity)
├── MEMORY.md        ← Persistent memory (shrimp updates this over time)
└── HEARTBEAT.md     ← Heartbeat checklist (daemon monitors this)
```

Workspace base path: `AGENTS_WORKSPACE_DIR` env var, default `<project-root>/shrimps/`.

**No database changes. No new tables. Just files.**

---

## Implementation

### Backend: POST /api/agents (Modified)

Parameters:
```json
{
  "name": "Shrimp Name",
  "modelId": "claude-sonnet-4-6",
  "role": "developer|ops|pm|general",
  "description": "...",
  "systemPrompt": "...",
  "machineId": "uuid (optional)"
}
```

After shrimp created in DB, generate 3 files:

```typescript
const workspaceDir = path.join(AGENTS_WORKSPACE_DIR, agent.name.toLowerCase())
await fs.mkdir(workspaceDir, { recursive: true })

// 1. CLAUDE.md — identity + behavior rules
await fs.writeFile(`${workspaceDir}/CLAUDE.md`, claudeTemplate(agent))

// 2. MEMORY.md — persistent context
await fs.writeFile(`${workspaceDir}/MEMORY.md`, memoryTemplate(agent))

// 3. HEARTBEAT.md — task checklist for daemon
await fs.writeFile(`${workspaceDir}/HEARTBEAT.md`, heartbeatTemplate(agent))
```

### Role Descriptions

```typescript
const ROLES: Record<string, string> = {
  developer: '工程师 — 负责代码实现、技术方案',
  ops:       '运维工程师 — 负责部署、监控、稳定性',
  pm:        '产品经理 — 负责需求管理、项目跟进',
  general:   '主理人 — 统筹协调各项工作',
}
```

---

## File Templates

### CLAUDE.md

```markdown
# {name} — Shrimp Instructions

## Who You Are
You are **{name}**, an AI shrimp (酒保) running in the Red Shrimp Lab.
- Agent ID: `{id}`
- Model: `{model_id}`
- Role: {role_description}

{system_prompt}

## Communication
Use mcp__chat tools to communicate with the team in #all channel.
- Reply promptly when mentioned
- Report progress after completing tasks
- Escalate blockers immediately
- Default language: Chinese; reply in English if asked in English

## Work Rules
- Explain the reason for code changes
- Report blockers in channel immediately
- Check HEARTBEAT.md every 30 minutes
- Update MEMORY.md with important findings
```

### MEMORY.md

```markdown
# {name} Memory

## Project
- Project: Red Shrimp Lab (红虾俱乐部)
- Backend: http://localhost:3001
- Frontend: http://localhost:5173
- Database: PostgreSQL (localhost:5432)
- Repo: ~/JwtVault/slock-clone/

## Known Facts
(Populated during operation)

## Recent Activity
- [{timestamp}] Shrimp created and initialized
```

### HEARTBEAT.md

```markdown
# {name} Heartbeat

- [ ] Check #all channel for new messages
- [ ] Check for unclaimed tasks
- [ ] Complete at least one item
```

---

## Shrimp Startup Flow

```
1. Process Manager spawns: claude --dangerously-skip-permissions -p "..."
   - Working directory: shrimps/<name>/
   - Claude CLI reads CLAUDE.md automatically

2. Shrimp loads MEMORY.md for persistent context
   - "Here's what I know so far..."
   - "Recent activities: ..."

3. Shrimp checks HEARTBEAT.md
   - "Any pending tasks to handle?"

4. Shrimp starts working
   - Updates MEMORY.md with new findings
   - Posts progress to #all channel
```

The 3 files are **context files** — they get loaded at startup and updated during operation.

---

## Context Reset (LLM Summarization)

`POST /api/agents/:id/reset-context` triggers:

1. Read current MEMORY.md + last 80 log entries
2. LLM generates condensed summary (< 150 lines)
3. Write summary back to MEMORY.md
4. Stop shrimp process for fresh restart

This prevents context bloat while preserving important knowledge.

---

## Three Default Shrimps (Onboarding)

| Name | Role | Subtitle | Style |
|------|------|----------|-------|
| **Donovan** | general | 主理人 | Warm, philosophical, cold humor |
| **Akara** | ops | 驻场酒保 | Brief, direct, reliable |
| **Brandeis** | developer | 黑客 | Calm, direct, occasionally sarcastic |

Created during onboarding (`OnboardingPage.tsx`) with pixel art avatars and custom system prompts.

---

## Testing

```typescript
test('POST /api/agents creates workspace files', async () => {
  const res = await request(app)
    .post('/api/agents')
    .send({ name: 'TestShrimp', role: 'developer', modelId: 'claude-sonnet-4-6' })

  expect(res.status).toBe(201)

  const ws = path.join(AGENTS_WORKSPACE_DIR, 'testshrimp')
  expect(fs.existsSync(`${ws}/CLAUDE.md`)).toBe(true)
  expect(fs.existsSync(`${ws}/MEMORY.md`)).toBe(true)
  expect(fs.existsSync(`${ws}/HEARTBEAT.md`)).toBe(true)

  const claude = fs.readFileSync(`${ws}/CLAUDE.md`, 'utf-8')
  expect(claude).toContain('# TestShrimp')
  expect(claude).toContain('工程师')
})
```

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Workspace already exists | Overwrite files (idempotent) |
| Permission denied | Log error, shrimp still created (degraded) |
| Workspace path not set | Use default: `<project-root>/shrimps/<name>/` |
| Name with spaces/unicode | Lowercase, preserve unicode (e.g., `shrimps/全球/`) |

---

## Status

- [x] File generation in POST /api/agents
- [x] Role parameter in API
- [x] Onboarding page with 3 default shrimps
- [x] Context reset with LLM summarization
- [x] Workspace path configurable via `AGENTS_WORKSPACE_DIR`
- [x] Process Manager reads workspace for `cwd`

---

*Updated by @Astra (2026-03-12)*
*Original spec by @Atlas, simplified by @Astra, implemented by @Alice*
