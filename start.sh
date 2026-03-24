#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend-src"
FRONTEND_DIR="$SCRIPT_DIR/frontend-src"
LOG_FILE="/tmp/redshrimp-backend.log"

# Parse args
BUILD=false
for arg in "$@"; do
  [[ "$arg" == "--build" ]] && BUILD=true
done

# Optional frontend build
if $BUILD; then
  echo "[start] Building frontend..."
  cd "$FRONTEND_DIR" && npm run build
  echo "[start] Frontend built."
fi

# Kill existing backend if running
EXISTING=$(pgrep -f "tsx src/index.ts" 2>/dev/null || true)
if [[ -n "$EXISTING" ]]; then
  echo "[start] Stopping existing backend (PID $EXISTING)..."
  kill "$EXISTING"
  sleep 1
fi

# Start backend
echo "[start] Starting backend → logs: $LOG_FILE"
cd "$BACKEND_DIR"
nohup npx tsx src/index.ts > "$LOG_FILE" 2>&1 &
BACKEND_PID=$!
echo "[start] Backend PID: $BACKEND_PID"

# Wait and verify
sleep 2
if kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "[start] Backend running at http://127.0.0.1:3001"
  echo "[start] Public:  https://<your-domain>"
else
  echo "[start] ERROR: Backend failed to start. Check $LOG_FILE"
  tail -20 "$LOG_FILE"
  exit 1
fi
