# panic-monitor

为复盘 macOS kernel watchdog panic 设计的系统监控脚本。每 5 秒采一次：vm_stat / 
swap / load / 前 30 RSS 进程 / crabot-agent heap-stats / paper_daemon 子进程。
每条记录写完立刻 fsync，panic 后磁盘上能保留临界时刻的全部上下文。

## 用法

```bash
# 启动
scripts/panic-monitor/start.sh

# 跑业务（开 crabot，让 crabot 接任务，等 panic）
./dev.sh

# panic 后机器重启，分析最后 N 条 sample
scripts/panic-monitor/analyze.py --tail 60

# 或者围绕 panic 时刻 ±5 分钟
scripts/panic-monitor/analyze.py --around "2026-06-07T02:32"

# 看 top 进程 RSS 涨幅 / paper_daemon 子进程
scripts/panic-monitor/analyze.py --tail 120 --top-procs

# 停止（手动复盘完想清掉）
scripts/panic-monitor/stop.sh
```

## 文件位置

- 日志：`~/Library/Logs/crabot-panic-monitor/monitor-YYYYMMDD.jsonl`（按天切）
- pid 文件：`~/Library/Logs/crabot-panic-monitor/monitor.pid`
- stdout/stderr：同目录下 `stdout.log` / `stderr.log`

## 采样格式（单条 jsonl）

```json
{
  "ts": "2026-06-07T01:32:17.123Z",
  "ts_local": "2026-06-07 09:32:17",
  "ts_unix": 1780777937,
  "vm": {
    "page_size": 16384,
    "pages_free": 384240,
    "free_mb": 5754.0,
    "pages_stored_in_compressor": 1395553,
    "occupied_by_compressor_mb": 2724.2,
    ...
  },
  "swap": { "total_mb": 9216, "used_mb": 8406, "free_mb": 809, "used_ratio": 0.912 },
  "load": [12.5, 10.3, 8.1],
  "top": [
    {"pid": 4043, "ppid": 1, "rss_mb": 1413.7, "pcpu": 95.2, "comm": "python3",
     "cmd": "/Users/fufu/miniforge3/bin/python3 scripts/build_backtest_dashboard.py"},
    ...
  ],
  "crabot_heap": {
    "ts": "2026-06-07T01:32:15Z", "pid": 62225, "uptime_s": 12345,
    "rss_mb": 1208, "heap_used_mb": 1090, "external_mb": 27
  },
  "paper_daemon": {
    "daemon_pid": 4043,
    "children": [
      {"pid": 87082, "rss_mb": 1413.7, "pcpu": 95.2, "etime": "00:14",
       "comm": "python3", "cmd": "scripts/build_backtest_dashboard.py"}
    ]
  }
}
```

## 设计要点

- **每行 `os.fsync`**：panic 时 OS page cache 里没刷盘的数据会丢，必须强制写盘。`kill -9`
  模拟硬切验证过：截止前最后一次 sample 完整可读。
- **`os.nice(10)`**：脚本本身优先级低，不在系统压力大时反而抢资源恶化情况。
- **按天分文件**：跨天自动新开 jsonl，避免单文件涨到几百 MB。
- **轻量**：5 秒一条 × 每条 ~2-5 KB → 一天 30-80 MB，可接受。
- **使用系统 Python**：`/usr/bin/python3`（3.9），不依赖 miniforge / pnpm 等业务环境。

## 不抓什么

- 不抓所有进程的完整 cmdline（只 top 30，且 cmd 截 240 字符）
- 不抓 GPU 内存（macOS 没有简单的命令）
- 不抓内核态详细堆栈（panic 报告自带）
- 不打开任何 socket / 网络

## 复盘 panic 的标准流程

1. `scripts/panic-monitor/analyze.py --around "<panic_time_from_ips_report>"`
2. 看 swap_used% 何时穿 85%、load1 何时起飞
3. `--top-procs` 看哪个 pid RSS 涨得最快
4. 对照 `crabot_heap` 看 agent 自己 V8 heap 在那段时间的轨迹
5. 对照 `paper_daemon.children` 看 dashboard 类 spawn 的频率和单进程 RSS 峰值
