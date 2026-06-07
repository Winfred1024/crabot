#!/usr/bin/env bash
# 停止 panic-monitor 后台进程
set -e

LOG_DIR="$HOME/Library/Logs/crabot-panic-monitor"
PID_FILE="$LOG_DIR/monitor.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "panic-monitor 未在运行 (pid 文件不存在)"
  # 补一刀：万一进程在但 pid 文件丢了
  PIDS=$(pgrep -f "panic-monitor/monitor.py" || true)
  if [ -n "$PIDS" ]; then
    echo "但发现游离的 monitor 进程: $PIDS  — 杀掉"
    kill $PIDS 2>/dev/null || true
  fi
  exit 0
fi

PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
if [ -z "$PID" ]; then
  echo "pid 文件为空，清理"
  rm -f "$PID_FILE"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "停止 panic-monitor (pid=$PID)..."
  kill "$PID"
  for i in {1..10}; do
    sleep 0.5
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "已停止"
      rm -f "$PID_FILE"
      exit 0
    fi
  done
  echo "未在 5 秒内退出，发 SIGKILL"
  kill -9 "$PID" 2>/dev/null || true
  rm -f "$PID_FILE"
else
  echo "pid=$PID 已不存在，清理 pid 文件"
  rm -f "$PID_FILE"
fi
