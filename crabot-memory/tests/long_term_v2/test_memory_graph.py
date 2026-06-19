"""P3-T1: get_memory_graph RPC——聚合图谱 nodes+edges。"""
import asyncio
import pytest
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.rpc import LongTermV2Rpc


def _rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    return LongTermV2Rpc(store=store, index=idx)


async def _write_confirmed(rpc, brief, entities=None) -> str:
    res = await rpc.write_long_term({
        "type": "fact",
        "brief": brief,
        "content": "x",
        "author": "agent",
        "source_ref": {"type": "reflection"},
        "source_trust": 5,
        "content_confidence": 5,
        "importance_factors": {
            "proximity": 0.5, "surprisal": 0.5,
            "entity_priority": 0.5, "unambiguity": 0.5,
        },
        "event_time": "2026-06-01T00:00:00Z",
        "status": "confirmed",
        "entities": entities or [],
    })
    return res["id"]


def test_get_memory_graph_assembles_nodes_and_edges(tmp_path):
    rpc = _rpc(tmp_path)
    b_id = asyncio.run(_write_confirmed(rpc, "B"))
    a_id = asyncio.run(_write_confirmed(
        rpc, "A", entities=[{"type": "project", "id": "ent-x", "name": "X"}],
    ))
    asyncio.run(rpc.update_long_term({
        "id": a_id,
        "patch": {"links": [{"target": b_id, "relation": "refines"}]},
    }))

    g = asyncio.run(rpc.get_memory_graph({}))

    node_ids = {n["id"] for n in g["nodes"]}
    assert {a_id, b_id, "ent-x"} <= node_ids
    assert any(n["id"] == "ent-x" and n["kind"] == "entity" for n in g["nodes"])
    assert {"source": a_id, "target": b_id, "edge_type": "link", "relation": "refines"} in g["edges"]
    assert {"source": a_id, "target": "ent-x", "edge_type": "membership"} in g["edges"]
    assert g["stats"]["node_count"] == len(g["nodes"])
    assert g["stats"]["edge_count"] == len(g["edges"])
