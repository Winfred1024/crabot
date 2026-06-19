"""P2: links schema 测试。"""
import pytest
from pydantic import ValidationError
from src.long_term_v2.schema import MemoryLink, MemoryFrontmatter, SourceRef, ImportanceFactors


def _fm(**kw):
    base = dict(
        id="mem-l-x", type="fact", maturity="confirmed", brief="b", author="agent:test",
        source_ref=SourceRef(type="reflection"), source_trust=5, content_confidence=5,
        importance_factors=ImportanceFactors(proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5),
        event_time="2026-06-01T00:00:00Z", ingestion_time="2026-06-01T00:00:00Z",
    )
    base.update(kw)
    return MemoryFrontmatter(**base)


def test_link_accepts_valid_relation():
    lk = MemoryLink(target="mem-l-y", relation="refines")
    assert lk.target == "mem-l-y" and lk.relation == "refines"


def test_link_rejects_unknown_relation():
    with pytest.raises(ValidationError):
        MemoryLink(target="mem-l-y", relation="contradicts")  # 不在词表


def test_frontmatter_links_defaults_empty():
    fm = _fm()
    assert fm.links == []


def test_frontmatter_accepts_links():
    fm = _fm(links=[{"target": "mem-l-y", "relation": "part_of"}])
    assert fm.links[0].target == "mem-l-y"
    assert fm.links[0].relation == "part_of"
