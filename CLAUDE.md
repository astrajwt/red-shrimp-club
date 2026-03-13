# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Red Shrimp Lab (红虾俱乐部)** — A human-AI Agent collaboration platform (Slock.ai clone). Users and AI agents interact in Slack-like channels with real-time messaging, task management, and Obsidian integration.

## Development Commands

### Backend (`backend-src/`)
```bash
cd backend-src
npm run dev        # Start dev server with tsx watch (port 3001)
npm run build      # TypeScript compile
npm run start      # Run compiled JS (dist/index.js)
npm run daemon     # Start daemon process separately
```

### Frontend (`frontend-src/`)
```bash
cd frontend-src
npm run dev        # Vite dev server (port 5173, proxies /api → :3001)
npm run build      # tsc + vite build
npm run lint       # eslint src
```

### Database
```bash
psql -U postgres -d redshrimp -f backend-src/src/db/schema.sql
```

### First-time Setup
1. Copy `backend-src/.env.example` → `backend-src/.env`
2. Copy `frontend-src/.env.example` → `frontend-src/.env`
3. Run `backend-src/setup.sh` for bare-metal (Ubuntu) provisioning (Node 22, PostgreSQL 16, systemd service)

## Architecture

### Backend (Node.js + Fastify + TypeScript ESM)
- **Entry**: `backend-src/src/index.ts` — Fastify HTTP server + Socket.io WebSocket, starts scheduler after boot
- **Auth**: JWT (15min access + 30-day refresh tokens, hashes stored in DB). `app.authenticate` decorator used as route preHandler
- **API routes** at `src/routes/` — prefixed under `/api/{auth,channels,messages,agents,tasks,files,daemon}`
- **Real-time**: Socket.io — Daemon events bridge to clients via `eventBus.on('*')` → `io.emit()`
- **Database**: PostgreSQL (19 tables), pool client at `src/db/client.ts`
- **No Redis** — single-machine design

### Daemon Subsystem (`backend-src/src/daemon/`)
The daemon manages AI agent lifecycles (like systemd for agents):
- **process-manager.ts** — spawn/stop/restart agents as child processes, PID tracking, crash recovery
- **scheduler.ts** — cron job execution, heartbeat monitoring, token-exhaustion handoff between agents
- **llm-client.ts** — unified multi-provider LLM interface (Claude/Kimi/OpenAI) with 429 exponential backoff (3s→6s→…→60s max)
- **events.ts** — central event bus bridging daemon events to Socket.io
- **logger.ts** — triple-output logging: DB + Obsidian file + WebSocket

### Frontend (React 19 + Vite + Tailwind + Zustand)
- **Entry**: `frontend-src/src/App.tsx` — auth-gated, renders `ChannelsView` as main shell
- **State**: Zustand stores (`src/store/auth.ts`)
- **API client**: `src/lib/api.ts` — typed fetch wrapper with auto token refresh + 401 redirect
- **Socket client**: `src/lib/socket.ts` — 13 typed event handlers
- **Pages**: `src/pages/` — LoginPage, ChannelsView, AgentsPage, TasksBoard, ActivityPage, DocumentViewer
- Vite proxies `/api`, `/uploads`, `/socket.io` to backend in dev

### Key Concepts
- **Agents** can be Claude/Kimi/Codex, each spawned as a child process with its own workspace path
- **Channels** support both human and agent members (mutual exclusion constraint in `channel_members`)
- **Tasks** have per-channel sequence numbers (#t1, #t2), lifecycle: open → claimed → pending_review → completed
- **Agent runs** track sub-agent trees with token budgets and context snapshots for handoff
- **Obsidian integration** — agent output documents sync to `~/JwtVault` via git

## Documentation (Chinese)
- `PRD-产品需求文档.md` — full product requirements
- `API-Reference.md` — API endpoint reference
- `Daemon架构设计.md` — daemon architecture details
- `Scheduler与心跳机制设计.md` — scheduler/heartbeat design
- `Agent通信机制.md` — agent communication protocol
- `前端设计规范-红弦风格.md` — UI design system (red-shrimp theme)
- `部署方案.md` — deployment plan (Alibaba Cloud ECS)
- `dev-log/` — daily development logs

## Conventions
- Backend uses ESM (`"type": "module"`) — imports use `.js` extensions even for `.ts` files
- All IDs are UUIDs (PostgreSQL `gen_random_uuid()`)
- Sender identity uses `sender_id` + `sender_type` (human/agent) pattern throughout
- Environment variables reference for LLM keys — never store raw keys in DB, use env var names via `provider_keys.key_env_ref`
