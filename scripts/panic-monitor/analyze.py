#!/usr/bin/env python3
"""
panic 后分析监控日志：
- 输入：可选 panic 时间戳（CST 或 UTC，自动检测）；不传则用最新一条 sample
- 输出：
  - 最后 N 条 sample 的 swap/load/crabot heap 简表
  - Top 进程趋势（哪个 RSS 最大、哪个 RSS 涨得最快）
  - 关键报警时刻（swap > 90%、load > N、compressor segments > X）
用法：
    ./analyze.py                              # 用最新 jsonl，列最后 30 条
    ./analyze.py --tail 60                    # 看最后 60 条
    ./analyze.py --around "2026-06-07T02:32"  # 围绕 panic 时刻前后 5 分钟
    ./analyze.py --file path/to/monitor.jsonl --top-procs   # 列 top 进程随时间的 RSS 变化
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


LOG_DIR = Path.home() / "Library" / "Logs" / "crabot-panic-monitor"


def find_latest_log() -> Path:
    files = sorted(LOG_DIR.glob("monitor-*.jsonl"))
    if not files:
        sys.exit(f"找不到 jsonl 文件，看 {LOG_DIR}")
    return files[-1]


def load_samples(path: Path) -> List[Dict[str, Any]]:
    samples: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            samples.append(r)
    return samples


def filter_data(samples: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [s for s in samples if "_event" not in s and "vm" in s]


def parse_iso(s: str) -> datetime:
    """支持 'Z' 结尾或带时区的 ISO；naive 视作 UTC。"""
    if s.endswith("Z"):
        return datetime.fromisoformat(s[:-1]).replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        # 兼容 "2026-06-07T02:32" 或 "2026-06-07 02:32"
        norm = s.replace(" ", "T")
        if "T" not in norm:
            sys.exit(f"无法解析时间 {s}")
        try:
            return datetime.fromisoformat(norm).replace(tzinfo=timezone.utc)
        except ValueError:
            sys.exit(f"无法解析时间 {s}")


def filter_window(samples: List[Dict[str, Any]], around: Optional[str], tail: int) -> List[Dict[str, Any]]:
    if not around:
        return samples[-tail:]
    target = parse_iso(around)
    target_ts = target.timestamp()
    # 默认窗口 ±5 分钟
    window = 300
    return [s for s in samples if abs(s.get("ts_unix", 0) - target_ts) <= window]


def fmt_clock(s: Dict[str, Any]) -> str:
    return s.get("ts_local") or s.get("ts", "")[:19]


def fmt_num(val, spec: str = "{:.0f}", dash: str = "-") -> str:
    return spec.format(val) if val is not None else dash


def print_summary(samples: List[Dict[str, Any]]) -> None:
    print(f"=== summary ({len(samples)} samples) ===")
    print(f"{'time':19s}  {'swap%':>6s}  {'load1':>6s}  {'crabot_rss':>10s}  {'crabot_heap':>11s}  {'free_mb':>8s}  {'compr_mb':>9s}  daemon_kids  top1_proc(rss_mb)")
    for s in samples:
        swap = s.get("swap", {}) or {}
        swap_ratio = swap.get("used_ratio")
        load = (s.get("load") or [None, None, None])
        crabot = s.get("crabot_heap") or {}
        vm = s.get("vm", {}) or {}
        free_mb = vm.get("free_mb")
        compressed_mb = vm.get("occupied_by_compressor_mb")
        kids = len((s.get("paper_daemon") or {}).get("children") or [])
        top = s.get("top") or []
        top1 = ""
        if top:
            top1 = f"{top[0].get('comm')}({top[0].get('rss_mb')})"
        swap_pct = swap_ratio * 100 if swap_ratio is not None else None
        crabot_rss = crabot.get("rss_mb")
        crabot_heap = crabot.get("heap_used_mb")
        print(
            f"{fmt_clock(s):19s}  "
            f"{fmt_num(swap_pct, '{:.1f}'):>6s}  "
            f"{fmt_num(load[0], '{:.2f}'):>6s}  "
            f"{fmt_num(crabot_rss):>10s}  "
            f"{fmt_num(crabot_heap):>11s}  "
            f"{fmt_num(free_mb):>8s}  "
            f"{fmt_num(compressed_mb):>9s}  "
            f"{kids:>11d}  "
            f"{top1}"
        )


def print_alerts(samples: List[Dict[str, Any]]) -> None:
    print("\n=== 报警事件（swap_used > 85% / load1 > 10 / compressor 段 > 80%） ===")
    last_alert = None
    for s in samples:
        ts = fmt_clock(s)
        swap = s.get("swap") or {}
        sr = swap.get("used_ratio") or 0
        load = (s.get("load") or [0])[0] or 0
        reasons = []
        if sr > 0.85:
            reasons.append(f"swap={sr*100:.1f}%")
        if load > 10:
            reasons.append(f"load1={load:.2f}")
        if reasons and ts != last_alert:
            print(f"  {ts}  {' | '.join(reasons)}")
            last_alert = ts


def print_top_procs_trend(samples: List[Dict[str, Any]], n: int = 8) -> None:
    """统计每个进程在窗口内 RSS 峰值，并列出涨幅最大的几个。"""
    if not samples:
        return
    by_pid_max: Dict[int, Dict[str, Any]] = {}
    by_pid_first: Dict[int, float] = {}
    for s in samples:
        for p in (s.get("top") or []):
            pid = p.get("pid")
            if pid is None:
                continue
            rss = p.get("rss_mb", 0)
            if pid not in by_pid_first:
                by_pid_first[pid] = rss
            cur = by_pid_max.get(pid)
            if cur is None or rss > cur["rss_mb_peak"]:
                by_pid_max[pid] = {
                    "pid": pid,
                    "comm": p.get("comm"),
                    "cmd_short": (p.get("cmd") or "")[:120],
                    "rss_mb_peak": rss,
                    "rss_mb_first": by_pid_first[pid],
                    "rss_mb_delta": round(rss - by_pid_first[pid], 1),
                }
    print(f"\n=== top {n} by peak RSS in window ===")
    rows = sorted(by_pid_max.values(), key=lambda r: -r["rss_mb_peak"])[:n]
    for r in rows:
        print(f"  pid={r['pid']:>6d}  peak={r['rss_mb_peak']:>7.1f} MB  delta={r['rss_mb_delta']:+.1f} MB  comm={r['comm']:<25} cmd={r['cmd_short']}")
    print(f"\n=== top {n} by RSS growth in window ===")
    rows = sorted(by_pid_max.values(), key=lambda r: -r["rss_mb_delta"])[:n]
    for r in rows:
        print(f"  pid={r['pid']:>6d}  delta={r['rss_mb_delta']:+8.1f} MB  start={r['rss_mb_first']:.0f} → peak={r['rss_mb_peak']:.0f} MB  comm={r['comm']:<25} cmd={r['cmd_short']}")


def print_paper_daemon_kids(samples: List[Dict[str, Any]]) -> None:
    """daemon 子进程在窗口内总频率 + peak RSS 分布。"""
    spawn_count = 0
    seen_kids: Dict[int, Dict[str, Any]] = {}
    for s in samples:
        kids = (s.get("paper_daemon") or {}).get("children") or []
        for k in kids:
            pid = k.get("pid")
            if pid is None:
                continue
            spawn_count += 1
            cur = seen_kids.get(pid)
            if cur is None or (k.get("rss_mb", 0) > cur.get("rss_mb", 0)):
                seen_kids[pid] = k
    print(f"\n=== paper_daemon children seen in window: {len(seen_kids)} unique pids, {spawn_count} samples ===")
    rows = sorted(seen_kids.values(), key=lambda r: -r.get("rss_mb", 0))[:10]
    for k in rows:
        print(f"  pid={k.get('pid'):>6d}  rss_peak={k.get('rss_mb', 0):>7.1f} MB  comm={k.get('comm','?'):<20s}  cmd={(k.get('cmd') or '')[:100]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", type=Path, help="指定 jsonl 文件（默认用最新）")
    ap.add_argument("--tail", type=int, default=30, help="不指定 --around 时，看最后 N 条")
    ap.add_argument("--around", type=str, help="围绕这个时间 ±5 分钟的 sample（如 '2026-06-07T02:32'）")
    ap.add_argument("--top-procs", action="store_true", help="列 top 进程峰值/涨幅趋势")
    args = ap.parse_args()

    path = args.file or find_latest_log()
    print(f"reading: {path}")
    all_samples = load_samples(path)
    data = filter_data(all_samples)
    print(f"total data samples: {len(data)} (events: {len(all_samples) - len(data)})")
    selected = filter_window(data, args.around, args.tail)
    print(f"selected: {len(selected)} samples\n")
    print_summary(selected)
    print_alerts(selected)
    if args.top_procs:
        print_top_procs_trend(selected)
        print_paper_daemon_kids(selected)
    return 0


if __name__ == "__main__":
    sys.exit(main())
