#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

SERVER_PORT="${SERVER_PORT:-3456}"

echo "==> 启动服务端 (port: ${SERVER_PORT})"
SERVER_PORT="${SERVER_PORT}" bun run src/server/index.ts &
SERVER_PID=$!

sleep 2

echo "==> 启动桌面端前端 (Vite dev server)"
( cd desktop && VITE_DESKTOP_SERVER_URL="http://127.0.0.1:${SERVER_PORT}" bun run dev ) &
DESKTOP_PID=$!

cleanup() {
  echo "==> 正在停止..."
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$DESKTOP_PID" 2>/dev/null || true
  wait
}
trap cleanup EXIT INT TERM

echo ""
echo "提示: 浏览器打开 http://localhost:1420"
echo "按 Ctrl+C 停止所有服务"
echo ""

wait
