"""P2: links 表索引测试。"""
import tempfile, os
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, MemoryLink


def _entry(mem_id, links=None):
    fm = MemoryFrontmatter(
        id=mem_id, type="fact", maturity="confirmed", brief=f"b-{mem_id}", author="agent:test",
        source_ref=SourceRef(type="reflection"), source_trust=5, content_confidence=5,
        importance_factors=ImportanceFactors(proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5),
        event_time="2026-06-01T00:00:00Z", ingestion_time="2026-06-01T00:00:00Z",
        links=[MemoryLink(**l) for l in (links or [])],
    )
    return MemoryEntry(frontmatter=fm, body="")


def _idx():
    d = tempfile.mkdtemp()
    return SqliteIndex(os.path.join(d, "t.db"))


def test_links_table_populated_on_upsert():
    idx = _idx()
    idx.upsert(_entry("mem-l-a", links=[{"target": "mem-l-b", "relation": "refines"}]), path="/a.md", status="confirmed")
    assert idx.find_links_from("mem-l-a") == [{"target": "mem-l-b", "relation": "refines"}]
    assert idx.find_links_to("mem-l-b") == ["mem-l-a"]


def test_links_rewritten_on_reupsert():
    idx = _idx()
    idx.upsert(_entry("mem-l-a", links=[{"target": "mem-l-b", "relation": "refines"}]), path="/a.md", status="confirmed")
    idx.upsert(_entry("mem-l-a", links=[{"target": "mem-l-c", "relation": "part_of"}]), path="/a.md", status="confirmed")
    assert idx.find_links_from("mem-l-a") == [{"target": "mem-l-c", "relation": "part_of"}]
    assert idx.find_links_to("mem-l-b") == []


def test_links_cleared_on_delete():
    idx = _idx()
    idx.upsert(_entry("mem-l-a", links=[{"target": "mem-l-b", "relation": "related"}]), path="/a.md", status="confirmed")
    idx.delete("mem-l-a")
    assert idx.find_links_from("mem-l-a") == []
    assert idx.find_links_to("mem-l-b") == []
