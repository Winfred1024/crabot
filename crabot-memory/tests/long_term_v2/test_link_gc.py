"""link_gc 维护 scope：清理脏链接（删死链 / 重定向被取代链接）。"""
from src.long_term_v2.maintenance import run_maintenance, MaintenanceConfig
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.schema import (
    MemoryEntry, MemoryFrontmatter, SourceRef, ImportanceFactors, MemoryLink,
)
from src.long_term_v2.paths import entry_path


def _write(store, index, mid, type_, maturity, status, **fm_extra):
    defaults = dict(
        id=mid, type=type_, maturity=maturity,
        brief="b", author="system",
        source_ref=SourceRef(type="manual"),
        source_trust=3, content_confidence=3,
        importance_factors=ImportanceFactors(
            proximity=0.5, surprisal=0.5, entity_priority=0.5, unambiguity=0.5,
        ),
        event_time="2026-04-01T00:00:00Z",
        ingestion_time="2026-04-01T00:00:00Z",
    )
    defaults.update(fm_extra)
    fm = MemoryFrontmatter(**defaults)
    entry = MemoryEntry(frontmatter=fm, body="")
    store.write(entry, status=status)
    index.upsert(entry, path=entry_path(store.data_root, status, type_, mid), status=status)
    return entry


def test_link_gc_purges_dead_and_redirects_superseded(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))

    # D：取代 C 的 successor（正常存在）
    _write(store, index, "D", "fact", "confirmed", "confirmed")
    # C：被 D 取代（invalidated_by=D），仍在 confirmed
    _write(store, index, "C", "fact", "confirmed", "confirmed", invalidated_by="D")
    # B：从未写入 store/index → 模拟已 purge 的死链 target

    # A：出链指向 B（死链）与 C（被取代）
    _write(store, index, "A", "fact", "confirmed", "confirmed",
           links=[
               MemoryLink(target="B", relation="related"),
               MemoryLink(target="C", relation="refines"),
           ])

    report = run_maintenance(
        store, index, scope="link_gc",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )

    assert report["link_gc"]["changed"] >= 1
    # B 链接被删，C 链接重定向到 D（保留 relation=refines）
    assert index.find_links_from("A") == [{"target": "D", "relation": "refines"}]
    # 落盘也同步
    entry = store.read("confirmed", "fact", "A")
    assert [{"target": lk.target, "relation": lk.relation} for lk in entry.frontmatter.links] == [
        {"target": "D", "relation": "refines"},
    ]


def test_link_gc_drops_link_when_successor_unreachable(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))

    # C 被 D 取代，但 D 不存在（successor 不可达）→ 删该链接
    _write(store, index, "C", "fact", "confirmed", "confirmed", invalidated_by="D")
    _write(store, index, "A", "fact", "confirmed", "confirmed",
           links=[MemoryLink(target="C", relation="refines")])

    run_maintenance(
        store, index, scope="link_gc",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )

    assert index.find_links_from("A") == []
    entry = store.read("confirmed", "fact", "A")
    assert entry.frontmatter.links == []


def test_link_gc_drops_link_when_target_in_trash(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))

    # target B 在 trash（无 successor）→ 删该链接
    _write(store, index, "B", "fact", "confirmed", "trash")
    _write(store, index, "A", "fact", "confirmed", "confirmed",
           links=[MemoryLink(target="B", relation="related")])

    run_maintenance(
        store, index, scope="link_gc",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )

    assert index.find_links_from("A") == []


def test_all_scope_includes_link_gc(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    index = SqliteIndex(str(tmp_path / "v2.db"))
    report = run_maintenance(
        store, index, scope="all",
        config=MaintenanceConfig(now_iso="2026-04-23T00:00:00Z"),
    )
    assert "link_gc" in report


def test_all_link_sources_returns_distinct(tmp_path):
    index = SqliteIndex(str(tmp_path / "v2.db"))
    store = MemoryStore(str(tmp_path / "long_term"))
    _write(store, index, "X", "fact", "confirmed", "confirmed")
    _write(store, index, "A", "fact", "confirmed", "confirmed",
           links=[MemoryLink(target="X", relation="related")])
    assert index.all_link_sources() == ["A"]
