import os
import tempfile
import sqlite3

import pytest

from src.storage.scene_profile_store import SceneProfileStore
from src.types import (
    SceneProfile,
    SceneIdentityFriend,
    SceneIdentityGroup,
    SceneIdentityGlobal,
)


@pytest.fixture
def store():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    s = SceneProfileStore(path)
    yield s
    s.close()
    os.unlink(path)


def _sample_group():
    return SceneProfile(
        scene=SceneIdentityGroup(channel_id="feishu", session_id="s1"),
        label="开发组群",
        content="x",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )


def test_upsert_insert(store):
    out = store.upsert(_sample_group())
    assert out.label == "开发组群"
    got = store.get(_sample_group().scene)
    assert got and got.label == "开发组群"


def test_upsert_update(store):
    store.upsert(_sample_group())
    updated = _sample_group()
    updated.label = "新名字"
    updated.created_at = "2026-04-19T00:00:00Z"
    updated.updated_at = "2026-04-18T00:00:00Z"
    store.upsert(updated)
    got = store.get(updated.scene)
    assert got.label == "新名字"
    assert got.created_at == "2026-04-17T00:00:00Z"


def test_get_only_public_raises_for_removed_filter_mode(store):
    store.upsert(_sample_group())
    with pytest.raises(ValueError, match="only_public"):
        store.get(_sample_group().scene, only_public=True)


def test_list(store):
    store.upsert(_sample_group())
    out = store.list(scene_type="group_session")
    assert len(out) == 1
    assert out[0].content == "x"


def test_delete(store):
    store.upsert(_sample_group())
    deleted = store.delete(_sample_group().scene)
    assert deleted is True
    assert store.get(_sample_group().scene) is None


def test_unique_constraint_global(store):
    g1 = SceneProfile(
        scene=SceneIdentityGlobal(),
        label="A",
        content="A",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    g2 = SceneProfile(
        scene=SceneIdentityGlobal(),
        label="B",
        content="B",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    store.upsert(g1)
    store.upsert(g2)
    assert len(store.list()) == 1 and store.list()[0].label == "B"


def test_old_schema_db_without_content_column_is_migrated(tmp_path):
    """老库可能没有 content 列，确保 _migrate_schema 能补上后正常写入。"""
    db_path = tmp_path / "old_schema.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE scene_profiles (
          scene_type             TEXT NOT NULL,
          friend_id              TEXT,
          channel_id             TEXT,
          session_id             TEXT,
          label                  TEXT NOT NULL,
          source_memory_ids_json TEXT,
          created_at             TEXT NOT NULL,
          updated_at             TEXT NOT NULL,
          last_declared_at       TEXT
        )
        """
    )
    conn.commit()
    conn.close()

    store = SceneProfileStore(str(db_path))
    profile = SceneProfile(
        scene=SceneIdentityGroup(channel_id="feishu", session_id="write-1"),
        label="写入测试",
        content="正文内容",
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    store.upsert(profile)

    got = store.get(profile.scene)
    assert got is not None
    assert got.content == "正文内容"
    store.close()


def test_list_scene_profiles_by_memory_returns_referencing_profiles(store):
    profile = SceneProfile(
        scene=SceneIdentityFriend(friend_id="friend-1"),
        label="Alice",
        content="完整说明",
        source_memory_ids=["mem-1"],
        created_at="2026-04-17T00:00:00Z",
        updated_at="2026-04-17T00:00:00Z",
    )
    store.upsert(profile)

    profiles = store.list_by_memory_id("mem-1")

    assert len(profiles) == 1
    assert profiles[0].label == "Alice"
