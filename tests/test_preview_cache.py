"""Opt-in, lossless preview exports and authenticated thumbnail storage."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.gameassets import AssetCache, AssetNotFound, GameAssets
from ba_modding_toolkit.gameassets import model, service
from ba_modding_toolkit.gameassets.cache import PreviewCache, pack_preview_files, unpack_preview_files
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.server import AssetResponse, WebApp
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState
from ba_modding_toolkit.searching import get_search_dirs
from test_webui import FakeCatalog, FakeGame, FakeLibrary, call, rpc


def test_preview_cache_requires_separate_consent_and_rejects_old_generations(tmp_path):
    cache = PreviewCache(tmp_path / "previews")
    initial = cache.generation
    assert not cache.put("portrait", b"full-quality", generation=initial)
    assert not cache.root.exists()
    cache.allowed = True
    assert not cache.put("portrait", b"old work", generation=initial)
    granted = cache.generation
    assert cache.put("portrait", b"full-quality", generation=granted)
    assert cache.get("portrait") == b"full-quality"
    cache.allowed = False
    assert cache.get("portrait") is None
    assert list(cache.root.glob("*.preview")), "turning storage off does not delete the user's cache"
    cache.allowed = True
    assert cache.get("portrait") == b"full-quality"
    assert not cache.put("portrait", b"late work", generation=granted)
    cache.clear()
    assert not cache.root.exists()
    assert not cache.put("portrait", b"late work", generation=granted)


def test_preview_cache_bounds_disk_lru_and_hashes_keys(tmp_path):
    cache = PreviewCache(tmp_path / "previews", allowed=True, max_bytes=1024)
    assert cache.put("../../elsewhere", b"a" * 400, generation=cache.generation)
    assert cache.put("b", b"b" * 400, generation=cache.generation)
    os.utime(cache._path("b"), ns=(1, 1))
    assert cache.get("../../elsewhere") == b"a" * 400
    assert cache.put("c", b"c" * 400, generation=cache.generation)
    assert cache.get("b") is None
    assert cache.get("../../elsewhere") == b"a" * 400
    assert not (tmp_path / "elsewhere").exists()
    assert sum(path.stat().st_size for path in cache.root.iterdir()) <= 1024
    assert not cache.put("huge", b"x" * 1025, generation=cache.generation)


def test_preview_cache_many_writes_scan_inventory_once(tmp_path, monkeypatch):
    cache = PreviewCache(tmp_path / "previews", allowed=True, max_bytes=2048)
    scans = []
    scan = cache._scan_inventory
    monkeypatch.setattr(cache, "_scan_inventory", lambda: scans.append(1) or scan())
    for index in range(200):
        key = str(index)
        assert cache.put(key, b"lossless PNG bytes" * 8, generation=cache.generation)
        assert cache.get(key) == b"lossless PNG bytes" * 8
        if index % 5 == 0:
            cache.discard(key)
    assert len(scans) == 1, "own writes, reads and deletion must not rescan all prior thumbnails"
    assert cache._inventory_bytes == sum(path.stat().st_size for path in cache.root.glob("*.preview")) <= 2048
    cache.clear()
    assert cache.put("after-clear", b"bytes", generation=cache.generation)
    assert len(scans) == 2
    cache.relocate(tmp_path / "relocated", lambda: None)
    assert cache.put("after-move", b"bytes", generation=cache.generation)
    assert len(scans) == 3


def test_preview_cache_external_atomic_write_resyncs_inventory_and_budget(tmp_path, monkeypatch):
    cache = PreviewCache(tmp_path / "previews", allowed=True, max_bytes=1024)
    scans = []
    scan = cache._scan_inventory
    monkeypatch.setattr(cache, "_scan_inventory", lambda: scans.append(1) or scan())
    assert cache.put("original", b"a" * 400, generation=cache.generation)
    other = PreviewCache(cache.root, allowed=True, max_bytes=1024)
    assert other.put("external", b"b" * 400, generation=other.generation)
    assert cache.put("latest", b"c" * 400, generation=cache.generation)
    assert len(scans) == 2, "another instance's atomic write triggers exactly one new inventory"
    assert cache.get("original") is None
    assert cache.get("external") == b"b" * 400
    assert cache.get("latest") == b"c" * 400
    assert cache._inventory_bytes == sum(path.stat().st_size for path in cache.root.glob("*.preview")) <= 1024
    other.clear()
    assert cache.get("latest") is None
    assert cache._inventory_bytes == 0


def test_preview_cache_replacement_updates_byte_accounting(tmp_path):
    cache = PreviewCache(tmp_path / "previews", allowed=True, max_bytes=1024)
    assert cache.put("same", b"a" * 600, generation=cache.generation)
    assert cache.put("same", b"b" * 20, generation=cache.generation)
    assert cache.put("other", b"c" * 600, generation=cache.generation)
    assert cache.get("same") == b"b" * 20
    assert cache.get("other") == b"c" * 600
    assert cache._inventory_bytes == sum(path.stat().st_size for path in cache.root.glob("*.preview")) <= 1024
    cache._path("other").write_bytes(b"corrupt")
    assert cache.get("other") is None
    assert cache.put("new", b"d" * 600, generation=cache.generation)
    assert cache._inventory_bytes == sum(path.stat().st_size for path in cache.root.glob("*.preview")) <= 1024


def test_preview_cache_corruption_and_untrusted_container_are_misses(tmp_path):
    cache = PreviewCache(tmp_path / "previews", allowed=True)
    cache.put("spine", b"original", generation=cache.generation)
    cache._path("spine").write_bytes(b"broken")
    assert cache.get("spine") is None
    assert not cache._path("spine").exists()
    page = b"unchanged lossless PNG bytes"
    original = {"a/page.png": page, "page.png": page, "hero.skel": b"skeleton"}
    restored = unpack_preview_files(pack_preview_files(original))
    assert restored == original
    assert restored["a/page.png"] is restored["page.png"]
    for bad in (b"", b"\xff\xff\xff\xff", b"\x02\x00\x00\x00{}", b"\x05\x00\x00\x00[123]"):
        with pytest.raises(ValueError):
            unpack_preview_files(bad)


def test_preview_container_rejects_overlapping_allocations_before_slicing():
    directory = [[str(index), index, 4096] for index in range(100)]
    header = json.dumps(directory).encode()
    packed = struct.pack("<I", len(header)) + header + b"x" * 4196
    with pytest.raises(ValueError, match="Overlapping"):
        unpack_preview_files(packed)
    # The legitimate alias case shares exactly one allocation.
    data = b"shared bytes"
    unpacked = unpack_preview_files(pack_preview_files({"a": data, "b": data, "empty": b""}))
    assert unpacked["a"] is unpacked["b"]
    assert unpacked["empty"] == b""


def test_preview_cache_relocation_invalidates_waiting_exports(tmp_path):
    cache = PreviewCache(tmp_path / "old", allowed=True)
    previous = cache.generation
    assert cache.put("before", b"bytes", generation=previous)
    cache.relocate(tmp_path / "new", lambda: None)
    assert not (tmp_path / "old").exists()
    assert not cache.put("late", b"bytes", generation=previous)
    assert cache.put("after", b"bytes", generation=cache.generation)
    assert cache.get("after") == b"bytes"


def _game(tmp_path, preview, *, name="game"):
    root = tmp_path / name
    root.mkdir(exist_ok=True)
    return GameAssets([root], AssetCache(root=tmp_path / "light"), preview_cache=preview), root


def test_spine_exports_survive_restart_but_not_changed_sources(tmp_path, monkeypatch):
    preview = PreviewCache(tmp_path / "previews", allowed=True)
    game, root = _game(tmp_path, preview)
    bundle = root / "hero.bundle"
    bundle.write_bytes(b"old")
    builds = []

    def extract(paths):
        builds.append(1)
        return {"hero.skel": b"skeleton", "page.png": paths[-1].read_bytes()}

    monkeypatch.setattr(service, "extract_spine", extract)
    assert game.spine_files_from([bundle])["page.png"] == b"old"
    restarted, _ = _game(tmp_path, PreviewCache(preview.root, allowed=True))
    assert restarted.spine_files_from([bundle])["page.png"] == b"old"
    assert len(builds) == 1
    stat = bundle.stat()
    bundle.write_bytes(b"new")
    os.utime(bundle, ns=(stat.st_atime_ns, stat.st_mtime_ns))
    assert restarted.spine_files_from([bundle])["page.png"] == b"new"
    assert len(builds) == 2
    # A different install with the same resource catalog cannot reuse this composition.
    other, other_root = _game(tmp_path, preview, name="other-game")
    other_bundle = other_root / "hero.bundle"
    other_bundle.write_bytes(b"different")
    assert other.spine_files_from([other_bundle])["page.png"] == b"different"
    assert len(builds) == 3


def test_corrupt_spine_container_rebuilds_from_source(tmp_path, monkeypatch):
    preview = PreviewCache(tmp_path / "previews", allowed=True)
    game, root = _game(tmp_path, preview)
    bundle = root / "hero.bundle"
    bundle.write_bytes(b"source")
    builds = []
    monkeypatch.setattr(service, "extract_spine", lambda paths: builds.append(1) or {"hero.skel": b"skeleton"})
    expected = game.spine_files_from([bundle])
    key = "spine/" + service.json.dumps(service.spine_stamps([bundle]))
    preview.put(game._preview_key(key), b"invalid container with valid checksum", generation=preview.generation)
    restarted, _ = _game(tmp_path, PreviewCache(preview.root, allowed=True))
    assert restarted.spine_files_from([bundle]) == expected
    assert len(builds) == 2


def test_collection_art_is_lossless_and_survives_restart(tmp_path, monkeypatch):
    preview = PreviewCache(tmp_path / "previews", allowed=True)
    game, root = _game(tmp_path, preview)
    bundle = root / "collection.bundle"
    bundle.write_bytes(b"source")
    builds = []
    name = "Student_Portrait_Hero_Collection"
    monkeypatch.setattr(GameAssets, "_collection", lambda _: {name: {"bundle": bundle.name}})
    def image(self, record):
        builds.append(1)
        return Image.new("RGBA", (13, 17), (99, 20, 255, 123))
    monkeypatch.setattr(GameAssets, "_image", image)
    data = game.collection_portrait(name)
    restarted, _ = _game(tmp_path, PreviewCache(preview.root, allowed=True))
    assert restarted.collection_portrait(name) == data
    assert len(builds) == 1
    with Image.open(BytesIO(data)) as decoded:
        assert decoded.size == (13, 17)
        assert decoded.getpixel((6, 8)) == (99, 20, 255, 123)


@pytest.mark.parametrize("action", ["clear", "disable"])
def test_inflight_spine_export_cannot_repopulate_after_clear_or_disable(tmp_path, monkeypatch, action):
    preview = PreviewCache(tmp_path / "previews", allowed=True)
    game, root = _game(tmp_path, preview)
    bundle = root / "hero.bundle"
    bundle.write_bytes(b"source")
    started, release = threading.Event(), threading.Event()

    def extract(paths):
        started.set()
        assert release.wait(5)
        return {"hero.skel": b"skeleton"}

    monkeypatch.setattr(service, "extract_spine", extract)
    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(game.spine_files_from, [bundle])
        assert started.wait(5)
        if action == "clear":
            preview.clear_with(game.cache.clear)
        else:
            preview.allowed = False
        release.set()
        assert future.result()["hero.skel"] == b"skeleton"
    assert not preview.root.exists()
    if action == "clear":
        assert game.cache.memory_bytes == 0


def test_model_export_reuses_disk_and_revalidates_dependencies(tmp_path, monkeypatch):
    preview = PreviewCache(tmp_path / "previews", allowed=True)
    game, root = _game(tmp_path, preview)
    prefab = root / "character-ch0242-_mxload-2024-11-18_assets_all_1.bundle"
    prefab.write_bytes(b"")
    dependency = root / "dependency.bundle"
    dependency.write_bytes(b"old")
    builds = []

    def export(graph, bundles, core):
        graph.loaded.extend([str(prefab), str(dependency)])
        builds.append(1)
        return b"glTF" + dependency.read_bytes()

    monkeypatch.setattr(model, "export_chibi", export)
    assert game.model_glb("ch0242") == b"glTFold"
    restarted, _ = _game(tmp_path, PreviewCache(preview.root, allowed=True))
    assert restarted.model_glb("ch0242") == b"glTFold"
    assert len(builds) == 1
    dependency.write_bytes(b"new")
    assert restarted.model_glb("ch0242") == b"glTFnew"
    assert len(builds) == 2


@pytest.mark.parametrize("change_at", ["opening", "export"])
def test_model_dependency_replaced_during_decode_is_not_cached(tmp_path, monkeypatch, change_at):
    preview = PreviewCache(tmp_path / "previews", allowed=True)
    game, root = _game(tmp_path, preview)
    prefab = root / "character-ch0242-_mxload-2024-11-18_assets_all_1.bundle"
    prefab.write_bytes(b"")
    dependency = root / "dependency.bundle"
    dependency.write_bytes(b"old")

    @contextmanager
    def opener(path):
        decoded = path.read_bytes()
        if change_at == "opening":
            path.write_bytes(b"new")
        yield SimpleNamespace(objects=[], decoded=decoded)

    def export(graph, bundles, core):
        decoded = graph.add(dependency).decoded
        if change_at == "export":
            dependency.write_bytes(b"new")
        return b"glTF" + decoded

    monkeypatch.setattr(service, "open_bundle", opener)
    monkeypatch.setattr(model, "export_chibi", export)
    with pytest.raises(AssetNotFound, match="Model dependency changed"):
        game.model_glb("ch0242")
    assert not preview.root.exists(), "old decoded bytes must never be persisted with the new source stamp"
    assert not any(key[1].startswith("gameassets-v1/model/") for key in game.cache._items)


def test_missing_model_cab_is_not_persisted_and_new_dependency_exports_on_restart(tmp_path, monkeypatch):
    preview = PreviewCache(tmp_path / "previews", allowed=True)
    game, root = _game(tmp_path, preview)
    prefab = root / "character-ch0242-_mxload-2024-11-18_assets_all_1.bundle"
    prefab.write_bytes(b"prefab")
    dependency = root / "extra.bundle"
    monkeypatch.setattr(GameAssets, "resource_version", property(lambda self: "same-catalog"))
    monkeypatch.setattr(GameAssets, "_cab_index", lambda self, **kwargs: {"cab-extra": str(dependency)} if dependency.exists() else {})
    owner = SimpleNamespace(assets_file=SimpleNamespace(name="cab-owner", externals=[SimpleNamespace(path="cab-extra")]))
    builds = []

    @contextmanager
    def opener(path):
        obj = SimpleNamespace(assets_file=SimpleNamespace(name="cab-extra"), path_id=7, data=path.read_bytes())
        yield SimpleNamespace(objects=[obj] if path == dependency else [])

    def export(graph, bundles, core):
        builds.append(1)
        graph.add(prefab)
        texture = graph.deref(owner, {"m_FileID": 1, "m_PathID": 7})
        return b"glTF" + (texture.data if texture else b"partial")

    monkeypatch.setattr(service, "open_bundle", opener)
    monkeypatch.setattr(model, "export_chibi", export)
    assert game.model_glb("ch0242") == b"glTFpartial"
    assert game.model_glb("ch0242") == b"glTFpartial", "existing memory-only render behavior is retained"
    assert not preview.root.exists(), "an unresolved CAB must not become a persistent partial GLB"
    dependency.write_bytes(b"complete-texture")
    restarted, _ = _game(tmp_path, PreviewCache(preview.root, allowed=True))
    assert restarted.model_glb("ch0242") == b"glTFcomplete-texture"
    warm, _ = _game(tmp_path, PreviewCache(preview.root, allowed=True))
    assert warm.model_glb("ch0242") == b"glTFcomplete-texture"
    assert len(builds) == 2


def test_engine_refs_and_missing_ids_in_loaded_cabs_do_not_disable_model_cache(tmp_path):
    owner = SimpleNamespace(assets_file=SimpleNamespace(name="cab-owner", externals=[
        SimpleNamespace(path="library/unity default resources"), SimpleNamespace(path="cab-loaded")]))
    @contextmanager
    def opener(path):
        yield SimpleNamespace(objects=[])
    with model.BundleGraph({"cab-loaded": str(tmp_path / "loaded.bundle")}, opener=opener) as graph:
        assert graph.deref(owner, {"m_FileID": 1, "m_PathID": 100}) is None
        assert graph.deref(owner, {"m_FileID": 2, "m_PathID": 200}) is None
        assert graph.missing_cabs == set()


@pytest.mark.parametrize("core", ["shiroko_original", "hoshino_original"])
def test_real_complete_models_still_persist(tmp_path, monkeypatch, core):
    game_dir = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")
    if not game_dir.is_dir():
        pytest.skip("No local game install")
    preview = PreviewCache(tmp_path / "previews", allowed=True)
    directories = get_search_dirs(game_dir)
    game = GameAssets(directories, AssetCache(root=tmp_path / "light"), preview_cache=preview)
    if core not in game.model_cores():
        pytest.skip("Model is unavailable in the local install")
    data = game.model_glb(core)
    assert data.startswith(b"glTF")
    assert list(preview.root.glob("*.preview")), "valid models must retain their cross-session cache"
    restarted = GameAssets(directories, AssetCache(root=tmp_path / "light"),
                           preview_cache=PreviewCache(preview.root, allowed=True))
    monkeypatch.setattr(model, "export_chibi", lambda *args: pytest.fail("Complete cached model was exported again"))
    assert restarted.model_glb(core) == data


@pytest.fixture
def preview_services(tmp_path):
    settings = Settings(tmp_path / "config.toml")
    state = UiState(tmp_path / "webui.json")
    cache = AssetCache(root=tmp_path / "cache")
    services = Services(settings, tmp_path, state=state, cache=cache, game=FakeGame(),
                        catalog=FakeCatalog(), library=FakeLibrary())
    services._preview_cache = PreviewCache(tmp_path / "cache" / "previews")
    yield services
    services.close()


@pytest.fixture
def preview_app(preview_services):
    return WebApp(build_api(preview_services), preview_services.events, token="tok")


def _png():
    stream = BytesIO()
    Image.new("RGBA", (8, 8), (45, 99, 255, 128)).save(stream, format="PNG")
    return stream.getvalue()


def test_thumbnail_rpc_opt_in_clear_and_input_validation(preview_app, preview_services):
    app = preview_app
    raw = _png()
    encoded = base64.b64encode(raw).decode()
    prefs = rpc(app, "settings.get")["result"]
    assert not prefs["previewCache"]
    generation = prefs["previewCacheGeneration"]
    assert rpc(app, "preview.cachePut", key="test", data=encoded, generation=generation)["result"] is False
    prefs = rpc(app, "settings.set", key="previewCache", value=True)["result"]
    generation = prefs["previewCacheGeneration"]
    assert rpc(app, "preview.cacheGet", key="test")["result"] == {"allowed": True, "generation": generation, "data": None}
    assert rpc(app, "preview.cachePut", key="test", data=encoded, generation=generation)["result"] is True
    assert rpc(app, "preview.cacheGet", key="test")["result"]["data"] == encoded
    assert call(app, "/api/rpc", method="POST", body={"method": "preview.cacheGet", "params": {"key": "test"}}, token=None)[0] == "403 Forbidden"
    for data in ("not base64", base64.b64encode(b"not a PNG").decode(), "A" * (3 * 1024 * 1024)):
        assert rpc(app, "preview.cachePut", key="test", data=data, generation=generation)["error"]["code"] == "bad_params"
    assert rpc(app, "preview.cacheGet", key="x" * 4097)["error"]["code"] == "bad_params"
    assert rpc(app, "preview.cacheGet", key="\udcff")["error"]["code"] == "bad_params"
    cleared = rpc(app, "settings.clearCache")["result"]
    assert cleared["previewCache"] is True
    assert cleared["previewCacheGeneration"] != generation
    assert rpc(app, "preview.cachePut", key="test", data=encoded, generation=generation)["result"] is False
    assert rpc(app, "preview.cacheGet", key="test")["result"]["data"] is None
    assert rpc(app, "settings.set", key="previewCache", value=False)["result"]["previewCache"] is False
    assert rpc(app, "settings.clearCache")["result"]["previewCache"] is False


def test_model_revision_rpc_hashes_validated_glb(preview_app, preview_services, monkeypatch):
    calls = []
    def asset(path, query):
        calls.append((path, query))
        return AssetResponse(b"glTF exact bytes", "model/gltf-binary", False)
    monkeypatch.setattr(preview_services, "asset", asset)
    result = rpc(preview_app, "preview.modelRevision", variant="shiroko", source="mod:1")["result"]
    assert result["revision"] == hashlib.sha256(b"glTF exact bytes").hexdigest()
    assert calls == [("model/shiroko.glb", {"source": "mod:1"})]
    assert rpc(preview_app, "preview.modelRevision", variant="../bad")["error"]["code"] == "bad_params"


def test_asset_revision_rpc_tracks_exact_background_and_framing_bytes(preview_app, preview_services, monkeypatch):
    paths = ["/asset/art/bg/BG_Cafe_Collection.png", "/asset/spine/lobby/hero_home%40install/" + "a" * 64 + "/framing.json"]
    calls = []
    contents = {paths[0][len("/asset/"):]: b"PNG exact bytes",
                paths[1][len("/asset/"):].replace("%40", "@"): b'{"view": [1, 2]}'}
    def asset(path, query):
        calls.append((path, query))
        return AssetResponse(contents[path], "application/octet-stream", False)
    monkeypatch.setattr(preview_services, "asset", asset)
    assert rpc(preview_app, "preview.assetRevision", paths=paths)["error"]["code"] == "bad_params"
    assert not calls, "dependency work requires preview cache opt-in"
    preview_services.set_preview_cache(True)
    first = rpc(preview_app, "preview.assetRevision", paths=paths)["result"]
    assert first["generation"] == preview_services.preview_cache.generation
    assert len(first["revision"]) == 64
    assert rpc(preview_app, "preview.assetRevision", paths=list(reversed(paths)))["result"] == first
    contents[paths[0][len("/asset/"):]] = b"changed background"
    second = rpc(preview_app, "preview.assetRevision", paths=paths)["result"]
    assert second["revision"] != first["revision"]
    contents[paths[1][len("/asset/"):].replace("%40", "@")] = b'{"view": [3, 4]}'
    assert rpc(preview_app, "preview.assetRevision", paths=paths)["result"]["revision"] != second["revision"]
    contents.pop(paths[0][len("/asset/"):])
    assert rpc(preview_app, "preview.assetRevision", paths=paths)["error"]["code"] == "bad_params"


@pytest.mark.parametrize("paths", [
    [], ["/asset/art/bg/BG_Cafe.png"] * 3, "not a list", [None],
    ["https://example.test/asset/art/bg/BG_Cafe.png"], ["//example.test/asset/art/bg/BG_Cafe.png"],
    ["/asset/art/bg/BG_Cafe.png?other=true"], ["/asset/art/bg/BG_Cafe.png#fragment"],
    ["/asset/art/bg/../BG_Cafe.png"], ["/asset/art/bg/BG_Cafe%2f..%2fother.png"],
    ["/asset/ui/texture/BG_Cafe.png"], ["/asset/art/portrait/Student_Portrait.png"],
    ["/asset/spine/lobby/hero_home/framing.json"],
    ["/asset/spine/lobby/../" + "a" * 64 + "/framing.json"],
    ["/asset/spine/lobby/hero_home/" + "a" * 64 + "/skeleton.skel"],
])
def test_asset_revision_rejects_non_dependency_urls(preview_app, preview_services, monkeypatch, paths):
    preview_services.set_preview_cache(True)
    monkeypatch.setattr(preview_services, "asset", lambda *args: pytest.fail("Invalid path reached asset service"))
    assert rpc(preview_app, "preview.assetRevision", paths=paths)["error"]["code"] == "bad_params"
