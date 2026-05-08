"""crabot-memory v3 → v4 升级脚本单元测试。"""
import sqlite3
from pathlib import Path

import pytest

from upgrade.from_v3_to_v4 import migrate, build_fts_index


def _make_v3_db(db_path: Path) -> None:
    """构造一个 v3 schema 的 short_term.db（无 FTS）。"""
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE short_term_memory (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            keywords TEXT NOT NULL DEFAULT '[]',
            event_time TEXT NOT NULL,
            persons TEXT NOT NULL DEFAULT '[]',
            entities TEXT NOT NULL DEFAULT '[]',
            topic TEXT,
            source_type TEXT,
            source_json TEXT NOT NULL,
            refs_json TEXT,
            compressed INTEGER NOT NULL DEFAULT 0,
            visibility TEXT NOT NULL,
            scopes TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL
        )
    """)
    conn.execute(
        "INSERT INTO short_term_memory (id, content, keywords, event_time, source_json, visibility, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("m1", "GitHub 排行榜每日早报", '["GitHub","早报"]', "2026-05-01T00:00:00Z",
         '{"type":"conversation"}', "public", "2026-05-01T00:00:00Z"),
    )
    conn.commit()
    conn.close()


def test_build_fts_creates_table_and_indexes(tmp_path):
    db = tmp_path / "short_term.db"
    _make_v3_db(db)

    log = []
    build_fts_index(db, log)

    conn = sqlite3.connect(str(db))
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE name = 'short_term_fts'"
    ).fetchone()
    assert row is not None, "FTS 虚拟表应被创建"

    fts_count = conn.execute("SELECT COUNT(*) FROM short_term_fts").fetchone()[0]
    assert fts_count == 1, "FTS 索引应被 rebuild 包含已有数据"

    # 验证 trigram 切分能工作（需 ≥3 字符 token）
    match_rows = conn.execute(
        "SELECT m.id FROM short_term_memory m JOIN short_term_fts f ON f.rowid = m.rowid "
        "WHERE short_term_fts MATCH ?",
        ('"GitHub"',),
    ).fetchall()
    assert any(r[0] == "m1" for r in match_rows), "升级后应能 MATCH 到老数据"
    conn.close()


def test_migrate_creates_backup_and_writes_version(tmp_path):
    data_dir = tmp_path / "memory"
    data_dir.mkdir()
    db = data_dir / "short_term.db"
    _make_v3_db(db)

    log = migrate(data_dir)

    backups = list(data_dir.glob("short_term.db.v3.backup-*"))
    assert len(backups) == 1, "升级应生成一个 v3 备份"

    version_file = data_dir / "SCHEMA_VERSION"
    assert version_file.exists()
    assert version_file.read_text().strip() == "v4"

    assert any("FTS rebuild" in line for line in log)


def test_migrate_idempotent_when_already_v4(tmp_path):
    """已升级过的库再跑一次不应报错或损坏数据（DROP IF EXISTS + 重建）。"""
    data_dir = tmp_path / "memory"
    data_dir.mkdir()
    db = data_dir / "short_term.db"
    _make_v3_db(db)

    migrate(data_dir)
    # 再次跑应该不报错且 FTS 仍有 1 行索引
    migrate(data_dir)

    conn = sqlite3.connect(str(db))
    fts_count = conn.execute("SELECT COUNT(*) FROM short_term_fts").fetchone()[0]
    assert fts_count == 1
    conn.close()


def test_migrate_handles_missing_db(tmp_path):
    """data_dir 没有 short_term.db 时不应崩溃（首次部署场景）。"""
    data_dir = tmp_path / "memory"
    data_dir.mkdir()

    log = migrate(data_dir)
    # SCHEMA_VERSION 仍写入
    assert (data_dir / "SCHEMA_VERSION").read_text().strip() == "v4"
    # 无 backup 生成
    assert len(list(data_dir.glob("short_term.db.v3.backup-*"))) == 0
