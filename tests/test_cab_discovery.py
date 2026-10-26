"""Dependency discovery preserves source identity, cache boundaries and graph lifetime."""

import json
import os
import struct
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from UnityPy.helpers.CompressionHelper import compress_lz4

from ba_modding_toolkit.bundle import get_cab_names
from ba_modding_toolkit.gameassets.cache import PreviewCache
from ba_modding_toolkit.gameassets.cabs import CabIndex
from ba_modding_toolkit.gameassets.discovery import cab_names
from ba_modding_toolkit.gameassets.model import BundleGraph


def bundle(root, name, cab, *, at_end=False, padding=4, engine="2022.3.55f1", flags=2):
    path = root / name
    info = bytes(16) + struct.pack(">ii", 0, 1) + struct.pack(">qqI", 0, 0, 4) + cab.encode() + b"\0"
    packed = compress_lz4(info)
    prefix = b"UnityFS\0" + struct.pack(">I", 7) + b"5.x.x\0" + engine.encode() + b"\0"
    offset = len(prefix)
    head_size = (offset + 20 + 15) & ~15
    length = head_size + padding + len(packed)
    head = prefix + struct.pack(">qIII", length, len(packed), len(info), flags | (0x80 if at_end else 0))
    with path.open("wb") as stream:
        stream.write(head.ljust(head_size, b"\0"))
        if at_end:
            stream.seek(head_size + padding)
            stream.write(packed)
        else:
            stream.write(packed)
            stream.seek(length - 1)
            stream.write(b"\0")
        stream.write(b"CRC!")
    return path


def reader_calls():
    calls = []
    def read(path):
        calls.append(path)
        return cab_names(path)
    return read, calls


@pytest.mark.parametrize("at_end", [False, True])
def test_shared_parser_ignores_crc_tail_and_accepts_large_bundles(tmp_path, at_end):
    path = bundle(tmp_path, "large.bundle", "CAB-LARGE", at_end=at_end, padding=65 * 1024 * 1024)
    assert path.stat().st_size > 64 * 1024 * 1024
    assert cab_names(path) == ["cab-large"]
    assert get_cab_names(path) == {"CAB-LARGE"}
    assert CabIndex([tmp_path]).resolve({"cab-large"}) == {"cab-large": str(path)}


@pytest.mark.parametrize("engine,flags,readable", [("2019.4.40f1", 0x202, False),
    ("2022.3.55f1", 0x202, True), ("2022.3.55f1", 0x402, False)])
def test_shared_parser_distinguishes_old_encryption_and_new_padding(tmp_path, engine, flags, readable):
    path = bundle(tmp_path, "flags.bundle", "CAB-FLAGS", engine=engine, flags=flags)
    if readable:
        assert cab_names(path) == ["cab-flags"]
    else:
        with pytest.raises(ValueError):
            cab_names(path)
        assert get_cab_names(path) is None


def test_same_group_precedes_smaller_unrelated_files_and_stops_early(tmp_path):
    target = bundle(tmp_path, "assets-_mx-spinecharacters-hoshino_spr-2026-10-25_002_assets_all_1.bundle", "CAB-TARGET")
    (tmp_path / "unrelated.bundle").write_bytes(b"x")
    read, calls = reader_calls()
    hint = tmp_path / "assets-_mx-spinecharacters-hoshino_spr-2026-10-25_001_assets_all_2.bundle"
    assert CabIndex([tmp_path], reader=read).resolve({"CAB-TARGET"}, hint) == {"cab-target": str(target)}
    assert calls == [target]


def test_prolog_precedes_the_remaining_scan(tmp_path):
    target = bundle(tmp_path, "prologgroup-common.bundle", "CAB-COMMON")
    (tmp_path / "unrelated.bundle").write_bytes(b"x")
    read, calls = reader_calls()
    assert CabIndex([tmp_path], reader=read).resolve({"cab-common"}) == {"cab-common": str(target)}
    assert calls == [target]


def test_metadata_reuses_across_instances_without_reading_headers(tmp_path):
    game = tmp_path / "game"
    game.mkdir()
    path = bundle(game, "target.bundle", "CAB-TARGET")
    cache = PreviewCache(tmp_path / "cache", allowed=True)
    first = CabIndex([game], cache=cache, namespace="catalog")
    assert first.resolve({"cab-target"}) == {"cab-target": str(path)}
    def forbidden(path):
        pytest.fail("A valid persisted mapping must not parse bundle headers again")
    second = CabIndex([game], cache=PreviewCache(cache.root, allowed=True), namespace="catalog", reader=forbidden)
    assert second.resolve({"cab-target"}) == {"cab-target": str(path)}


def test_preserved_mtime_replacement_and_deletion_invalidate_mappings(tmp_path):
    path = bundle(tmp_path, "target.bundle", "CAB-FIRST")
    original = path.stat()
    index = CabIndex([tmp_path])
    assert index.resolve({"cab-first"})
    bundle(tmp_path, path.name, "CAB-OTHER")
    os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))
    assert path.stat().st_size == original.st_size
    assert index.resolve({"cab-first"}) == {}
    assert index.resolve({"cab-other"}) == {"cab-other": str(path)}
    path.unlink()
    assert index.resolve({"cab-other"}) == {}


def test_missing_dependency_becomes_available_without_restarting(tmp_path):
    (tmp_path / "bad.bundle").write_bytes(b"UnityFS\0broken")
    index = CabIndex([tmp_path])
    assert index.resolve({"cab-new"}) == {}
    path = bundle(tmp_path, "new.bundle", "CAB-NEW")
    assert index.resolve({"cab-new"}) == {"cab-new": str(path)}


def test_corrupt_cache_cannot_redirect_reads_outside_the_game(tmp_path):
    game = tmp_path / "game"
    game.mkdir()
    target = bundle(game, "target.bundle", "CAB-TARGET")
    cache = PreviewCache(tmp_path / "cache", allowed=True)
    read, calls = reader_calls()
    index = CabIndex([game], cache=cache, reader=read)
    cache.put(index.key, json.dumps({"schema": "cab-discovery-v1", "entries": [
        [0, "../outside.bundle", [1, 2, 3, 4, 5], ["cab-target"]]]}).encode(), generation=cache.generation)
    assert index.resolve({"cab-target"}) == {"cab-target": str(target)}
    assert calls == [target]
    assert CabIndex([tmp_path], cache=cache).key != index.key


def test_symlink_escape_is_not_read(tmp_path):
    game, outside = tmp_path / "game", tmp_path / "outside"
    game.mkdir()
    outside.mkdir()
    target = bundle(outside, "target.bundle", "CAB-OUTSIDE")
    (game / "linked.bundle").symlink_to(target)
    read, calls = reader_calls()
    assert CabIndex([game], reader=read).resolve({"cab-outside"}) == {}
    assert calls == []


def test_source_changed_during_header_read_is_not_published(tmp_path):
    path = bundle(tmp_path, "target.bundle", "CAB-FIRST")
    def racing(source):
        names = cab_names(source)
        bundle(tmp_path, source.name, "CAB-OTHER")
        return names
    cache = PreviewCache(tmp_path / "cache", allowed=True)
    index = CabIndex([tmp_path], cache=cache, reader=racing)
    assert index.resolve({"cab-first"}) == {}
    index.reader = cab_names
    assert index.resolve({"cab-other"}) == {"cab-other": str(path)}


def test_cache_clear_during_lookup_cannot_recreate_cleared_metadata(tmp_path):
    game = tmp_path / "game"
    game.mkdir()
    path = bundle(game, "target.bundle", "CAB-TARGET")
    cache = PreviewCache(tmp_path / "cache", allowed=True)
    def clearing(source):
        names = cab_names(source)
        cache.clear()
        return names
    index = CabIndex([game], cache=cache, reader=clearing)
    assert index.resolve({"cab-target"}) == {"cab-target": str(path)}
    assert not list(cache.root.glob("*.preview"))
    read, calls = reader_calls()
    index.reader = read
    assert index.resolve({"cab-target"})
    assert calls == [path]


def test_opt_out_never_creates_disk_metadata(tmp_path):
    game = tmp_path / "game"
    game.mkdir()
    bundle(game, "target.bundle", "CAB-TARGET")
    cache = PreviewCache(tmp_path / "cache", allowed=False)
    assert CabIndex([game], cache=cache).resolve({"cab-target"})
    assert not cache.root.exists()


def test_graph_batch_coalesces_writes_and_simultaneous_lookups_share_headers(tmp_path, monkeypatch):
    game = tmp_path / "game"
    game.mkdir()
    path = bundle(game, "target.bundle", "CAB-TARGET")
    cache = PreviewCache(tmp_path / "cache", allowed=True)
    read, calls = reader_calls()
    index = CabIndex([game], cache=cache, reader=read)
    writes = []
    original = cache.put
    monkeypatch.setattr(cache, "put", lambda *args, **kw: writes.append(1) or original(*args, **kw))
    with index.batch(), ThreadPoolExecutor(max_workers=4) as pool:
        assert all(result == {"cab-target": str(path)} for result in
                   pool.map(lambda _: index.resolve({"cab-target"}), range(8)))
        assert writes == []
    assert calls == [path] and writes == [1]


def test_graph_passes_referring_bundle_hint_and_releases_resources(tmp_path):
    owner_path, target_path = tmp_path / "owner.bundle", tmp_path / "target.bundle"
    owner = SimpleNamespace(assets_file=SimpleNamespace(name="CAB-OWNER", externals=[SimpleNamespace(path="CAB-TARGET")]), path_id=1)
    target = SimpleNamespace(assets_file=SimpleNamespace(name="CAB-TARGET", externals=[]), path_id=7)
    requests, closed = [], []
    @contextmanager
    def opener(path):
        try:
            yield SimpleNamespace(objects=[owner] if path == owner_path else [target])
        finally:
            closed.append(path)
    def resolve(names, hint):
        requests.append((names, hint))
        return {"cab-target": str(target_path)}
    with BundleGraph({}, resolver=resolve, opener=opener) as graph:
        graph.add(owner_path)
        assert graph.deref(owner, {"m_FileID": 1, "m_PathID": 7}) is target
        assert graph.deref(owner, {"m_FileID": 1, "m_PathID": 7}) is target
        assert graph.missing_cabs == set()
    assert requests == [({"cab-target"}, owner_path)]
    assert closed == [target_path, owner_path]


def test_prefab_hint_prioritizes_same_character_dependency_family(tmp_path):
    target = bundle(tmp_path, "assets-_mx-characters-ch0242-_mxdependency-2026-10-25_002_assets_all_1.bundle", "CAB-TARGET")
    bundle(tmp_path, "prologgroup-common.bundle", "CAB-COMMON")
    read, calls = reader_calls()
    hint = tmp_path / "character-ch0242-_mxload-2026-10-25_assets_all_2.bundle"
    assert CabIndex([tmp_path], reader=read).resolve({"cab-target"}, hint) == {"cab-target": str(target)}
    assert calls == [target]


def test_mapping_hits_revalidate_in_place_changes_inside_one_graph_batch(tmp_path):
    path = bundle(tmp_path, "target.bundle", "CAB-FIRST")
    stamp = path.stat()
    index = CabIndex([tmp_path])
    with index.batch():
        assert index.resolve({"cab-first"})
        bundle(tmp_path, path.name, "CAB-OTHER")
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        assert index.resolve({"cab-first"}) == {}
        assert index.resolve({"cab-other"}) == {"cab-other": str(path)}


def test_eviction_bounds_metadata_and_scan_orders_without_losing_resolution(tmp_path, monkeypatch):
    from ba_modding_toolkit.gameassets import cabs
    monkeypatch.setattr(cabs, "_MAX_ENTRIES", 2)
    monkeypatch.setattr(cabs, "_MAX_ORDERS", 2)
    monkeypatch.setattr(cabs, "_MAX_METADATA_BYTES", 4096)
    paths = [bundle(tmp_path, f"target-{i}.bundle", f"CAB-{i}") for i in range(5)]
    index = CabIndex([tmp_path])
    for i in range(5):
        assert index.resolve({f"cab-{i}"}) == {f"cab-{i}": str(paths[i])}
        assert len(index._entries) <= 2 and index._metadata_bytes <= 4096
    for i in range(3):
        hint = tmp_path / f"character-ch00{i}-_mxload-2026-10-25_assets_all_1.bundle"
        assert index.resolve({"cab-missing"}, hint) == {}
    assert len(index._orders) <= 2
    assert index.resolve({"cab-0"}) == {"cab-0": str(paths[0])}
