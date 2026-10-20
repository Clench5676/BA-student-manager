"""Special Spine slots share the lobby workflow without assuming a student or a home suffix."""

import json
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.catalog import Catalog
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.gameassets import AssetCache, GameAssets
from ba_modding_toolkit.library import ModLibrary
from ba_modding_toolkit.library.identity import content_cores, identify
from ba_modding_toolkit.naming import parse_filename, spine_kind
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.services import Services

from test_library import game_bundle, make_mod, setup_library
from test_mod_identity import objects


def catalog_for(paths, portraits=()):
    game = SimpleNamespace(spine_cores=lambda kind: (
        {core: [] for core in portraits} if kind == "spr" else
        {parse_filename(path.name).core: [path] for path in paths}), collection_names=lambda: {})
    return Catalog(game, None)


@pytest.mark.parametrize("core, category, expected", [
    ("arona_workpage_daytime", "spinebackground", "lobby"),
    ("plana_workpage", "spinebackground", "lobby"),
    ("cafe", "spinebackground", "lobby"),
    ("task", "spinelobbies", "lobby"),
    ("arona", "spinecharacters", "lobby"),
    ("test_spr", "spinecharacters", "spr"),
    ("test_spr", "spinebackground", "lobby"),
    ("test_home", "spinebackground", "lobby"),
    ("_mxcommon", "spinebackground", None),
    ("mxcommon", "spinebackground", None),
    ("mxcommon_assets", "spinecharacters", None),
    ("test_home", "characters", None),
    ("unknown", "sound", None),
])
def test_spine_slot_categories(core, category, expected):
    assert spine_kind(core, category) == expected


def test_discovery_groups_special_parts_and_excludes_shared_and_non_spine(tmp_path):
    slots = [("spinebackground", "arona_workpage_daytime", "002"),
             ("spinebackground", "arona_workpage_daytime", "003"),
             ("spinebackground", "plana_workpage", "textures"),
             ("spinebackground", "cafe", "textassets"),
             ("spinecharacters", "arona", "003"),
             ("spinelobbies", "task", "003"),
             ("spinecharacters", "test_spr", "003"),
             ("spinebackground", "_mxcommon", "003"),
             ("characters", "other_home", "003")]
    paths = [game_bundle(tmp_path, core, part=part, category=category) for category, core, part in slots]
    game = GameAssets([tmp_path], AssetCache(root=tmp_path / "cache"))
    assert game.spine_cores("spr") == {"test_spr": [paths[6]]}
    assert game.spine_cores("lobby") == {
        "arona_workpage_daytime": paths[:2], "plana_workpage": [paths[2]], "cafe": [paths[3]],
        "arona": [paths[4]], "task": [paths[5]],
    }


def test_catalog_names_families_variants_and_install_maps(tmp_path):
    cores = ["arona_workpage_daytime", "arona_workpage_night", "plana_workpage", "aoi_workpage",
             "np0035_workpage", "cafe", "event_new_background", "arona_home"]
    paths = [game_bundle(tmp_path, core, category="spinebackground") for core in cores]
    catalog = catalog_for(paths, ["arona_spr", "np0032_spr", "np0035_spr"])
    assert {f.key for f in catalog.families()} == {"arona", "np0032", "np0035", "special"}
    for core, family in zip(cores, ["arona", "arona", "np0035", "np0032", "np0035", "special", "special", "arona"]):
        v = catalog.variant_for_core(core.upper())
        assert v.key == f"special:{core}"
        assert (v.family, v.spr, v.lobby, v.spine_category, v.recruitable) == (family, None, core, "spinebackground", False)
        assert catalog.variant_for_asset_core(core).key == v.key
    assert catalog.family("np0032").names["zh-TW"] == "\u78a7"
    assert catalog.family("np0035").names["zh-CN"] == "\u666e\u62c9\u5a1c"
    assert catalog.variant("special:arona_workpage_daytime").names["en"]["short"] == "Work Page - Daytime"
    assert catalog.variant("special:arona_workpage_night").names["zh-CN"]["short"] == "\u4efb\u52a1\u5927\u5385 - \u591c\u665a"
    assert catalog.variant("special:event_new_background").names["en"]["short"] == "event_new_background"
    for portraits in ([], ["arona_spr"]):
        mapped = catalog.core_map(portraits, cores, special_cores=cores)
        for core in cores:
            assert mapped.key(core) == f"special:{core}"
            assert mapped.core(f"special:{core}", "lobby") == core
            assert mapped.names[f"special:{core}"] == catalog.variant(f"special:{core}").names
    assert catalog.variant("arona").lobby is None


@pytest.mark.parametrize("category,core", [
    ("spinebackground", "arona_workpage_daytime"), ("spinebackground", "arona_workpage_night"),
    ("spinebackground", "plana_workpage"), ("spinebackground", "aoi_workpage"),
    ("spinebackground", "cafe"), ("spinebackground", "arona_home"),
    ("spinebackground", "scene_spr"), ("spinecharacters", "arona_workpage"), ("spinelobbies", "task"),
    ("spinecharacters", "arona_home"), ("spinelobbies", "scene_spr"),
])
@pytest.mark.parametrize("scan", [True, False])
def test_special_add_apply_switch_toggle_reload_restore(setup_library, category, core, scan):
    env = setup_library
    target = game_bundle(env.game_dir, core, category=category)
    companion = game_bundle(env.game_dir, core, part="002", category=category)
    original, companion_bytes = target.read_bytes(), companion.read_bytes()
    env.catalog = catalog_for([target])
    env.library = ModLibrary(env.root, env.catalog, None, env.settings, scan_allowed=lambda: scan)
    key = f"special:{core}"
    first, = env.library.add([make_mod(target, env.tmp / "first", b"first mod")])
    second, = env.library.add([make_mod(target, env.tmp / "second", b"second mod")])
    assert (first.target, first.kind, first.core) == (key, "lobby", core)
    assert parse_filename(first.file.name).category == category
    assert env.library.preview_bundles(first.id)[-1] == first.file
    assert env.library.apply(key, f"mod:{first.id}", kind="lobby").files == [target]
    assert target.read_bytes() == first.file.read_bytes()
    assert companion.read_bytes() == companion_bytes
    assert env.library.live_bundles(core)[-1] == target
    state = env.library.state(key)
    assert all(f.kind == "lobby" and f.restorable for f in state.files)
    assert key in env.library.modified()
    if scan:
        entry = next(e for e in env.library.entries() if e.core == core)
        assert (entry.variant, entry.kind) == (key, "lobby")
    env.library.apply(key, f"mod:{second.id}", kind="lobby")
    assert target.read_bytes() == second.file.read_bytes()
    off = env.library.toggle(False, True)
    assert off.failed == []
    assert target.read_bytes() == original
    assert env.library.configured(key)["lobby"] == f"mod:{second.id}"
    deferred = env.library.apply(key, f"mod:{first.id}", kind="lobby")
    assert deferred.deferred and deferred.files == []
    assert target.read_bytes() == original
    env.library = ModLibrary(env.root, env.catalog, None, env.settings, scan_allowed=lambda: scan)
    on = env.library.toggle(True, False)
    assert on.failed == []
    assert target.read_bytes() == first.file.read_bytes()
    env.library.restore(key, kind="lobby")
    assert target.read_bytes() == original
    assert companion.read_bytes() == companion_bytes
    assert env.library.configured(key)["lobby"] is None
    env.library.apply(key, f"mod:{first.id}", kind="lobby")
    removed = env.library.remove(first.id)
    assert removed.failed == [] and removed.kinds == ["lobby"]
    assert target.read_bytes() == original


@pytest.mark.parametrize("category,core", [("spinebackground", "arona_workpage_daytime"),
                                         ("spinecharacters", "arona_workpage"), ("spinelobbies", "task"),
                                         ("spinecharacters", "arona_home"), ("spinelobbies", "scene_spr")])
def test_container_owns_all_scene_layers(tmp_path, monkeypatch, category, core):
    path = game_bundle(tmp_path, core, category=category)
    containers = [f"Assets/_MX/{category}/{core}/{layer}" for layer in
                  ("arona_home.skel", "arona_home.atlas", "background.skel", "background.atlas", "page.png")]
    objects(monkeypatch, ["arona_home.skel", "background.skel", "page"], containers)
    assert content_cores(path) == {core}
    name, target, kind = identify(path, path.name, catalog_for([path], ["arona_spr"]))
    assert (name, target, kind) == (path.name, f"special:{core}", "lobby")


def test_background_container_overrules_renamed_student_filename(tmp_path, monkeypatch):
    target = game_bundle(tmp_path, "plana_workpage", category="spinebackground")
    upload = game_bundle(tmp_path / "input", "arona_spr")
    objects(monkeypatch, ["plana_home.skel", "background.skel"],
            ["Assets\\_MX\\SpineBackground\\plana_workpage\\plana_home.skel"])
    name, key, kind = identify(upload, upload.name, catalog_for([target], ["arona_spr"]))
    parsed = parse_filename(name)
    assert (key, kind, parsed.category, parsed.core) == ("special:plana_workpage", "lobby", "spinebackground", "plana_workpage")


@pytest.mark.parametrize("names", [["background.skel", "arona_home.skel", "character.atlas"], ["generic_texture"], ["arona_workpage.skel"]])
def test_background_parts_without_containers_keep_the_filename(tmp_path, monkeypatch, names):
    path = game_bundle(tmp_path, "arona_workpage", category="spinebackground")
    objects(monkeypatch, names)
    assert identify(path, path.name, catalog_for([path])) == (path.name, "special:arona_workpage", "lobby")


@pytest.mark.parametrize("cores,code", [(["missing_workpage"], "mod_target_unknown"),
                                       (["arona_workpage", "plana_workpage"], "mod_target_ambiguous")])
def test_unknown_or_conflicting_background_containers_refuse_upload(tmp_path, monkeypatch, cores, code):
    paths = [game_bundle(tmp_path, core, category="spinebackground") for core in ("arona_workpage", "plana_workpage")]
    objects(monkeypatch, containers=[f"Assets/_MX/SpineBackground/{core}/layer.skel" for core in cores])
    with pytest.raises(ServiceError) as error:
        identify(paths[0], paths[0].name, catalog_for(paths))
    assert error.value.code == code


def test_special_rpc_and_preview_use_existing_lobby_routes(setup_library, monkeypatch):
    env = setup_library
    target = game_bundle(env.game_dir, "arona_workpage_daytime", category="spinebackground")
    game = GameAssets([env.game_dir], AssetCache(root=env.tmp / "cache"))
    catalog = Catalog(game, None)
    env.library.catalog = catalog
    monkeypatch.setattr("ba_modding_toolkit.gameassets.service.extract_spine", lambda paths: {
        "arona_workpage_daytime.skel": paths[-1].read_bytes(), "arona_workpage_daytime.atlas": b"atlas"})
    services = Services(env.settings, env.tmp / "ui", game=game, catalog=catalog, library=env.library)
    try:
        api = build_api(services)
        family = api.call("family.get", {"key": "arona"})["result"]
        v, = family["variants"]
        assert (v["key"], v["spineCategory"], v["spr"], v["lobby"]) == (
            "special:arona_workpage_daytime", "spinebackground", None, "arona_workpage_daytime")
        assert v["state"]["files"][0]["kind"] == "lobby"
        entry, = env.library.add([make_mod(target, env.tmp / "input")])
        env.library.apply(v["key"], f"mod:{entry.id}", kind="lobby")
        for kind, key, expected in [("lobby", v["lobby"], entry.file.read_bytes()),
                                    ("mod", entry.id, entry.file.read_bytes()),
                                    ("official-lobby", v["lobby"], (env.root / "originals" / target.name).read_bytes())]:
            prefix = f"spine/{kind}/{key}"
            revision = json.loads(services.asset(f"{prefix}/manifest.json", {}).body)["revision"]
            assert services.asset(f"{prefix}/{revision}/skeleton.skel", {}).body == expected
    finally:
        services.close()
