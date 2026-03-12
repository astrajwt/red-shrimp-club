# Testing Quick Start Guide

**Version**: 1.0 | **Phase**: 2 | **Owner**: @Atlas

Quick reference for running and extending Red Shrimp Lab tests.

---

## 📋 Quick Links

| Document | Purpose |
|----------|---------|
| `TESTING-GUIDE.md` | Phase 1 manual acceptance checklist |
| `PHASE-2-TESTING-PLAN.md` | Detailed Phase 2 test roadmap |
| `__tests__/test-utils.ts` | Shared test utilities & helpers |
| `dev-log/` | Test reports and logs |

---

## 🚀 Running Tests

### Phase 1 Tests (E2E Smoke)
```bash
# Run all Phase 1 tests
cd /home/jwt/JwtVault/slock-clone
bash test-phase1.sh

# Or with environment override
DATABASE_URL=... bash test-phase1.sh
```

**Output**: `dev-log/atlas-e2e-{timestamp}.md`

### Phase 2 Tests (Jest)
```bash
# Install dependencies (if needed)
npm install --save-dev jest ts-jest @types/jest

# Run all tests
npm test

# Run specific test file
npm test __tests__/websocket.e2e.test.ts

# Run tests matching pattern
npm test --testNamePattern="WebSocket"

# Run with coverage
npm test --coverage

# Watch mode (re-run on changes)
npm test --watch
```

### Phase 2 Tests (Frontend)
```bash
# Run React component tests
cd frontend-src
npm test __tests__/DocBrowser.test.tsx

# Coverage report
npm test -- --coverage
```

---

## ✍️ Writing New Tests

### 1. Using Test Utilities

```typescript
import {
  createTestUser,
  createTestChannel,
  createTestMessage,
  setupTestEnvironment
} from './test-utils'

describe('My Feature', () => {
  test('my test case', async () => {
    // Quick setup
    const { user, channel, token } = await setupTestEnvironment()

    // Or detailed setup
    const user = await createTestUser('custom@test.local')
    const channel = await createTestChannel(user.server_id, 'my-channel', user.access_token)
    const message = await createTestMessage(channel.id, 'test', user.access_token)

    // Your test logic here
    expect(true).toBe(true)
  })
})
```

### 2. WebSocket Tests

```typescript
import {
  createTestUser,
  createWebSocketClient,
  waitForWebSocketEvent
} from './test-utils'

test('should receive WebSocket event', async () => {
  const user = await createTestUser()
  const socket = await createWebSocketClient(user.access_token)

  // Trigger event (via API or other client)
  await triggerSomeEvent()

  // Listen for it
  const event = await waitForWebSocketEvent(socket, 'event:name', 5000)
  expect(event.data).toBeDefined()

  socket.disconnect()
})
```

### 3. File Upload Tests

```typescript
import fs from 'fs'
import path from 'path'

test('should reject oversized files', async () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'oversized-image.png'))

  const res = await request(app)
    .post('/api/files/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', fixture, 'test.png')

  expect(res.status).toBe(413) // Payload too large
  expect(res.body.error).toContain('too large')
})
```

### 4. Component Tests (React)

```typescript
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import MyComponent from '../src/MyComponent'

test('should render and interact', async () => {
  const { container } = render(<MyComponent />)

  // Query elements
  const button = screen.getByText('Click me')

  // Interact
  fireEvent.click(button)

  // Wait for async updates
  await waitFor(() => {
    expect(screen.getByText('Clicked!')).toBeInTheDocument()
  })
})
```

---

## 📊 Test Coverage

### Check Coverage

```bash
# Generate coverage report
npm test -- --coverage

# View HTML report
open coverage/lcov-report/index.html
```

### Coverage Targets

| Category | Target | Status |
|----------|--------|--------|
| Statements | 80%+ | 🟢 |
| Branches | 75%+ | 🟡 |
| Functions | 80%+ | 🟢 |
| Lines | 80%+ | 🟢 |

---

## 🔧 Debugging Tests

### Run Single Test
```bash
npm test -- __tests__/websocket.e2e.test.ts -t "message:new event"
```

### Enable Debug Output
```bash
DEBUG=* npm test
```

### Inspect with Node
```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

Then open `chrome://inspect` in Chrome DevTools.

### Print Statements
```typescript
test('debug test', async () => {
  console.log('Test value:', someVar)
  console.table(dataArray)
  debugger // Pauses execution
  expect(true).toBe(true)
})
```

---

## 🚨 Common Issues

### "Cannot find module 'test-utils'"
- Ensure `__tests__/test-utils.ts` exists
- Check import path: `from './test-utils'` (relative)

### "WebSocket connection timeout"
- Verify backend is running: `curl http://localhost:3001`
- Check Socket.io listening on correct port
- Increase timeout: `await waitForWebSocketEvent(socket, 'event', 10000)`

### "Database connection error"
- Ensure PostgreSQL is running
- Check `DATABASE_URL` environment variable
- For tests, may use SQLite in-memory (see jest.config.ts)

### "Test hangs/freezes"
- Add timeout: `jest.setTimeout(10000)`
- Use `runInBand` to run sequentially: `npm test -- --runInBand`
- Check for missing `await` on promises

---

## 📈 Test Execution Timeline

### Phase 1 (DONE ✅)
- E2E smoke tests: 14/14 PASSING
- Manual acceptance checklist: Ready
- Time: ~2 hours

### Phase 2A (DONE ✅)
- Agent Memory System: Implemented
- Time: ~30 minutes

### Phase 2B (DONE ✅)
- Document Browser: Implemented & tested
- Time: ~45 minutes

### Phase 2 Testing (READY 🚀)
- **Week 1**: WebSocket + File Upload + LLM tests
- **Week 2**: Rate Limit + Heartbeat + Cron tests
- **Week 3**: Obsidian + Stress tests
- **Expected**: 15-20 hours total

---

## 📝 Test Report Template

```markdown
# Test Report — {Date}

**Phase**: {Phase Number}
**Tester**: @Atlas
**Duration**: {minutes} minutes

## Summary
- Total tests: {count}
- Passed: {count} ✅
- Failed: {count} ❌
- Skipped: {count} ⏭️
- Coverage: {%}

## Failures
{List failures with error messages}

## Performance
- Slowest test: {name} ({time}ms)
- Average: {time}ms
- P95: {time}ms

## Notes
{Any observations, blockers, recommendations}
```

Save to: `dev-log/test-report-{phase}-{date}.md`

---

## 🔗 Related Documentation

- **API Reference**: `API-Reference.md` — All endpoints & response formats
- **PRD**: `PRD-产品需求文档.md` — Feature requirements
- **Architecture**: `Daemon架构设计.md` — System design
- **Deployment**: `DEPLOY-*.md` — Deployment guides

---

## ✅ Checklist for New Tests

- [ ] Uses test-utils for setup (don't duplicate)
- [ ] Has clear test names (describes what it tests)
- [ ] Includes comments for non-obvious logic
- [ ] Has appropriate timeouts (not hardcoded delays)
- [ ] Cleans up resources (disconnect WebSocket, etc.)
- [ ] Covers happy path + error cases
- [ ] No console errors/warnings
- [ ] Follows existing code style
- [ ] Added to appropriate test file
- [ ] Updated coverage requirements if needed

---

## 📞 Need Help?

**Test Utilities**: See `__tests__/test-utils.ts`
**Test Examples**: See `__tests__/websocket.e2e.test.ts`, `__tests__/DocBrowser.test.tsx`
**Test Plan**: See `PHASE-2-TESTING-PLAN.md`
**Phase 1 Checklist**: See `TESTING-GUIDE.md`

**Questions?** → Post in #all or tag @Atlas

---

**Last Updated**: 2026-03-12
**Maintained By**: @Atlas (Test Engineer)
**Status**: Ready for Phase 2 Testing
