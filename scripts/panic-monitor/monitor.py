#!/usr/bin/env python3
"""
panic-monitor: 在 macOS panic 前持续把系统快照写到磁盘，便于事后回溯触发原因。

每 SAMPLE_INTERVAL 秒采一次：
- vm_stat (内存压力、compressor、swap pages)
- sysctl vm.swapusage (swap 总量/使用量)
- uptime (load average)
- ps -Ao (前 TOP_N 个 RSS 进程)
- 读 crabot-agent heap-stats.log 尾部一条
- 列 paper_daemon (launchctl com.fufu.quant-signal.paper-daemon) 的活跃子进程

每条写完立刻 fsync，避免 panic 时 OS page cache 里的数据丢失。
脚本本身 nice(10) + 单线程，对系统压力可忽略。
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SAMPLE_INTERVAL = 5  # 秒
TOP_N = 30  # 每次记录前 N 个 RSS 进程
LOG_DIR = Path.home() / "Library" / "Logs" / "crabot-panic-monitor"
HEAP_STATS_LOG = Path("/Users/fufu/codes/playground/crabot/data/agent/logs/heap-stats.log")
PID_FILE = LOG_DIR / "monitor.pid"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def now_local_clock() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def run(cmd: list[str], timeout: float = 3.0) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout
    except Exception as e:
        return f"__ERR__ {e}"


def sample_vm_stat() -> Dict[str, Any]:
    """Parse `vm_stat` output to dict of page counts (page size 16384 on M-series)."""
    out = run(["vm_stat"])
    if out.startswith("__ERR__"):
        return {"_raw_err": out}
    page_size = 16384
    m = re.search(r"page size of (\d+) bytes", out)
    if m:
        page_size = int(m.group(1))
    result = {"page_size": page_size}
    for line in out.splitlines():
        m = re.match(r'"?([^":]+)"?:\s+(\d+)', line)
        if not m:
            continue
        key = m.group(1).strip().lower().replace(" ", "_").replace('"', "")
        val = int(m.group(2))
        result[key] = val
    # mb helpers for the ones we care about
    for k in ("pages_free", "pages_active", "pages_inactive", "pages_wired_down",
             "pages_speculative", "pages_purgeable", "pages_stored_in_compressor",
             "pages_occupied_by_compressor"):
        if k in result:
            result[k.replace("pages_", "") + "_mb"] = round(result[k] * page_size / 1024 / 1024, 1)
    return result


def sample_swap() -> Dict[str, Any]:
    out = run(["sysctl", "-n", "vm.swapusage"])
    if out.startswith("__ERR__"):
        return {"_raw_err": out}
    # 例：total = 9216.00M  used = 8406.56M  free = 809.44M  (encrypted)
    m = re.search(r"total = (\d+(?:\.\d+)?)M\s+used = (\d+(?:\.\d+)?)M\s+free = (\d+(?:\.\d+)?)M", out)
    if not m:
        return {"_raw_err": "parse_failed", "raw": out.strip()}
    total = float(m.group(1))
    used = float(m.group(2))
    return {
        "total_mb": total,
        "used_mb": used,
        "free_mb": float(m.group(3)),
        "used_ratio": round(used / total, 3) if total > 0 else None,
    }


def sample_load() -> Optional[List[float]]:
    out = run(["uptime"])
    m = re.search(r"load averages?:\s+([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)", out)
    if m:
        return [float(m.group(1)), float(m.group(2)), float(m.group(3))]
    return None


def sample_top_procs(top_n: int = TOP_N) -> List[Dict[str, Any]]:
    """前 top_n 个 RSS 进程。truncate command 防止行过长。"""
    out = run(["ps", "-Ao", "rss=,pid=,ppid=,pcpu=,comm=,command="])
    if out.startswith("__ERR__"):
        return [{"_raw_err": out}]
    rows: List[Tuple[int, int, int, float, str, str]] = []
    for line in out.splitlines():
        parts = line.strip().split(None, 5)
        if len(parts) < 6:
            continue
        try:
            rss = int(parts[0])
            pid = int(parts[1])
            ppid = int(parts[2])
            pcpu = float(parts[3])
            comm = parts[4]
            cmd = parts[5]
        except ValueError:
            continue
        rows.append((rss, pid, ppid, pcpu, comm, cmd))
    rows.sort(key=lambda r: -r[0])
    result = []
    for rss, pid, ppid, pcpu, comm, cmd in rows[:top_n]:
        result.append({
            "rss_kb": rss,
            "rss_mb": round(rss / 1024, 1),
            "pid": pid,
            "ppid": ppid,
            "pcpu": pcpu,
            "comm": Path(comm).name if "/" in comm else comm,
            "cmd": cmd[:240],
        })
    return result


def tail_heap_stats() -> Optional[Dict[str, Any]]:
    """读 crabot-agent heap-stats.log 最末一条 sample，了解 agent 自身 V8 heap 状态。"""
    if not HEAP_STATS_LOG.exists():
        return None
    try:
        size = HEAP_STATS_LOG.stat().st_size
        with HEAP_STATS_LOG.open("rb") as f:
            f.seek(max(0, size - 8192))
            tail = f.read().decode("utf-8", errors="replace")
        lines = [ln for ln in tail.splitlines() if ln.strip().startswith("{")]
        for line in reversed(lines):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("kind") == "sample":
                return {
                    "ts": r.get("ts"),
                    "pid": r.get("pid"),
                    "uptime_s": r.get("uptime_s"),
                    "rss_mb": r.get("rss_mb"),
                    "heap_used_mb": r.get("heap_used_mb"),
                    "heap_total_mb": r.get("heap_total_mb"),
                    "external_mb": r.get("external_mb"),
                    "array_buffers_mb": r.get("array_buffers_mb"),
                    "heap_size_limit_mb": r.get("heap_size_limit_mb"),
                }
        return None
    except Exception as e:
        return {"_raw_err": str(e)}


def sample_paper_daemon_children() -> Dict[str, Any]:
    """查找 launchctl 注册的 paper-daemon 主 pid + 它当前的活跃子进程。"""
    out = run(["launchctl", "list"])
    pid = None
    for line in out.splitlines():
        if "com.fufu.quant-signal.paper-daemon" in line:
            parts = line.split()
            if parts and parts[0].isdigit():
                pid = int(parts[0])
                break
    if not pid:
        return {"daemon_pid": None, "children": []}
    children_out = run(["pgrep", "-P", str(pid)])
    children_pids = [int(x) for x in children_out.split() if x.isdigit()]
    children = []
    for cpid in children_pids:
        ps_out = run(["ps", "-p", str(cpid), "-o", "rss=,pcpu=,etime=,comm=,command="])
        for line in ps_out.splitlines():
            parts = line.strip().split(None, 4)
            if len(parts) >= 5:
                try:
                    children.append({
                        "pid": cpid,
                        "rss_kb": int(parts[0]),
                        "rss_mb": round(int(parts[0]) / 1024, 1),
                        "pcpu": float(parts[1]),
                        "etime": parts[2],
                        "comm": parts[3],
                        "cmd": parts[4][:200],
                    })
                except ValueError:
                    pass
    return {"daemon_pid": pid, "children": children}


def make_sample() -> Dict[str, Any]:
    return {
        "ts": now_iso(),
        "ts_local": now_local_clock(),
        "ts_unix": int(time.time()),
        "vm": sample_vm_stat(),
        "swap": sample_swap(),
        "load": sample_load(),
        "top": sample_top_procs(),
        "crabot_heap": tail_heap_stats(),
        "paper_daemon": sample_paper_daemon_children(),
    }


def open_log_file() -> Tuple[int, Path]:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"monitor-{datetime.now().strftime('%Y%m%d')}.jsonl"
    path = LOG_DIR / fname
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    return fd, path


def write_sync(fd: int, payload: Dict[str, Any]) -> None:
    """写一行 jsonl，立即 fsync 保证 panic 时数据不丢。"""
    line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    os.write(fd, line)
    os.fsync(fd)


def write_pid_file() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")


def remove_pid_file() -> None:
    try:
        if PID_FILE.exists() and PID_FILE.read_text().strip() == str(os.getpid()):
            PID_FILE.unlink()
    except Exception:
        pass


def main() -> int:
    try:
        os.nice(10)
    except Exception:
        pass

    running = True

    def stop(signum, frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    write_pid_file()
    fd, path = open_log_file()

    # 起手记录一次"启动"事件，方便事后定位
    write_sync(fd, {
        "ts": now_iso(),
        "ts_local": now_local_clock(),
        "ts_unix": int(time.time()),
        "_event": "monitor_started",
        "pid": os.getpid(),
        "interval_s": SAMPLE_INTERVAL,
        "top_n": TOP_N,
        "log_path": str(path),
    })

    current_day = datetime.now().strftime("%Y%m%d")

    while running:
        try:
            # 跨天切日志
            today = datetime.now().strftime("%Y%m%d")
            if today != current_day:
                os.close(fd)
                fd, path = open_log_file()
                current_day = today
            sample = make_sample()
            write_sync(fd, sample)
        except Exception as e:
            try:
                write_sync(fd, {
                    "ts": now_iso(),
                    "_event": "sample_error",
                    "error": str(e),
                })
            except Exception:
                pass
        # sleep — 不用 sleep 整段，以便能尽快响应 SIGTERM
        for _ in range(SAMPLE_INTERVAL):
            if not running:
                break
            time.sleep(1)

    write_sync(fd, {
        "ts": now_iso(),
        "_event": "monitor_stopped",
        "pid": os.getpid(),
    })
    os.close(fd)
    remove_pid_file()
    return 0


if __name__ == "__main__":
    sys.exit(main())
