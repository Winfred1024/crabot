"""P1: 召回过时 honor 测试。"""
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors,
)
from src.long_term_v2.recall_pipeline import RecallPipeline


def _mk(mem_id, type_="fact", maturity="confirmed", invalidated_by=None):
    fm = MemoryFrontmatter(
        id=mem_id, type=type_, maturity=maturity, brief=f"brief-{mem_id}",
        author="agent:test",
        source_ref=SourceRef(type="reflection"),
        source_trust=5, content_confidence=5,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-06-01T00:00:00Z", ingestion_time="2026-06-01T00:00:00Z",
        invalidated_by=invalidated_by,
    )
    return MemoryEntry(frontmatter=fm, body="")


class _FakeIndex:
    def __init__(self, locs):
        self._locs = locs  # id -> (status, type)

    def locate(self, mid):
        if mid in self._locs:
            s, t = self._locs[mid]
            return (s, t, f"/{mid}.md")
        return None


class _FakeStore:
    def __init__(self, entries):
        self._entries = entries  # id -> MemoryEntry

    def read(self, status, type_, mid):
        return self._entries[mid]


def _pipeline(entries, locs):
    return RecallPipeline(store=_FakeStore(entries), index=_FakeIndex(locs))


def test_enrich_exposes_maturity_and_invalidated_by():
    e = _mk("mem-l-aaa", maturity="stale", invalidated_by="mem-l-bbb")
    p = _pipeline({"mem-l-aaa": e}, {"mem-l-aaa": ("confirmed", "fact")})
    out = p._enrich([("mem-l-aaa", 1.0, ["sparse"])], in_time_window_ids=set())
    assert out[0]["maturity"] == "stale"
    assert out[0]["invalidated_by"] == "mem-l-bbb"
