#!/bin/bash
# 前端快速重部署脚本
# 适用于 vite preview 模式（非 dev 模式）
set -e

FRONTEND_DIR="$(cd "$(dirname "$0")/frontend-src" && pwd)"
PREVIEW_PORT=5173

echo "=== 重建前端 ==="
cd "$FRONTEND_DIR"

echo "--- npm run build ---"
npm run build

echo "--- 重启 vite preview ---"
# 找到当前占用 5173 端口的进程并杀掉
OLD_PID=$(lsof -ti :$PREVIEW_PORT 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  echo "停止旧进程 PID=$OLD_PID"
  kill "$OLD_PID"
  sleep 1
fi

# 后台启动新的 preview
nohup npx vite preview --host 0.0.0.0 --port $PREVIEW_PORT > /tmp/vite-preview.log 2>&1 &
NEW_PID=$!
echo "已启动 vite preview PID=$NEW_PID"
echo "日志: tail -f /tmp/vite-preview.log"
echo ""
echo "=== 完成，访问 http://localhost:$PREVIEW_PORT ==="
