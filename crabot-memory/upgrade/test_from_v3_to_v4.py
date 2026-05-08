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


def test_migrate_creates_backup_and_logs_rebuild(tmp_path):
    """SCHEMA_VERSION 由 upgrade framework 回写，本脚本只负责备份 + 重建索引。"""
    data_dir = tmp_path / "memory"
    data_dir.mkdir()
    db = data_dir / "short_term.db"
    _make_v3_db(db)

    log = migrate(data_dir)

    backups = list(data_dir.glob("short_term.db.v3.backup-*"))
    assert len(backups) == 1, "升级应生成一个 v3 备份"

    assert any("FTS rebuild" in line for line in log)
    assert (data_dir / "upgrade-v3-to-v4.log").exists()


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

    migrate(data_dir)

    assert len(list(data_dir.glob("short_term.db.v3.backup-*"))) == 0
    assert (data_dir / "upgrade-v3-to-v4.log").exists()


def test_build_fts_rolls_back_on_rebuild_failure(tmp_path, monkeypatch):
    """模拟 INSERT 'rebuild' 失败：transaction 应回滚，DB 不应留下 FTS 表 + trigger 残骸。"""
    db = tmp_path / "short_term.db"
    _make_v3_db(db)

    # 替换 sqlite3.connect：返回 wrapper，让 cursor.execute 在看到 'rebuild' 时抛异常
    real_connect = sqlite3.connect

    class _FailingCursor:
        def __init__(self, real_cur):
            self._real = real_cur

        def execute(self, sql, *params):
            if "VALUES('rebuild')" in sql:
                raise sqlite3.OperationalError("simulated rebuild failure")
            return self._real.execute(sql, *params)

        def fetchone(self):
            return self._real.fetchone()

        def fetchall(self):
            return self._real.fetchall()

        def __getattr__(self, name):
            return getattr(self._real, name)

    class _ConnWrapper:
        def __init__(self, real_conn):
            self._real = real_conn

        def cursor(self):
            return _FailingCursor(self._real.cursor())

        def __getattr__(self, name):
            return getattr(self._real, name)

    def fake_connect(path, *args, **kwargs):
        return _ConnWrapper(real_connect(path, *args, **kwargs))

    monkeypatch.setattr("upgrade.from_v3_to_v4.sqlite3.connect", fake_connect)

    log = []
    with pytest.raises(sqlite3.OperationalError):
        build_fts_index(db, log)

    # 关键验证：transaction 回滚后，DB 里不应有 FTS 表或 trigger 残骸
    conn = sqlite3.connect(str(db))
    fts_table = conn.execute(
        "SELECT name FROM sqlite_master WHERE name = 'short_term_fts'"
    ).fetchone()
    assert fts_table is None, "rollback 后 FTS 表不应存在"

    triggers = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='short_term_memory'"
    ).fetchall()
    assert len(triggers) == 0, f"rollback 后不应有 trigger 残骸，实际：{[t[0] for t in triggers]}"

    # 主表数据应原封不动
    count = conn.execute("SELECT COUNT(*) FROM short_term_memory").fetchone()[0]
    assert count == 1, "主表数据不应受影响"
    conn.close()
