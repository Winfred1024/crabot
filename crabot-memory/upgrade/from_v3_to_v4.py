"""crabot-memory v3 → v4: 短期记忆 FTS5 召回升级。

操作：
1. 备份 data/memory/short_term.db → short_term.db.v3.backup-{ts}
2. 在原库 DROP（若存在）+ 重建 FTS5 虚拟表 + 3 个 trigger（trigram tokenizer）
3. INSERT INTO short_term_fts(short_term_fts) VALUES('rebuild') 全量重建索引
4. 写 SCHEMA_VERSION 到 v4

幂等：脚本反复跑安全 —— DROP IF EXISTS 后重建。
回滚（手工）：drop FTS 虚拟表 + trigger，SCHEMA_VERSION 回 v3，应用层 git revert。

Tokenizer 选 trigram 而非 unicode61：unicode61 不切 CJK 连续字符串，导致中文 query 0 命中。
详见 crabot-docs/superpowers/specs/2026-05-08-short-term-memory-sop-and-fts-design.md §3.3。

Usage: uv run python crabot-memory/upgrade/from_v3_to_v4.py --data-dir=<path>
"""
import argparse
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional


def _now_ts() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def backup_short_term(db_path: Path, log: List[str]) -> Optional[Path]:
    if not db_path.exists():
        log.append(f"short_term.db: not present at {db_path}, skipped backup")
        return None
    backup = db_path.with_name(f"{db_path.name}.v3.backup-{_now_ts()}")
    shutil.copy2(db_path, backup)
    log.append(f"short_term.db: backed up to {backup.name}")
    return backup


def build_fts_index(db_path: Path, log: List[str]) -> None:
    if not db_path.exists():
        log.append("short_term.db: not present, skipping FTS build")
        return

    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        # 幂等：先 drop 现有的 FTS 表 + trigger 再重建
        cur.execute("DROP TRIGGER IF EXISTS short_term_ai")
        cur.execute("DROP TRIGGER IF EXISTS short_term_ad")
        cur.execute("DROP TRIGGER IF EXISTS short_term_au")
        cur.execute("DROP TABLE IF EXISTS short_term_fts")

        cur.execute("""
            CREATE VIRTUAL TABLE short_term_fts USING fts5(
                content,
                topic,
                keywords,
                content='short_term_memory',
                content_rowid='rowid',
                tokenize='trigram'
            )
        """)
        cur.execute("""
            CREATE TRIGGER short_term_ai
            AFTER INSERT ON short_term_memory BEGIN
                INSERT INTO short_term_fts(rowid, content, topic, keywords)
                VALUES (new.rowid, new.content, COALESCE(new.topic, ''), new.keywords);
            END
        """)
        cur.execute("""
            CREATE TRIGGER short_term_ad
            AFTER DELETE ON short_term_memory BEGIN
                INSERT INTO short_term_fts(short_term_fts, rowid, content, topic, keywords)
                VALUES ('delete', old.rowid, old.content, COALESCE(old.topic, ''), old.keywords);
            END
        """)
        cur.execute("""
            CREATE TRIGGER short_term_au
            AFTER UPDATE ON short_term_memory BEGIN
                INSERT INTO short_term_fts(short_term_fts, rowid, content, topic, keywords)
                VALUES ('delete', old.rowid, old.content, COALESCE(old.topic, ''), old.keywords);
                INSERT INTO short_term_fts(rowid, content, topic, keywords)
                VALUES (new.rowid, new.content, COALESCE(new.topic, ''), new.keywords);
            END
        """)
        cur.execute("INSERT INTO short_term_fts(short_term_fts) VALUES('rebuild')")
        conn.commit()
        count = cur.execute("SELECT COUNT(*) FROM short_term_fts").fetchone()[0]
        log.append(f"short_term.db: FTS rebuild done, {count} rows indexed")
    finally:
        conn.close()


def write_schema_version(data_dir: Path, log: List[str]) -> None:
    version_file = data_dir / "SCHEMA_VERSION"
    version_file.write_text("v4\n", encoding="utf-8")
    log.append(f"SCHEMA_VERSION: written v4 to {version_file}")


def migrate(data_dir: Path) -> List[str]:
    log: List[str] = []
    log.append(f"=== v3 → v4 migration started at {datetime.now().isoformat()} ===")
    db = data_dir / "short_term.db"
    backup_short_term(db, log)
    build_fts_index(db, log)
    write_schema_version(data_dir, log)
    log.append(f"=== v3 → v4 migration completed at {datetime.now().isoformat()} ===")

    log_file = data_dir / "upgrade-v3-to-v4.log"
    log_file.write_text("\n".join(log) + "\n", encoding="utf-8")
    return log


def main() -> int:
    parser = argparse.ArgumentParser(description="crabot-memory v3 → v4 upgrade")
    parser.add_argument("--data-dir", required=True, help="memory data directory")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).resolve()
    if not data_dir.exists():
        print(f"data dir not found: {data_dir}", file=sys.stderr)
        return 1

    log = migrate(data_dir)
    for line in log:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
