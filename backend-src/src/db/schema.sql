-- Red Shrimp Lab — PostgreSQL Schema
-- Run: psql -U postgres -d redshrimp -f schema.sql

-- ──────────────── Extensions ────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────── Users ────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(100) NOT NULL,
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT false,
  role            VARCHAR(20) NOT NULL DEFAULT 'member',  -- owner/admin/member
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────── Refresh Tokens ────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON refresh_tokens (user_id);

-- ──────────────── Servers ────────────────
CREATE TABLE IF NOT EXISTS servers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(100) NOT NULL UNIQUE,
  owner_id    UUID NOT NULL REFERENCES users(id),
  plan        VARCHAR(20) NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        VARCHAR(20) NOT NULL DEFAULT 'member',
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (server_id, user_id)
);

-- ──────────────── Channels ────────────────
CREATE TABLE IF NOT EXISTS channels (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,
  description  TEXT,
  type         VARCHAR(10) NOT NULL DEFAULT 'channel',  -- channel/dm
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (server_id, name)
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id)  ON DELETE CASCADE,
  agent_id    UUID,  -- FK added after agents table
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_of_user_or_agent CHECK (
    (user_id IS NOT NULL AND agent_id IS NULL) OR
    (user_id IS NULL AND agent_id IS NOT NULL)
  )
);

-- ──────────────── Messages ────────────────
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_id    UUID NOT NULL,  -- user or agent id
  sender_type  VARCHAR(10) NOT NULL,  -- human/agent
  sender_name  VARCHAR(100) NOT NULL,
  content      TEXT NOT NULL,
  seq          BIGINT NOT NULL,  -- per-channel sequence number
  attachments  JSONB NOT NULL DEFAULT '[]',   -- [{file_id, filename, mime_type, url}]
  mentions     JSONB NOT NULL DEFAULT '[]',   -- [{id, name, type}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON messages (channel_id, seq DESC);

-- Per-channel message sequence (for ordering)
CREATE TABLE IF NOT EXISTS channel_sequences (
  channel_id  UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  last_seq    BIGINT NOT NULL DEFAULT 0
);

-- Unread counts per user per channel
CREATE TABLE IF NOT EXISTS channel_reads (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- ──────────────── Machines ────────────────
CREATE TABLE IF NOT EXISTS machines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  api_key_hash    TEXT NOT NULL UNIQUE,
  api_key         TEXT,                        -- raw key (shown on connect page)
  status          VARCHAR(20) NOT NULL DEFAULT 'offline',  -- online/offline
  hostname        TEXT,
  os              TEXT,
  daemon_version  TEXT,
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────── Agents ────────────────
CREATE TABLE IF NOT EXISTS agents (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id                   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  machine_id                  UUID REFERENCES machines(id),
  name                        VARCHAR(100) NOT NULL,
  description                 TEXT,
  -- Model config
  model_provider              VARCHAR(30) NOT NULL DEFAULT 'anthropic',  -- anthropic/moonshot/openai
  model_id                    VARCHAR(100) NOT NULL DEFAULT 'claude-sonnet-4-6',
  heartbeat_model_id          VARCHAR(100),  -- cheaper model for heartbeat, null = use model_id
  heartbeat_interval_minutes  INT NOT NULL DEFAULT 30,
  reasoning_effort            VARCHAR(10) NOT NULL DEFAULT 'medium',
  -- Runtime
  runtime                     VARCHAR(30) NOT NULL DEFAULT 'claude',
  pid                         INT,          -- OS process ID when running
  status                      VARCHAR(20) NOT NULL DEFAULT 'offline',  -- offline/starting/online/error
  activity                    VARCHAR(20),  -- idle/thinking/working/writing
  activity_detail             TEXT,
  last_heartbeat_at           TIMESTAMPTZ,
  -- Workspace
  workspace_path              TEXT,         -- e.g. ~/JwtVault/slock-clone/
  -- Role / hierarchy
  role                        VARCHAR(20) DEFAULT 'general',       -- general/developer/tester/pm/ops
  parent_agent_id             UUID REFERENCES agents(id) ON DELETE SET NULL,
  -- Timestamps
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add agent FK to channel_members
ALTER TABLE channel_members
  ADD CONSTRAINT fk_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;

-- ──────────────── Agent Logs ────────────────
CREATE TABLE IF NOT EXISTS agent_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id      UUID,           -- links to agent_runs
  level       VARCHAR(10) NOT NULL,  -- INFO/WARN/ERROR/ACTION/FILE/SPAWN
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON agent_logs (agent_id, created_at DESC);
CREATE INDEX ON agent_logs (run_id, created_at);

-- ──────────────── Agent Runs (sub-agent tracking) ────────────────
CREATE TABLE IF NOT EXISTS agent_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_run_id     UUID REFERENCES agent_runs(id),
  task_id           UUID,  -- FK added after tasks table
  status            VARCHAR(20) NOT NULL DEFAULT 'running',  -- running/completed/handoff/failed
  tokens_used       INT NOT NULL DEFAULT 0,
  tokens_limit      INT NOT NULL DEFAULT 200000,
  context_snapshot  JSONB,  -- saved state on handoff
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ
);
CREATE INDEX ON agent_runs (agent_id, started_at DESC);
CREATE INDEX ON agent_runs (parent_run_id);

-- ──────────────── Tasks ────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  number          INT NOT NULL,  -- per-channel task number (#t1, #t2, ...)
  status          VARCHAR(20) NOT NULL DEFAULT 'open',  -- open/claimed/reviewing/completed
  claimed_by_id   UUID,  -- user or agent id
  claimed_by_type VARCHAR(10),  -- human/agent
  claimed_by_name VARCHAR(100),
  claimed_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, number)
);
CREATE INDEX ON tasks (channel_id, status);

-- Per-channel task sequence
CREATE TABLE IF NOT EXISTS task_sequences (
  channel_id  UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  last_num    INT NOT NULL DEFAULT 0
);

-- Add task FK to agent_runs
ALTER TABLE agent_runs
  ADD CONSTRAINT fk_task FOREIGN KEY (task_id) REFERENCES tasks(id);

-- ──────────────── Task ↔ Documents ────────────────
CREATE TABLE IF NOT EXISTS task_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  doc_path    TEXT NOT NULL,   -- relative to vault root
  doc_name    TEXT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'unread',  -- writing/unread/read
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Track when users have read documents
CREATE TABLE IF NOT EXISTS doc_reads (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_path   TEXT NOT NULL,
  read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, doc_path)
);

-- ──────────────── Task ↔ Skills ────────────────
CREATE TABLE IF NOT EXISTS task_skills (
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  skill_name  VARCHAR(100) NOT NULL,
  PRIMARY KEY (task_id, skill_name)
);

-- ──────────────── Skills ────────────────
CREATE TABLE IF NOT EXISTS skills (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  content     TEXT NOT NULL,  -- the skill prompt/instructions
  is_local    BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (server_id, name)
);

-- ──────────────── Files (uploads) ────────────────
CREATE TABLE IF NOT EXISTS files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  uploader_id  UUID NOT NULL,
  uploader_type VARCHAR(10) NOT NULL DEFAULT 'human',
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  storage_path TEXT NOT NULL,  -- server local path or OSS key
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────── Cron Jobs ────────────────
CREATE TABLE IF NOT EXISTS cron_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id       UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  cron_expr      VARCHAR(100) NOT NULL,
  prompt         TEXT NOT NULL,
  channel_id     UUID REFERENCES channels(id),
  model_override VARCHAR(100),
  enabled        BOOLEAN NOT NULL DEFAULT true,
  last_run_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ──────────────── Agent Channel Read Positions ────────────────
-- Separate from channel_reads (which is for human users)
CREATE TABLE IF NOT EXISTS agent_channel_reads (
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, channel_id)
);

-- ──────────────── LLM Provider Keys ────────────────
CREATE TABLE IF NOT EXISTS provider_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id    UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  provider     VARCHAR(50) NOT NULL,   -- anthropic/moonshot/openai
  key_env_ref  VARCHAR(100) NOT NULL,  -- env var name, never store raw key
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (server_id, provider)
);
