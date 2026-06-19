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


def test_resolve_live_follows_chain_to_newest():
    a = _mk("mem-l-a", invalidated_by="mem-l-b")
    b = _mk("mem-l-b", invalidated_by="mem-l-c")
    c = _mk("mem-l-c")  # 终点：无 invalidated_by
    p = _pipeline(
        {"mem-l-a": a, "mem-l-b": b, "mem-l-c": c},
        {"mem-l-a": ("confirmed", "fact"), "mem-l-b": ("confirmed", "fact"),
         "mem-l-c": ("confirmed", "fact")},
    )
    live = p._resolve_live("mem-l-a")
    assert live is not None
    assert live[2].frontmatter.id == "mem-l-c"


def test_resolve_live_returns_none_when_successor_in_trash():
    a = _mk("mem-l-a", invalidated_by="mem-l-b")
    b = _mk("mem-l-b")
    p = _pipeline(
        {"mem-l-a": a, "mem-l-b": b},
        {"mem-l-a": ("confirmed", "fact"), "mem-l-b": ("trash", "fact")},
    )
    assert p._resolve_live("mem-l-a") is None


def test_resolve_live_breaks_cycle():
    a = _mk("mem-l-a", invalidated_by="mem-l-b")
    b = _mk("mem-l-b", invalidated_by="mem-l-a")
    p = _pipeline(
        {"mem-l-a": a, "mem-l-b": b},
        {"mem-l-a": ("confirmed", "fact"), "mem-l-b": ("confirmed", "fact")},
    )
    assert p._resolve_live("mem-l-a") is None


def test_policy_drops_stale_and_retired():
    p = _pipeline({}, {})
    cands = [
        {"id": "m1", "maturity": "confirmed", "invalidated_by": None, "score": 1.0},
        {"id": "m2", "maturity": "stale", "invalidated_by": None, "score": 0.9},
        {"id": "m3", "maturity": "retired", "invalidated_by": None, "score": 0.8},
    ]
    out = p._apply_outdated_policy(cands, include_outdated=False)
    assert [c["id"] for c in out] == ["m1"]


def test_policy_replaces_invalidated_with_successor():
    succ = _mk("mem-l-new")
    p = _pipeline({"mem-l-new": succ}, {"mem-l-new": ("confirmed", "fact")})
    cands = [{"id": "mem-l-old", "maturity": "confirmed",
              "invalidated_by": "mem-l-new", "score": 0.7}]
    out = p._apply_outdated_policy(cands, include_outdated=False)
    assert len(out) == 1
    assert out[0]["id"] == "mem-l-new"
    assert out[0]["score"] == 0.7  # 继承旧条目的分数


def test_policy_drops_invalidated_when_successor_gone():
    p = _pipeline({}, {})  # successor 不存在
    cands = [{"id": "mem-l-old", "maturity": "confirmed",
              "invalidated_by": "mem-l-gone", "score": 0.7}]
    out = p._apply_outdated_policy(cands, include_outdated=False)
    assert out == []


def test_policy_dedups_when_successor_already_present():
    succ = _mk("mem-l-new")
    p = _pipeline({"mem-l-new": succ}, {"mem-l-new": ("confirmed", "fact")})
    cands = [
        {"id": "mem-l-new", "maturity": "confirmed", "invalidated_by": None, "score": 1.0},
        {"id": "mem-l-old", "maturity": "confirmed", "invalidated_by": "mem-l-new", "score": 0.7},
    ]
    out = p._apply_outdated_policy(cands, include_outdated=False)
    assert [c["id"] for c in out] == ["mem-l-new"]


def test_policy_include_outdated_passes_through():
    p = _pipeline({}, {})
    cands = [{"id": "m2", "maturity": "stale", "invalidated_by": None, "score": 0.9}]
    out = p._apply_outdated_policy(cands, include_outdated=True)
    assert [c["id"] for c in out] == ["m2"]
