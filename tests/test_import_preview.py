"""Analyzed source previews use the existing revisioned, memory-only Spine asset flow."""

import json
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.gameassets import AssetCache, GameAssets
from ba_modding_toolkit.webui.server import WebApp

from test_batch_import import analyze, env, batch_model_env
from test_library import game_bundle, make_mod, setup_library
from test_webui import call
from test_library_model import model_env


def preview_route(env, entry):
    preview = entry["preview"]
    assert preview["kind"] == "import" and len(preview["key"]) == 64
    app = WebApp(env.rpc, env.services.events, assets=env.services.asset, token="tok", consent=lambda: True)
    return app, f"/asset/spine/import/{preview['key']}"


def test_source_preview_composes_missing_official_parts_and_never_writes_art_to_disk(env, monkeypatch):
    source = make_mod(env.original, env.tmp / "input")
    text = game_bundle(env.game_dir, part="textassets", payload=b"official skeleton")
    assets = {text: {"test_spr.skel": b"official skeleton", "test_spr.atlas": b"mod.png\n"},
              source: {"mod.png": b"incoming pixels"}, env.original: {"mod.png": b"official pixels"}}
    seen = []

    def extract(paths):
        seen.append(list(paths))
        return {name: data for path in paths for name, data in assets[path].items()}

    cache = AssetCache(allowed=True, root=env.tmp / "art-cache")
    env.services._game = GameAssets([env.game_dir], cache)
    monkeypatch.setattr("ba_modding_toolkit.gameassets.service.extract_spine", extract)
    before = {path: path.read_bytes() for path in [env.original, text, source]}
    entry, = analyze(env, [source])["entries"]
    app, prefix = preview_route(env, entry)
    status, headers, body = call(app, prefix + "/manifest.json")
    assert status == "200 OK" and headers["Cache-Control"] == "no-store"
    revision = json.loads(body)["revision"]
    for name, expected in {"skeleton.skel": b"official skeleton", "skeleton.atlas": b"mod.png\n",
                           "mod.png": b"incoming pixels"}.items():
        status, headers, body = call(app, f"{prefix}/{revision}/{name}")
        assert (status, body) == ("200 OK", expected)
        assert headers["Cache-Control"] == "no-store"
    assert seen == [[text, source]], "Extraction is shared in memory and source pixels override the replaced part"
    assert cache.memory_bytes > 0 and not cache.root.exists()
    assert not env.library.mods()
    assert all(path.read_bytes() == data for path, data in before.items())


def test_source_preview_uses_the_identified_core_for_renamed_uploads(env, monkeypatch):
    target = game_bundle(env.game_dir, "test_home_gl")
    source = game_bundle(env.tmp / "renamed", date="2025-01-01", payload=b"renamed lobby")
    monkeypatch.setattr("ba_modding_toolkit.library.identity.content_cores", lambda path: {"test_home_gl"})
    env.services._game = SimpleNamespace(spine_files_from=lambda paths: {
        "background.skel": b"background", "test_home_gl.skel": b"incoming lobby"})
    entry, = analyze(env, [source])["entries"]
    assert (entry["kind"], entry["core"], entry["files"][0]["target"]) == ("lobby", "test_home_gl", target.name)
    app, prefix = preview_route(env, entry)
    assert call(app, prefix + "/skeleton.skel")[2] == b"incoming lobby"


@pytest.mark.parametrize("change", ["modified", "deleted", "reanalyzed", "folder"])
def test_source_preview_expires_when_the_analyzed_context_changes(env, monkeypatch, change):
    source = make_mod(env.original, env.tmp / "input")
    env.services._game = SimpleNamespace(spine_files_from=lambda paths: {"test_spr.skel": b"source"})
    entry, = analyze(env, [source])["entries"]
    app, prefix = preview_route(env, entry)
    revision = json.loads(call(app, prefix + "/manifest.json")[2])["revision"]
    if change == "modified":
        source.write_bytes(source.read_bytes() + b"changed")
    elif change == "deleted":
        source.unlink()
    elif change == "reanalyzed":
        new_entry, = analyze(env, [source])["entries"]
        assert new_entry["id"] == entry["id"] and new_entry["preview"] != entry["preview"]
    else:
        monkeypatch.setattr(env.library, "current_pin", lambda: None)
    for name in ("manifest.json", "skeleton.skel", f"{revision}/skeleton.skel"):
        assert call(app, f"{prefix}/{name}")[0] == "404 Not Found"


def test_revisioned_source_preview_rejects_a_composition_changed_during_extraction(env):
    source = make_mod(env.original, env.tmp / "input")

    def extract(paths):
        source.write_bytes(source.read_bytes() + b"changed while extracting")
        return {"test_spr.skel": b"stale"}

    env.services._game = SimpleNamespace(spine_files_from=extract)
    entry, = analyze(env, [source])["entries"]
    app, prefix = preview_route(env, entry)
    revision = json.loads(call(app, prefix + "/manifest.json")[2])["revision"]
    assert call(app, f"{prefix}/{revision}/skeleton.skel")[0] == "404 Not Found"


def test_preview_can_use_a_self_contained_source_without_recoverable_originals(env, monkeypatch):
    source = make_mod(env.original, env.tmp / "input")
    env.services._game = SimpleNamespace(spine_files_from=lambda paths: {"test_spr.skel": paths[-1].read_bytes()})
    entry, = analyze(env, [source])["entries"]

    def missing(*args, **kwargs):
        raise ServiceError("original_unavailable")

    monkeypatch.setattr(env.library, "official_bundles", missing)
    app, prefix = preview_route(env, entry)
    assert call(app, prefix + "/skeleton.skel")[2] == source.read_bytes()
    assert env.services.batch_import.preview(entry["preview"]["key"])[1] == [source]


def test_source_preview_tokens_never_resolve_arbitrary_paths(env):
    for key in ("unknown", "..", str(env.original), "a" * 64):
        with pytest.raises(KeyError):
            env.services.batch_import.preview(key)


@pytest.mark.parametrize('problem', ['platform', 'source', 'conflict'])
def test_blocked_sources_still_serve_renderable_preview_assets(env, monkeypatch, problem):
    from ba_modding_toolkit.library import integrity
    if problem == "source":
        monkeypatch.setattr("ba_modding_toolkit.webui.batch_import._asset_match", lambda *args, **kwargs: ([], ""))

    source = game_bundle(env.tmp / 'input', date="2025-01-01", payload=b"old mod")
    inspect = integrity.inspect
    if problem == 'conflict':
        monkeypatch.setattr('ba_modding_toolkit.library.identity.content_cores',
                            lambda path: {'test_spr', 'other_spr'})
    else:
        monkeypatch.setattr(integrity, 'inspect', lambda path, **kwargs:
            integrity.Contents(platforms={'StandaloneOSX' if problem == 'platform' else 'UnknownPlatform'})
            if path == source else inspect(path, **kwargs))
    env.services._game = SimpleNamespace(spine_files_from=lambda paths: {
        'test_spr.skel': b'preview skeleton', 'test_spr.atlas': b'page.png\n', 'page.png': b'preview pixels'})
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'blocked'
    app, prefix = preview_route(env, entry)
    assert call(app, prefix + '/skeleton.skel')[2] == b'preview skeleton'
    assert call(app, prefix + '/page.png')[2] == b'preview pixels'


def test_blocked_model_source_has_an_import_preview_route(batch_model_env, monkeypatch):
    env = batch_model_env
    source = make_mod(env.parts[0], env.tmp / 'input')
    monkeypatch.setattr(env.library, 'supports_kind', lambda kind: False)
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'blocked' and entry['kind'] == 'model' and entry['preview']
    seen = []
    env.services._game = SimpleNamespace(model_glb=lambda core, **kwargs: seen.append((core, kwargs)) or b'model preview')
    response = env.services.asset('model/hoshino.glb', {'source': 'import:' + entry['preview']['key']})
    assert response.body == b'model preview'
    assert seen[0][0] == 'hoshino_original' and seen[0][1]['overrides'][-1] == source


def test_import_lobby_still_route_supplies_the_identified_game_camera(env):
    target = game_bundle(env.game_dir, "test_home_gl")
    source = make_mod(target, env.tmp / "incoming")
    entry, = analyze(env, [source])["entries"]
    info = {"view": {"x": -1480, "y": -832.5, "w": 2960, "h": 1665}, "main": "test_home",
            "layers": [{"name": "test_home", "x": 37.5, "y": -880, "scale": .72}]}
    requested = []
    env.services._game = SimpleNamespace(lobby_info=lambda core: requested.append(core) or info)
    app, prefix = preview_route(env, entry)
    status, _, manifest = call(app, prefix + "/manifest.json")
    revision = json.loads(manifest)["revision"]
    status, _, body = call(app, f"{prefix}/{revision}/framing.json")
    assert status == "200 OK"
    assert json.loads(body) == {"view": info["view"], "layer": info["layers"][0]}
    assert requested == ["test_home_gl"]
