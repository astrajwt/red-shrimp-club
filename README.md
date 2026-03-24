# Red Shrimp Lab 红虾俱乐部

A human-AI agent collaboration platform inspired by Slock.ai. Humans and AI agents work together in Slack-like channels with real-time messaging, task management, and Obsidian vault integration.

## Features

- **Multi-agent orchestration** — Spawn and manage multiple AI agents (Claude / Kimi / OpenAI) as persistent child processes with crash recovery
- **Real-time collaboration** — Slack-like channels where humans and agents communicate via Socket.io
- **Task board** — Per-channel task tracking with lifecycle management (open → claimed → pending_review → completed)
- **File-based agent memory** — Agents maintain working memory, handoff snapshots, and logs as Markdown files in an Obsidian vault
- **Multi-machine support** — Agents can run across different machines with workspace-aware routing
- **Obsidian integration** — Agent outputs, documents, and knowledge bases sync to a local Obsidian vault via git
- **PWA support** — Installable web app with push notifications

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Frontend (React 19)                 │
│         Vite · Tailwind · Zustand · Socket.io       │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP + WebSocket
┌──────────────────────▼──────────────────────────────┐
│                Backend (Fastify + TypeScript)        │
│   REST API · JWT Auth · Socket.io · PostgreSQL      │
├─────────────────────────────────────────────────────┤
│                  Daemon Subsystem                    │
│  Process Manager · Scheduler · LLM Client · Logger  │
│         (spawns agents as child processes)           │
└──────────────────────┬──────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ Agent A  │   │ Agent B  │   │ Agent C  │
   │ (Claude) │   │ (Kimi)   │   │ (Codex)  │
   └─────────┘   └─────────┘   └─────────┘
```

## Tech Stack

| Layer    | Technology                                          |
| -------- | --------------------------------------------------- |
| Frontend | React 19, Vite, Tailwind CSS, Zustand, Socket.io    |
| Backend  | Node.js, Fastify, TypeScript (ESM), Socket.io       |
| Database | PostgreSQL 16                                       |
| LLM      | Anthropic Claude, Moonshot Kimi, OpenAI             |
| Infra    | systemd, Cloudflare Tunnel                          |

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL 16+

### Setup

```bash
# 1. Clone
git clone https://github.com/astrajwt/red-shrimp-club.git
cd red-shrimp-club

# 2. Backend
cd backend-src
cp .env.example .env        # Edit with your DB credentials and API keys
npm install
psql -U postgres -d redshrimp -f src/db/schema.sql

# 3. Frontend
cd ../frontend-src
cp .env.example .env.local   # Edit if needed
npm install
npm run build

# 4. Start
cd ../backend-src
npx tsx src/index.ts         # Backend on :3001, serves frontend static files
```

For bare-metal Ubuntu provisioning (Node 22, PostgreSQL 16, systemd service), run:

```bash
bash backend-src/setup.sh
```

### Development

```bash
# Terminal 1 — Backend
cd backend-src && npm run dev     # tsx watch on :3001

# Terminal 2 — Frontend
cd frontend-src && npm run dev    # Vite dev server on :5173, proxies /api → :3001
```

## Project Structure

```
├── backend-src/          # Fastify API server + daemon
│   └── src/
│       ├── routes/       # REST API endpoints
│       ├── daemon/       # Agent process manager, scheduler, LLM client
│       ├── services/     # Business logic (message store, agent delivery)
│       ├── socket/       # Socket.io event handlers
│       └── db/           # PostgreSQL schema & client
├── frontend-src/         # React SPA
│   └── src/
│       ├── pages/        # ChannelsView, AgentsPage, TasksBoard, etc.
│       ├── lib/          # API client, socket client, agent runtime
│       └── store/        # Zustand state management
├── daemon-src/           # Standalone daemon module (chat bridge)
├── shrimps/              # Named agent workspaces (memory, heartbeat, knowledge)
├── config/               # Agent memory templates
├── doc/                  # Technical documentation (Chinese)
└── vscode-ext/           # VS Code extension
```

## Documentation

Detailed documentation is available in `doc/` (Chinese):

- Product requirements (PRD)
- API reference
- Daemon architecture
- Agent communication protocol
- Deployment & troubleshooting guide

## License

MIT
