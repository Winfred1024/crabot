"""P2-T3: update_long_term patch 写入 links 字段端到端测试。"""
import asyncio
import pytest
from src.long_term_v2.store import MemoryStore
from src.long_term_v2.sqlite_index import SqliteIndex
from src.long_term_v2.rpc import LongTermV2Rpc


@pytest.fixture
def rpc(tmp_path):
    store = MemoryStore(str(tmp_path / "long_term"))
    idx = SqliteIndex(str(tmp_path / "idx.db"))
    return LongTermV2Rpc(store=store, index=idx)


async def _write_confirmed(rpc) -> str:
    res = await rpc.write_long_term({
        "type": "fact",
        "brief": "源记忆",
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
    })
    return res["id"]


def test_update_long_term_writes_links(rpc):
    mid = asyncio.run(_write_confirmed(rpc))
    asyncio.run(rpc.update_long_term({
        "id": mid,
        "patch": {"links": [{"target": "mem-l-other", "relation": "depends_on"}]},
    }))
    assert rpc.index.find_links_from(mid) == [
        {"target": "mem-l-other", "relation": "depends_on"}
    ]


def test_update_long_term_rejects_invalid_relation(rpc):
    from pydantic import ValidationError
    mid = asyncio.run(_write_confirmed(rpc))
    with pytest.raises(ValidationError):
        asyncio.run(rpc.update_long_term({
            "id": mid,
            "patch": {"links": [{"target": "mem-l-other", "relation": "bogus"}]},
        }))
