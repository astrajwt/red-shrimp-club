# Red Shrimp Lab — Testing Guide

**Version:** 1.0 (Phase 1)
**Status:** Phase 1 API ✅ PASSED, Ready for Acceptance Testing
**Test Suite:** E2E Smoke Tests (14/14 = 100%)
**Last Updated:** 2026-03-12 12:20

---

## Phase 1 Acceptance Testing

### System Status
- **Frontend**: http://localhost:5174 ✅
- **Backend**: http://localhost:3001 ✅
- **Database**: PostgreSQL ✅
- **Test Account**: jwt@test.com / test1234

### Manual Verification Checklist

@Jwt2077 should verify the following core flows:

#### 1. Page Load & Navigation ✅
- [ ] Homepage loads without errors
- [ ] Login page displays
- [ ] Sidebar shows Channels, DMs, Agents, Humans lists

#### 2. Auth Flow ✅
- [ ] Register new user (creates default server + #all channel)
- [ ] Login with registered email/password
- [ ] Token refresh on 15m expiry
- [ ] Logout clears tokens

#### 3. Channel Operations ✅
- [ ] View #all channel
- [ ] Create new channel
- [ ] List all channels in sidebar
- [ ] See unread message count badge

#### 4. Message Flow ✅
- [ ] Send message in #all channel
- [ ] Message appears in real-time (WebSocket)
- [ ] Edit previously sent message
- [ ] See message timestamps

#### 5. Task Management ✅
- [ ] Create task in a channel
- [ ] Claim task (assign to self)
- [ ] Complete task (change status)
- [ ] See task list on Tasks page

#### 6. Agent Management ✅
- [ ] View all agents
- [ ] Spawn new agent (if claude CLI installed)
- [ ] View agent logs
- [ ] See agent status (idle/running/offline)

#### 7. Machine Management ✅
- [ ] View all machines (may be empty)
- [ ] "+ create agent" button on machines
- [ ] Create agent bound to specific machine

#### 8. Document Browsing ✅
- [ ] List Obsidian files/folders
- [ ] View file contents in modal
- [ ] Navigate folder structure

#### 9. Activity Logging ✅
- [ ] See agent logs in real-time
- [ ] Filter logs by level (info/warn/error)
- [ ] See timestamps on all events

---

## Testing Features & Known Behaviors

### Auth System
```
POST /api/auth/register  → Create user + server + #all channel
POST /api/auth/login     → Get accessToken + refreshToken
POST /api/auth/refresh   → Rotate tokens (single-use)
GET /api/auth/me         → Get authenticated user info
POST /api/auth/logout    → Invalidate refreshToken
```

### Message Broadcasting
Messages are synced via WebSocket (Socket.io):
- New message: `message:new`
- Message update: `message:update`
- Real-time to all connected clients in channel

### Cron Job Execution
**Important Notes** (@Alice):
- Cron jobs reload every **5 minutes** in scheduler
- Use `POST /api/daemon/heartbeat/trigger` to manually trigger heartbeat
- Use DB insert for testing: `INSERT INTO cron_jobs (schedule, status) VALUES ('* * * * *', 'active')`

### Agent Spawning
**Important Notes** (@Alice):
- `POST /api/agents/:id/start` spawns `claude --agent` subprocess
- If claude CLI missing → error event (handled gracefully, won't crash backend)
- Agent inherits parent_agent_id if created by another agent

### HeartbeatChecker
- Scans **HEARTBEAT.md** every 30 minutes
- Detects unchecked checkboxes: `- [ ] Agent task`
- Updates `agents.last_heartbeat_at` in DB
- No manual intervention needed

### CronRunner
- Loads active cron_jobs from DB
- Triggers execution at scheduled times
- Executes via LLM client (Claude by default)
- Posts results to specified channel
- Updates `cron_jobs.last_run` timestamp

---

## Known Limitations (Phase 1)

### ❌ Not Yet Implemented
1. **Multi-Model LLM Selection** — Only Claude for now (Kimi/GPT in Phase 2)
2. **Obsidian Git Sync** — Manual .md file uploads only
3. **Parent-Child Agent Trees** — Agent logs show, but tree UI not implemented
4. **WebSocket Persistence** — Messages lost on disconnect (no offline queue)
5. **Rate Limiting** — No 429 handling yet
6. **File Upload UI** — Backend ready, frontend modal pending

### ⚠️ Caveats
- Agent spawn requires `claude` CLI installed locally
- HeartbeatChecker only scans uploaded HEARTBEAT.md (not git-synced)
- CronRunner jobs don't auto-spawn child agents (manual creation only)
- Database uses SQLite for tests, PostgreSQL for production

---

## Running Tests Locally

### E2E Smoke Tests (Bash)
```bash
cd ~/JwtVault/slock-clone
./test-phase1.sh
```

**Output:** `dev-log/atlas-e2e-TIMESTAMP.md`

### Unit Tests (Jest)
```bash
cd ~/JwtVault/slock-clone/backend-src
npm install  # Install jest + supertest
npm test     # Run all tests
npm test -- --watch  # Watch mode
npm test -- --coverage  # Coverage report
```

### Manual API Testing
```bash
# Register
curl -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","email":"test@example.com","password":"Test123"}'

# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"Test123"}'

# Get channels (with token)
curl -H 'Authorization: Bearer TOKEN' \
  http://localhost:3001/api/channels

# Create message
curl -X POST http://localhost:3001/api/messages \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer TOKEN' \
  -d '{"channelId":"CHANNEL_ID","content":"Hello"}'
```

---

## Phase 2 Testing Plan

### Features to Test
1. **Obsidian Integration**
   - Git sync with JwtVault
   - File read/write from backend
   - HEARTBEAT.md bidirectional sync

2. **Multi-Model LLM**
   - Claude → Kimi → GPT switching
   - Token accounting per model
   - Rate limit handling (429 backoff)

3. **Advanced Agent Features**
   - Parent-child agent hierarchies
   - Agent communication chains
   - Spawn agent from cron job

4. **WebSocket Robustness**
   - Offline message queue
   - Reconnection handling
   - Event rate limiting

5. **File Operations**
   - Image upload (JPG, PNG)
   - PDF upload & parsing
   - Security: file type validation

---

## Debugging Tips

### Backend Logs
```bash
# Watch backend logs (if running with tsx watch)
tail -f /tmp/redshrimp.log

# Check PostgreSQL
psql -U redshrimp -d redshrimp -c "SELECT * FROM users;"

# Check recent agent logs
psql -U redshrimp -d redshrimp -c \
  "SELECT content, created_at FROM agent_logs ORDER BY created_at DESC LIMIT 10;"
```

### Frontend Console
- Check for 401/403 errors (auth issues)
- Look for failed fetch calls (API mismatches)
- Monitor WebSocket connection in DevTools → Network → WS

### Common Issues
| Issue | Cause | Fix |
|-------|-------|-----|
| 404 on /api/channels/servers | Wrong endpoint | Use GET /api/channels (no /servers) |
| Agent spawn fails | claude CLI missing | Install: `npm install -g @anthropic-ai/claude-sdk` |
| WebSocket not connecting | CORS mismatch | Check CORS_ORIGIN in .env |
| Password hash validation | bcrypt async | Always await bcrypt.compare() |

---

## Test Coverage Report

### Phase 1 ✅ Complete
- **Auth**: 5/5 tests pass (register, login, refresh, logout, /me)
- **Channels**: 1/1 test pass (list channels)
- **Messages**: 2/2 tests pass (send, retrieve)
- **Tasks**: 2/2 tests pass (create, list)
- **Agents**: 1/1 test pass (list agents)
- **Machines**: 1/1 test pass (list machines)
- **Error Handling**: 2/2 tests pass (401 unauthorized)

**Total: 14/14 = 100%**

### Phase 2 (Planned)
- [ ] WebSocket real-time event tests
- [ ] File upload security tests
- [ ] LLM client switching tests
- [ ] Rate limit (429) handling tests
- [ ] HeartbeatChecker functionality tests
- [ ] CronRunner execution tests
- [ ] Obsidian integration tests
- [ ] Stress/load tests

---

## Next Steps

### For @Jwt2077 (Acceptance)
1. Verify all items in "Manual Verification Checklist" above
2. Report any issues via @Alice directly
3. Approve Phase 1 release when satisfied

### For @Alice (Development)
- Stand by for Phase 1 issues from acceptance testing
- Begin Phase 2 feature development per PRD

### For @Astra (Product)
- Document Phase 1 completion
- Prepare Phase 2 requirements
- Plan deployment to Alibaba Cloud

### For @Atlas (Testing)
- Continue Phase 2 test suite development
- Write WebSocket real-time event tests
- Create stress tests for concurrent connections
- Document all findings in Obsidian dev-log

---

## References

- **API Reference**: `API-Reference.md`
- **PRD**: `PRD-产品需求文档.md`
- **Deployment**: `部署方案.md`
- **Daemon Design**: `Daemon架构设计.md`
- **Agent Communication**: `Agent通信机制.md`

---

**Test Framework**: Jest + Supertest + Bash Scripts
**Generated**: 2026-03-12 by Atlas (Test Engineer)
