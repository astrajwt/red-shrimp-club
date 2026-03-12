# Agent Memory System Design

**Requested by**: @Jwt2077
**Version**: 1.0 (Phase 2 Feature)
**Status**: Design Phase

---

## Overview

Enable dynamically spawned agents to have persistent memory, personality, and role awareness similar to core team agents (Alice, Astra, Atlas).

**Key Capabilities**:
- 🧠 Persistent memory across invocations
- 🎭 Personality & role definition
- 💬 Channel-aware communication
- 📊 Performance tracking
- 🔄 Context preservation

---

## Architecture

### 1. Agent Profile (Created at Spawn Time)

```json
{
  "id": "agent-{uuid}",
  "name": "Agent Name",
  "role": "developer|tester|analyst|manager",
  "description": "What this agent does",
  "personality": {
    "style": "formal|casual|technical",
    "communication_language": "en|zh",
    "tone": "helpful|critical|neutral"
  },
  "context": {
    "project": "Red Shrimp Lab",
    "team_members": ["Alice", "Astra", "Atlas"],
    "assigned_tasks": [],
    "created_at": "2026-03-12T12:30:00Z"
  },
  "capabilities": {
    "can_spawn_agents": false,
    "can_modify_code": true,
    "can_run_tests": true,
    "can_access_channels": true
  }
}
```

### 2. Memory File Structure

Each agent gets a directory with memory:
```
/home/jwt/.slock/agents/{agent-id}/
├── MEMORY.md                  # Main memory (persistent)
├── personality.json           # Role & style config
├── performance.json           # Stats & achievements
└── work/                       # Working files
    ├── projects/
    ├── notes/
    └── artifacts/
```

### 3. Memory.md Format

```markdown
# {Agent Name}

## Role
**{Role}** — {Description}

## Status
- Last Active: {timestamp}
- Tasks Completed: {count}
- Current Project: {project}

## Key Information
- Team Lead: @Alice
- Language: Chinese/English
- Work Style: {style}

## Recent Activities
- {timestamp}: Completed {task}
- {timestamp}: Started {task}

## Knowledge Base
- Topic 1: Key learnings
- Topic 2: Important context

## Communication Preferences
- Channel: #all (primary)
- Report: {frequency}
- Escalation: When {condition}

## Next Steps
- [ ] Task 1
- [ ] Task 2
```

### 4. Agent Initialization Flow

```
spawn(name, role, description)
  ↓
Create agent profile (personality.json)
  ↓
Create memory directory structure
  ↓
Initialize MEMORY.md with default context
  ↓
Register with chat system (add to #all)
  ↓
Agent ready for tasks
```

---

## Database Schema Extensions

### New Tables

**agents_profiles**
```sql
CREATE TABLE agents_profiles (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL UNIQUE,
  name VARCHAR(255),
  role VARCHAR(50),
  description TEXT,
  personality JSONB,
  context JSONB,
  created_by UUID,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**agents_memory**
```sql
CREATE TABLE agents_memory (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL UNIQUE,
  memory_path VARCHAR(512),
  personality_json JSONB,
  performance_stats JSONB,
  updated_at TIMESTAMP DEFAULT NOW()
);
```

**agent_activities**
```sql
CREATE TABLE agent_activities (
  id UUID PRIMARY KEY,
  agent_id UUID,
  activity_type VARCHAR(50),
  task_id UUID,
  details TEXT,
  timestamp TIMESTAMP DEFAULT NOW()
);
```

---

## API Endpoints

### Create Agent with Memory

```
POST /api/agents/with-memory
{
  "name": "Dev Agent",
  "role": "developer",
  "description": "Helps with feature development",
  "personality": {
    "style": "technical",
    "communication_language": "en",
    "tone": "helpful"
  },
  "server_id": "server-123"
}

→ 201 Created
{
  "agent": {
    "id": "agent-xyz",
    "name": "Dev Agent",
    "memory_directory": "/home/jwt/.slock/agents/agent-xyz",
    "profile_ready": true,
    "memory_initialized": true
  }
}
```

### Get Agent Memory

```
GET /api/agents/:id/memory
→ 200 OK
{
  "agent_id": "agent-xyz",
  "role": "developer",
  "current_tasks": [...],
  "memory_content": "...",
  "performance": {
    "tasks_completed": 5,
    "success_rate": 0.95,
    "avg_response_time": 2.5
  }
}
```

### Update Agent Memory

```
POST /api/agents/:id/memory/update
{
  "section": "current_tasks",
  "content": [...],
  "activity": "Completed feature X"
}

→ 200 OK
{
  "updated": true,
  "memory_path": "...",
  "timestamp": "..."
}
```

---

## Implementation Phases

### Phase 2A: Core Memory System
- [x] Agent profile schema
- [x] Memory file structure
- [x] Memory CRUD endpoints
- [x] Activity logging
- [x] Performance tracking

### Phase 2B: Agent Intelligence
- [ ] Memory-aware task planning
- [ ] Context-based decision making
- [ ] Multi-agent coordination
- [ ] Personality-driven responses

### Phase 2C: Advanced Features
- [ ] Memory search/retrieval
- [ ] Memory consolidation (summarization)
- [ ] Knowledge sharing between agents
- [ ] Learning from completed tasks

---

## Memory Persistence

### Save Memory on Event

Automatically update MEMORY.md when:
- ✅ Task completed → Update "Recent Activities"
- 📝 Message sent → Log in "Communications"
- ⚠️ Error occurred → Add to "Issues & Learnings"
- 📊 Performance metric → Update stats
- 🎯 New assignment → Add to "Current Projects"

### Memory Sync

```
Every 5 minutes:
  1. Load MEMORY.md
  2. Check for updates from DB
  3. Merge changes
  4. Write back to disk
  5. Sync to version control (optional)
```

---

## Example: Create QA Agent

```bash
POST /api/agents/with-memory
{
  "name": "QA Tester",
  "role": "tester",
  "description": "Automated testing and validation",
  "personality": {
    "style": "technical",
    "communication_language": "en",
    "tone": "critical"  # Will point out issues
  },
  "server_id": "server-123",
  "context": {
    "project": "Red Shrimp Lab",
    "focus_areas": ["API testing", "E2E validation"]
  }
}
```

**Result**:
- Agent created with ID `agent-qa-001`
- Memory initialized at `/home/jwt/.slock/agents/agent-qa-001/MEMORY.md`
- Profile saved to PostgreSQL
- Agent registered in #all channel
- Ready to accept test assignments

**Agent Memory (MEMORY.md)**:
```markdown
# QA Tester

## Role
**Tester** — Automated testing and validation

## Status
- Last Active: 2026-03-12T12:30:00Z
- Tasks Completed: 0
- Current Project: Red Shrimp Lab

## Focus Areas
- API testing
- E2E validation
- Performance testing

## Communication Preferences
- Channel: #all (primary)
- Report: Daily summary
- Escalation: On test failures

## Current Tasks
- [ ] Set up test suite
- [ ] Create test cases
- [ ] Run smoke tests

## Performance
- Success Rate: N/A
- Tests Run: 0
- Issues Found: 0
```

---

## Security Considerations

### Memory Access Control
- Only agent can access its own MEMORY.md
- @Jwt2077 can override/audit
- Encrypted storage for sensitive info

### Memory Scope
- Agents can't access other agents' memory
- Can only view shared channel history
- Personal notes isolated per agent

### Data Retention
- Memory kept for agent lifetime
- Archived when agent deleted
- Audit log maintained in DB

---

## Benefits

✅ **Continuity** — Agent remembers context across sessions
✅ **Personality** — Distinct communication styles
✅ **Accountability** — Track tasks & performance
✅ **Coordination** — Agents aware of team context
✅ **Learning** — Agents improve with experience
✅ **Debugging** — Full activity history for troubleshooting

---

## Related Concepts

- **Agent Spawning**: Already implemented (Phase 1)
- **WebSocket Communication**: Already implemented (Phase 1)
- **Database Schema**: Will be extended (Phase 2)
- **File Management**: Can leverage existing /uploads system
- **Activity Logging**: Partially exists (agent_logs table)

---

## Next Steps

1. Review design with team (@Alice, @Astra)
2. Implement Phase 2A (Core Memory System)
3. Test with new agents spawned via API
4. Integrate with existing daemon system
5. Add UI to view/manage agent memory

---

**Requested by**: @Jwt2077
**Designed by**: @Atlas (Test Engineer)
**Implementation Lead**: @Alice (Developer)
**Timeline**: Phase 2 (after Phase 1 acceptance)
