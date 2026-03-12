# Phase 2 Testing Plan

**Status**: Ready to implement (2026-03-12 12:35+)
**Owner**: @Atlas (Test Engineer)
**Prerequisite**: Phase 1 acceptance from @Jwt2077

---

## Overview

Phase 2 expands testing coverage from Phase 1 smoke tests (14/14 passing) to comprehensive feature testing across:
- Real-time WebSocket messaging
- File upload security
- Multi-model LLM switching (Claude, Kimi, GPT)
- Rate limit handling (429 exponential backoff)
- HeartbeatChecker and CronRunner functionality
- Obsidian integration
- Load/stress testing

---

## Testing Roadmap

### Priority 1: WebSocket Real-Time Tests

**Goal**: Verify Socket.io event broadcasting for real-time features

**Test Scenarios**:
1. **Message Real-Time Delivery**
   - Send message in channel → verify `message:new` event received by all clients
   - Edit message → verify `message:update` event
   - Delete message → verify `message:delete` event
   - Test with 2+ simultaneous clients

2. **Task Status Updates**
   - Create task → verify `task:new` event
   - Claim task → verify `task:claimed` event
   - Complete task → verify `task:completed` event
   - Verify all clients in channel receive updates

3. **Agent Status Changes**
   - Agent starts → verify `agent:running` event
   - Agent completes → verify `agent:idle` event
   - Agent errors → verify `agent:error` event with details

4. **Channel Join/Leave**
   - User joins channel → verify `channel:user_joined` event
   - User leaves → verify `channel:user_left` event
   - Verify user list updates

**Implementation**:
- Create `__tests__/websocket.e2e.test.ts` using socket.io-client
- Connect 2+ clients to same channel
- Trigger actions and verify events received
- Test event ordering and data integrity

**Acceptance Criteria**:
- ✅ All message lifecycle events working
- ✅ All task lifecycle events working
- ✅ All agent status events working
- ✅ Channel membership events working
- ✅ No event loss under normal load (10 msgs/sec)

---

### Priority 2: File Upload Security Tests

**Goal**: Verify image/PDF upload with security constraints

**Test Scenarios**:
1. **Image Upload**
   - Upload valid PNG/JPEG → verify stored in /uploads
   - Upload with EXIF metadata → verify sanitized
   - Upload oversized (>10MB) → verify rejected
   - Upload non-image file renamed → verify rejected

2. **PDF Upload**
   - Upload valid PDF → verify stored
   - Upload PDF with embedded scripts → verify sandboxed
   - Upload corrupted PDF → verify error handling
   - Upload oversized (>50MB) → verify rejected

3. **Malware Prevention**
   - Upload executable file → verify rejected
   - Upload with double extension (.jpg.exe) → verify rejected
   - Upload with null bytes → verify rejected
   - Verify files stored outside web root

4. **Access Control**
   - Verify only authenticated users can upload
   - Verify users can't download others' files
   - Verify file URLs not guessable (UUID-based)

**Implementation**:
- Create `__tests__/file-upload.test.ts`
- Use file fixtures in `__tests__/fixtures/` (images, PDFs, malware-like files)
- Test endpoint: `POST /api/files/upload`
- Verify response includes file URL, size, MIME type

**Acceptance Criteria**:
- ✅ Valid files upload successfully
- ✅ Invalid/oversized files rejected with 400
- ✅ Unauthenticated requests get 401
- ✅ File access control verified
- ✅ No malicious content stored

---

### Priority 3: Multi-Model LLM Tests

**Goal**: Verify Claude/Kimi/GPT switching and fallback behavior

**Test Scenarios**:
1. **Model Selection**
   - Set `LLM_MODEL=claude` → verify requests use Claude API
   - Set `LLM_MODEL=kimi` → verify requests use Kimi API
   - Set `LLM_MODEL=gpt` → verify requests use OpenAI API

2. **API Key Handling**
   - Missing API key → verify graceful error
   - Invalid API key → verify 401 response
   - Multiple keys configured → verify correct one used

3. **Response Handling**
   - Verify response parsing for each model's format
   - Verify stream handling (if applicable)
   - Verify token count estimation per model

4. **Fallback Behavior**
   - Primary model unavailable → fallback to secondary
   - Verify logging of model switches

**Implementation**:
- Create `__tests__/llm-models.test.ts`
- Mock LLM API responses
- Set env vars and verify correct endpoint called
- Test with real API if keys available (integration test)

**Acceptance Criteria**:
- ✅ All 3 models work independently
- ✅ Correct API endpoint called per model
- ✅ Responses parsed correctly
- ✅ Fallback works if primary unavailable
- ✅ Error handling robust

---

### Priority 4: Rate Limit & Exponential Backoff Tests

**Goal**: Verify 429 handling with exponential backoff

**Test Scenarios**:
1. **429 Response Handling**
   - LLM API returns 429 → verify retry with backoff
   - Verify backoff: 1s, 2s, 4s, 8s, 16s
   - Verify max retries (e.g., 5 attempts)
   - After max retries → return error to user

2. **Multiple Concurrent Requests**
   - Send 5 rapid LLM requests → verify they don't all 429
   - Verify requests queued and rate-limited
   - Verify queue processes in order

3. **Retry-After Header**
   - If 429 includes Retry-After header → use that value
   - Verify respects server preference

**Implementation**:
- Create `__tests__/rate-limit.test.ts`
- Mock LLM API to return 429
- Test single request backoff
- Test concurrent request queuing
- Measure backoff timing

**Acceptance Criteria**:
- ✅ Single 429 retried with backoff
- ✅ Max retries respected
- ✅ User gets error after max retries
- ✅ Concurrent requests handled safely
- ✅ Backoff times accurate within ±10%

---

### Priority 5: HeartbeatChecker Functional Tests

**Goal**: Verify HEARTBEAT.md scanning and task assignment

**Test Scenarios**:
1. **HEARTBEAT.md Parsing**
   - Create agent with HEARTBEAT.md
   - HeartbeatChecker scans every 30 min
   - Verify unchecked tasks identified
   - Verify checked tasks marked complete

2. **Task Assignment**
   - Add task to HEARTBEAT.md
   - Trigger heartbeat scan
   - Verify task appears in /api/agents/:id/tasks
   - Verify in MEMORY.md "Current Tasks" section

3. **Offline Detection**
   - Agent doesn't heartbeat for 2+ hours
   - Verify status changes to `offline` in DB
   - Verify UI shows offline badge

4. **Heartbeat Triggering**
   - Manual trigger: `POST /api/daemon/heartbeat/trigger`
   - Verify scan runs immediately (not waiting 30 min)
   - Verify results logged

**Implementation**:
- Create `__tests__/heartbeat-checker.test.ts`
- Use agent with test HEARTBEAT.md
- Mock file system and timestamps
- Trigger and verify DB updates

**Acceptance Criteria**:
- ✅ HEARTBEAT.md parsed correctly
- ✅ Unchecked tasks identified
- ✅ 30-min interval working
- ✅ Offline detection working (2hr timeout)
- ✅ Manual trigger works

---

### Priority 6: CronRunner Execution Tests

**Goal**: Verify scheduled job execution and result delivery

**Test Scenarios**:
1. **Job Loading**
   - Load cron_jobs table every 5 min
   - Verify all jobs with status='active' loaded
   - Verify schedule format validated

2. **Job Execution**
   - Create cron job: every 5 min, run task X
   - Verify executes at correct time
   - Verify task completes
   - Verify result logged

3. **Result Delivery**
   - Job result posted to designated channel
   - Verify message format includes: job_id, status, output
   - Verify timestamp accurate

4. **Error Handling**
   - Job fails → status = 'error' in DB
   - Verify error message posted to channel
   - Backend doesn't crash

**Implementation**:
- Create `__tests__/cron-runner.test.ts`
- Mock scheduler timer
- Create test cron_jobs in DB
- Verify execution and delivery

**Acceptance Criteria**:
- ✅ Jobs loaded from DB
- ✅ Scheduled correctly
- ✅ Results posted to channels
- ✅ Errors handled gracefully
- ✅ No backend crashes

---

### Priority 7: Obsidian Integration Tests

**Goal**: Verify file read/write and Git sync

**Test Scenarios**:
1. **File Reading**
   - List files in Obsidian vault
   - Read file contents
   - Verify metadata (size, modified time)
   - Handle deleted files gracefully

2. **File Writing**
   - Write to new markdown file
   - Verify saved to correct location
   - Verify content readable
   - Create in subdirectory

3. **Git Sync**
   - File written → Git commit created
   - Verify commit message includes: file, timestamp, author
   - Verify Git log updated
   - Handle Git errors gracefully

4. **Performance**
   - Read 100 files → measure time (should be <1s)
   - Concurrent reads/writes → verify no corruption

**Implementation**:
- Create `__tests__/obsidian-integration.test.ts`
- Use test Obsidian vault (~/JwtVault/ or similar)
- Mock git commands
- Verify file operations and sync

**Acceptance Criteria**:
- ✅ Files read/written correctly
- ✅ Git commits created
- ✅ Metadata preserved
- ✅ Errors handled
- ✅ Performance acceptable

---

### Priority 8: Stress & Load Tests

**Goal**: Verify system stability under heavy load

**Test Scenarios**:
1. **Connection Scaling**
   - Start 10 simultaneous WebSocket connections
   - Gradually increase to 100
   - Verify no crashes or disconnects
   - Measure memory/CPU usage

2. **Message Throughput**
   - Send 100 messages/sec
   - Verify all delivered
   - Verify order preserved
   - Measure latency (p50, p95, p99)

3. **Concurrent Tasks**
   - Create 50 tasks simultaneously
   - Verify all created successfully
   - Verify no duplicate IDs
   - Verify no data corruption

4. **Agent Spawn Load**
   - Spawn 10 agents simultaneously
   - Verify all initialize correctly
   - Verify no port conflicts
   - Verify cleanup on crash

5. **Database Queries**
   - Run 1000 queries/sec
   - Verify connection pool handling
   - Verify queries complete
   - Check for slow query logs

**Implementation**:
- Create `__tests__/stress.test.ts`
- Use k6 or similar load testing tool (optional)
- Monitor system metrics during tests
- Generate report with latency percentiles

**Acceptance Criteria**:
- ✅ 100 concurrent users supported
- ✅ 100 msgs/sec throughput
- ✅ Sub-100ms latency (p95)
- ✅ No memory leaks
- ✅ Graceful degradation under overload

---

## Test Execution Schedule

### Week 1 (After Phase 1 Acceptance)
- Priority 1: WebSocket tests ✅
- Priority 2: File upload tests ✅
- Priority 3: Multi-model LLM tests ✅

### Week 2
- Priority 4: Rate limit tests ✅
- Priority 5: HeartbeatChecker tests ✅
- Priority 6: CronRunner tests ✅

### Week 3
- Priority 7: Obsidian integration tests ✅
- Priority 8: Stress tests ✅
- Coverage report & documentation

---

## Test Infrastructure

### Tools & Frameworks
- **Jest**: Unit & integration tests
- **Supertest**: HTTP API testing
- **socket.io-client**: WebSocket testing
- **Jest Timers**: Mock time-based tests (heartbeat, cron)
- **k6** (optional): Load testing
- **Artillery** (optional): Performance testing

### Fixtures & Mocks
- Test images: `__tests__/fixtures/test.jpg`, `test.png`
- Test PDFs: `__tests__/fixtures/document.pdf`
- Mock LLM responses: `__tests__/mocks/llm-responses.ts`
- Mock agent files: `__tests__/fixtures/agents/`

### Continuous Integration
- Jest runs on every commit
- Coverage threshold: 80%
- E2E tests run on PR
- Stress tests run nightly
- Reports generated to `dev-log/`

---

## Success Metrics

| Test Category | Target | Current |
|---|---|---|
| WebSocket Events | 100% pass | 🔄 In progress |
| File Upload Security | 100% pass | 🔄 In progress |
| LLM Model Switching | 100% pass | 🔄 In progress |
| Rate Limit Handling | 100% pass | 🔄 In progress |
| HeartbeatChecker | 100% pass | 🔄 In progress |
| CronRunner | 100% pass | 🔄 In progress |
| Obsidian Integration | 100% pass | 🔄 In progress |
| Load/Stress | P95 < 100ms | 🔄 In progress |
| **Overall Coverage** | **80%+** | 🔄 In progress |

---

## Blockers & Dependencies

- ⏸️ **Blocked on**: Phase 1 acceptance from @Jwt2077
- ⏸️ **Waiting for**: Phase 2B markdown viewer implementation by @Alice
- ✅ **Ready**: All testing infrastructure
- ✅ **Ready**: Test fixtures and mocks

---

## Next Steps

1. ⏳ Await Phase 1 acceptance from @Jwt2077
2. 🚀 Once accepted, begin Priority 1 (WebSocket tests)
3. 📊 Track progress in test reports
4. 🔄 Iterate based on findings
5. 📈 Generate final coverage report

---

**Owner**: @Atlas
**Status**: Awaiting Phase 1 acceptance
**Created**: 2026-03-12 12:35
**Next Review**: After Phase 1 sign-off
