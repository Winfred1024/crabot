"""ShortTermStore FTS5 集成测试。"""
import asyncio
import json
from datetime import datetime, timezone

import pytest

from src.storage.short_term_store import ShortTermStore
from src.types import MemorySource, ShortTermMemoryEntry


def _make_entry(id_: str, content: str, topic: str = "", keywords=None) -> ShortTermMemoryEntry:
    return ShortTermMemoryEntry(
        id=id_,
        content=content,
        keywords=keywords or [],
        event_time=datetime.now(timezone.utc).isoformat(),
        persons=[],
        entities=[],
        topic=topic,
        source=MemorySource(type="conversation"),
        refs={},
        compressed=False,
        visibility="public",
        scopes=[],
        created_at=datetime.now(timezone.utc).isoformat(),
    )


@pytest.fixture
def store(tmp_path):
    return ShortTermStore(str(tmp_path / "short_term.db"))


def _table_exists(store, name: str) -> bool:
    row = store._conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','virtual') AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def test_fts_virtual_table_created_on_init(store):
    assert _table_exists(store, "short_term_fts"), "short_term_fts 虚拟表应存在"


def test_fts_triggers_created_on_init(store):
    rows = store._conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'short_term_memory'"
    ).fetchall()
    names = {row["name"] for row in rows}
    assert {"short_term_ai", "short_term_ad", "short_term_au"}.issubset(names)


def test_fts_insert_trigger_syncs_row(store):
    entry = _make_entry("m1", "GitHub 排行榜每日早报已发送到微信群", topic="GitHub 早报")
    asyncio.run(store.add_short_term(entry))

    fts_count = store._conn.execute(
        "SELECT COUNT(*) AS c FROM short_term_fts"
    ).fetchone()["c"]
    assert fts_count == 1


def test_fts_delete_trigger_syncs_row(store):
    entry = _make_entry("m1", "GitHub 排行榜每日早报")
    asyncio.run(store.add_short_term(entry))
    asyncio.run(store.delete_by_id("m1"))

    fts_count = store._conn.execute(
        "SELECT COUNT(*) AS c FROM short_term_fts"
    ).fetchone()["c"]
    assert fts_count == 0
