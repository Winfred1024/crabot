#!/usr/bin/env bash
# 启动 panic-monitor 后台进程
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/Library/Logs/crabot-panic-monitor"
PID_FILE="$LOG_DIR/monitor.pid"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ]; then
  EXISTING_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "panic-monitor 已在运行 (pid=$EXISTING_PID)。要重启请先跑 stop.sh。"
    exit 0
  fi
  echo "清理过期 pid 文件 $PID_FILE"
  rm -f "$PID_FILE"
fi

# 用系统自带 python3（macOS 12+ 默认有）；如果用户偏好 miniforge，自行替换
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="$(command -v python3)"
fi

echo "启动 panic-monitor..."
echo "  python:  $PYTHON_BIN"
echo "  script:  $SCRIPT_DIR/monitor.py"
echo "  log dir: $LOG_DIR"

nohup "$PYTHON_BIN" -u "$SCRIPT_DIR/monitor.py" \
  > "$LOG_DIR/stdout.log" 2> "$LOG_DIR/stderr.log" &

NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
sleep 1

if kill -0 "$NEW_PID" 2>/dev/null; then
  echo "OK. pid=$NEW_PID"
  echo "日志: $LOG_DIR/monitor-$(date +%Y%m%d).jsonl"
else
  echo "启动失败，查看 $LOG_DIR/stderr.log"
  cat "$LOG_DIR/stderr.log" 2>/dev/null | tail -20
  exit 1
fi
