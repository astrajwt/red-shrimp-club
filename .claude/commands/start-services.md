# Start Red Shrimp Services

Start backend + daemon from the user's own terminal (NOT from Claude Code Bash tool, because claude agents cannot start inside a claude process).

## Steps

Run these commands in your own terminal:

```bash
# 1. Kill old processes
pkill -f "backend-src.*index.ts" 2>/dev/null
pkill -f "daemon-src.*index.js" 2>/dev/null
sleep 2

# 2. Start backend
cd /home/jwt/JwtVault/slock-clone/backend-src
node --import tsx/esm src/index.ts >> /tmp/backend.log 2>&1 &
echo "Backend PID: $!"

sleep 3

# 3. Start daemon (MUST be from your own terminal, not from Claude Code)
cd /home/jwt/JwtVault/slock-clone/daemon-src
node dist/index.js \
  --server-url http://192.168.1.2:3001 \
  --api-key sk_machine_d103574e4964101e5af892884f1324ddbe6e91770df6c67983fe441b918c9e94 \
  >> /tmp/daemon.log 2>&1 &
echo "Daemon PID: $!"
```

## Why not from Claude Code?

`claude` CLI cannot be launched inside another Claude Code session (they share runtime resources). Even with `CLAUDECODE` unset, the restriction applies when running as a descendant process of another claude session.

## Quick check

```bash
# Check agents are making API calls
grep "/internal/agent" /tmp/backend.log | tail -5

# Check status
ps aux | grep -E "daemon-src|index\.ts" | grep -v grep
```
