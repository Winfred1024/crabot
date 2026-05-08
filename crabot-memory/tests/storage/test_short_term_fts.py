"""ShortTermStore FTS5 集成测试。"""
import asyncio
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


def test_fts_chinese_multi_word_recall(store):
    asyncio.run(store.add_short_term(_make_entry(
        "m1", "GitHub 排行榜每日早报已发送到微信群", topic="GitHub 早报",
    )))
    asyncio.run(store.add_short_term(_make_entry(
        "m2", "list_groups 失败 改用 list_sessions 兜底成功", topic="排查失败",
    )))
    asyncio.run(store.add_short_term(_make_entry(
        "m3", "quant-signal 持续策略收益迭代", topic="quant 策略",
    )))

    results = asyncio.run(store.search_short_term(query="GitHub 微信群", limit=10))
    ids = [r.id for r in results]
    assert "m1" in ids, "GitHub + 微信群 双词应命中 m1"
    assert "m3" not in ids, "无关条目不应命中"


def test_fts_keyword_field_searchable(store):
    asyncio.run(store.add_short_term(_make_entry(
        "m1", "完成内容", keywords=["GitHub", "排行榜"],
    )))

    results = asyncio.run(store.search_short_term(query="GitHub", limit=10))
    assert len(results) == 1
    assert results[0].id == "m1", "keywords 字段应进入 FTS 索引"


def test_fts_bm25_relevance_ordering(store):
    asyncio.run(store.add_short_term(_make_entry(
        "m_strong", "list_groups 失败 list_groups 排查 list_groups 兜底",
    )))
    asyncio.run(store.add_short_term(_make_entry(
        "m_weak", "list_groups 一笔带过的提及",
    )))

    results = asyncio.run(store.search_short_term(
        query="list_groups", sort_by="relevance", limit=10,
    ))
    ids = [r.id for r in results]
    assert ids[0] == "m_strong", "高频命中条目应排首位"


def test_fts_special_chars_in_query_no_error(store):
    """FTS5 特殊字符（"、(、)）经 _escape_fts_query 转义后不应触发 syntax error。"""
    asyncio.run(store.add_short_term(_make_entry(
        "m1", "test content with special chars",
    )))

    # 不抛异常即可（_escape_fts_query 会丢弃所有 FTS5 特殊字符）
    asyncio.run(store.search_short_term(query='test "quoted"', limit=10))
    asyncio.run(store.search_short_term(query="(hello)", limit=10))


def test_fts_empty_query_falls_back_to_time_order(store):
    asyncio.run(store.add_short_term(_make_entry("m1", "first")))
    asyncio.run(store.add_short_term(_make_entry("m2", "second")))

    results = asyncio.run(store.search_short_term(query=None, limit=10))
    assert len(results) == 2  # 两条都返回，按 event_time DESC


def test_fts_au_trigger_via_raw_update(store):
    """AU trigger 通过 raw UPDATE 触发；add_short_term 走 INSERT OR REPLACE 不会经 AU trigger。"""
    entry = _make_entry("m1", "old content", topic="old topic")
    asyncio.run(store.add_short_term(entry))

    # raw UPDATE 触发 AU trigger
    store._conn.execute(
        "UPDATE short_term_memory SET content = ?, topic = ? WHERE id = ?",
        ("new content with GitHub", "new topic", "m1"),
    )
    store._conn.commit()

    # FTS 应反映新内容
    results = asyncio.run(store.search_short_term(query="GitHub", limit=10))
    assert len(results) == 1
    assert results[0].id == "m1"

    # 旧内容应已不可搜
    old_results = asyncio.run(store.search_short_term(query="old", limit=10))
    assert all(r.id != "m1" for r in old_results) or len(old_results) == 0


def test_fts_pure_chinese_query_recalls(store):
    """trigram 应当让纯中文 query 也能召回（unicode61 在此处会失效，故这是分水岭测试）。"""
    asyncio.run(store.add_short_term(_make_entry(
        "m1", "排行榜每日早报已发送到微信群",
    )))
    asyncio.run(store.add_short_term(_make_entry(
        "m2", "quant-signal 持续策略收益迭代",
    )))
    # 4 字纯中文 query
    results = asyncio.run(store.search_short_term(query="微信群", limit=10))
    ids = [r.id for r in results]
    assert "m1" in ids, "纯中文 3-gram query 应命中 m1"
    assert "m2" not in ids


def test_fts_short_query_falls_through(store):
    """trigram 固有限制：<3 字符 query 不会命中任何条目。当前实现下应安全退化。"""
    asyncio.run(store.add_short_term(_make_entry("m1", "微信群相关内容")))

    # 2 字 CJK query → _escape_fts_query 返回空 → 不走 FTS path → 退化到 event_time DESC
    # 行为是返回所有可见条目（忽略 query 意图）—— 本测试锁住该折衷
    results = asyncio.run(store.search_short_term(query="微信", limit=10))
    assert len(results) == 1, "退化路径应返回全部 1 条"
    assert results[0].id == "m1", "退化路径不是因 query 命中，是因 fallback"
