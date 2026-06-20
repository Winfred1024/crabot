#!/usr/bin/env bash
# 幂等启动 tmp-page server。已在跑（端口被占）→ server.cjs 自身检测 EADDRINUSE 退出 0。
# 用法：在 agent 的 Bash 工具里以 run_in_background=true 调用本脚本。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${CRABOT_TMP_PAGE_PORT:-21000}"

# 已在监听 → 直接成功返回，不重复起
if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  echo "{\"type\":\"already-running\",\"port\":$PORT}"
  exit 0
fi

exec node "$SCRIPT_DIR/server.cjs"
