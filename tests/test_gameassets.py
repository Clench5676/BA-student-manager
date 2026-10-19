"""Game asset units and read-only integration checks against a local install."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.gameassets import AssetCache, AssetNotFound, GameAssets
from ba_modding_toolkit.gameassets import service, unity
from ba_modding_toolkit.gameassets.discovery import (
    bundle_paths, group_bundles, is_pointer_texture, is_prefab, is_texture, resource_version,
)
from ba_modding_toolkit.gameassets.layouts import export_layout, subtree
from ba_modding_toolkit.gameassets.spine import atlas_pages, extract_spine
from ba_modding_toolkit.searching import get_search_dirs

logger = logging.getLogger(__name__)
# reference files extracted earlier, only when named (BAMT_TEST_PROTOTYPE); they may come from a modded install
PROTOTYPE = Path(os.environ.get("BAMT_TEST_PROTOTYPE") or "/nonexistent/bamt-prototype")
# the real-install tests run only on an official game folder named by BAMT_TEST_GAME_DIR
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")
real_install = pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install")


def test_cache_lru_and_byte_budget(tmp_path):
    cache = AssetCache(root=tmp_path / "cache", max_bytes=6)
    cache.put("a", b"aaa")
    cache.put("b", b"bbb")
    assert cache.get("a") == b"aaa"
    cache.put("c", b"ccc")
    assert cache.get("b") is None
    assert cache.get("a") == b"aaa"
    assert cache.get("c") == b"ccc"
    assert cache.memory_bytes == 6
    cache.put("c", b"c")
    assert cache.memory_bytes == 4
    cache.put("oversize", b"1234567")
    assert cache.get("oversize") is None
    assert cache.memory_bytes == 4
    assert not (tmp_path / "cache").exists()


def test_cache_consent_switch_and_clear(tmp_path):
    root = tmp_path / "cache"
    version = "a" * 40
    cache = AssetCache(version, root=root, max_bytes=0)
    cache.put("before-consent", b"private")
    assert not root.exists()
    cache.allowed = True
    cache.put("light", b"light")
    assert (root / version).is_dir()
    assert cache.get("light") == b"light"
    cache.allowed = False
    cache.put("new", b"new")
    assert cache.get("light") is None
    assert len(list(root.rglob("*.cache"))) == 1
    cache.allowed = True
    assert cache.get("light") == b"light"
    cache.put("heavy", b"heavy", disk=False)
    assert cache.get("heavy", disk=False) is None
    assert cache.get("light", disk=False) is None
    assert len(list(root.rglob("*.cache"))) == 1
    assert cache.get("light", version="b" * 40) is None
    cache.allowed = False
    cache.clear()
    assert not root.exists()


def test_cache_accounts_decoded_images_and_versions(tmp_path):
    cache = AssetCache(root=tmp_path, max_bytes=16)
    image = Image.new("RGBA", (2, 2))
    cache.put("image", image, disk=False)
    assert cache.memory_bytes == 16
    cache.put("same-key", b"a", version="one")
    assert cache.get("image", disk=False) is None
    cache.put("same-key", b"b", version="two")
    assert cache.get("same-key", version="one") == b"a"
    assert cache.get("same-key", version="two") == b"b"


def test_resource_version_catalog_and_listing(tmp_path):
    resources = tmp_path / "Resource"
    dirs = [resources / "GameData/Windows", resources / "Preload/Windows"]
    for directory in dirs:
        directory.mkdir(parents=True)
    (dirs[0] / "a.bundle").write_bytes(b"abc")
    initial = resource_version(dirs)
    assert initial == resource_version(list(reversed(dirs)))
    (dirs[1] / "b.bundle").write_bytes(b"x")
    assert resource_version(dirs) != initial
    (dirs[1] / "b.bundle").unlink()
    (dirs[0] / "a.bundle").write_bytes(b"abcd")
    assert resource_version(dirs) != initial
    catalog = tmp_path / "Catalog/Windows/catalog_Windows.hash"
    catalog.parent.mkdir(parents=True)
    catalog.write_bytes(b"catalog version")
    assert resource_version(dirs) == hashlib.sha1(b"catalog version").hexdigest()
    (dirs[0] / "a.bundle").write_bytes(b"changed")
    assert resource_version(dirs) == hashlib.sha1(b"catalog version").hexdigest()
    catalog.write_bytes(b"updated catalog")
    assert resource_version(dirs) != hashlib.sha1(b"catalog version").hexdigest()


def test_bundle_discovery_grouping_and_family_filters(tmp_path):
    names = [
        "assets-_mx-spinecharacters-hoshino_spr-_mxdependency-2024-11-18_000_assets_all_12.bundle",
        "assets-_mx-spinecharacters-hoshino_spr-_mxdependency-2024-11-18_001_assets_all_34.bundle",
        "assets-_mx-spinelobbies-hoshino_home-textures-2024-11-18_assets_all_56.bundle",
        "assets-_mx-spinelobbies-hoshino_home-textassets-2024-11-18_assets_all_78.bundle",
    ]
    for name in names:
        (tmp_path / name).touch()
    (tmp_path / "ignored.backup").touch()
    (tmp_path / "directory.bundle").mkdir()
    paths = bundle_paths([tmp_path])
    assert len(paths) == 4
    assert len(group_bundles(paths, "spinecharacters")["hoshino_spr"]) == 2
    assert len(group_bundles(paths, "spinelobbies")["hoshino_home"]) == 2
    for prefix in ("uis-00_images-_mxload-", "uis-00_images-formation-_mxload-",
                   "prologdepengroup-assets-_mx-addressableasset-uis-_mxprolog-",
                   "prologgroup-assets-_mx-addressableasset-uis-00_images-imagefont-",
                   "uis-01_common-09_popupimage-", "uis-01_common-13_campaignimage-"):
        assert is_texture(Path(prefix + "2024-11-18.bundle"))
    assert not is_texture(Path(names[0]))
    assert not is_texture(Path("uis-01_common-14_charactercollect-_mxload-2024-11-18.bundle"))
    assert is_prefab(Path("prologdepengroup-assets-_mx-addressableasset-ui-_mxprolog-example.bundle"))
    assert not is_prefab(Path("uis-00_images-_mxload-example.bundle"))


def test_lazy_construction_and_missing_game(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Construction must not build indexes or load bundles")
    monkeypatch.setattr(service, "bundle_paths", forbidden)
    monkeypatch.setattr(service, "resource_version", forbidden)
    monkeypatch.setattr(unity.Bundle, "load", forbidden)
    GameAssets([tmp_path], AssetCache(root=tmp_path / "cache"))
    for directories in ([], [tmp_path / "absent"]):
        with pytest.raises(ServiceError) as error:
            GameAssets(directories, AssetCache(root=tmp_path))
        assert error.value.code == "game_not_found"


def test_concurrent_index_computed_once(tmp_path, monkeypatch):
    game = GameAssets([tmp_path], AssetCache(root=tmp_path / "cache"))
    barrier = threading.Barrier(8)
    calls = []

    def scan():
        calls.append(1)
        time.sleep(0.02)
        return {"sprites": {"Common": {"Back": {"width": 10}}}}

    monkeypatch.setattr(game, "_scan_atlases", scan)

    def request(_):
        barrier.wait()
        return game.atlases()

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(request, range(8)))
    assert len(calls) == 1
    results[0]["Common"]["Back"]["width"] = 0
    assert game.atlases()["Common"]["Back"]["width"] == 10


def test_bundle_load_and_reads_serialized_by_path(tmp_path, monkeypatch):
    active = 0
    maximum = 0
    guard = threading.Lock()

    def load(path, log):
        nonlocal active, maximum
        with guard:
            active += 1
            maximum = max(maximum, active)
        return SimpleNamespace(env=object())

    monkeypatch.setattr(unity.Bundle, "load", load)

    def read(_):
        nonlocal active
        with unity.open_bundle(tmp_path / "same.bundle"):
            time.sleep(0.005)
            with guard:
                active -= 1

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(read, range(8)))
    assert maximum == 1


class _Object:
    def __init__(self, kind, pid, cab, name="", tree=None, data=None, externals=()):
        self.type = SimpleNamespace(name=kind)
        self.path_id = pid
        self.assets_file = SimpleNamespace(name=cab, externals=[SimpleNamespace(path=p) for p in externals])
        self._name, self._tree, self._data = name, tree, data
        self.reads = 0

    def peek_name(self):
        return self._name

    def read_typetree(self):
        return self._tree

    def read(self):
        self.reads += 1
        return self._data


def _fake_prefab(nodes: dict[int, tuple[str, int]], behaviours: list[tuple[int, int, str, dict]],
                 inactive: tuple[int, ...] = ()) -> SimpleNamespace:
    """A prefab environment: nodes by GameObject path id as (name, parent's path id or 0), each with its Transform
    at path id + 1000; behaviours as (path id, node, script class, serialized fields)."""
    objects, transforms = [], {}
    for gid, (name, parent) in nodes.items():
        objects.append(_Object("GameObject", gid, "CAB-ui", data=SimpleNamespace(
            m_Name=name, m_IsActive=gid not in inactive)))
        transforms[gid] = SimpleNamespace(
            m_GameObject=SimpleNamespace(path_id=gid), m_LocalRotation=SimpleNamespace(z=0.0, w=1.0),
            m_LocalPosition=SimpleNamespace(x=0.0, y=0.0), m_LocalScale=SimpleNamespace(x=1.0, y=1.0),
            m_Father=SimpleNamespace(path_id=parent and parent + 1000), m_Children=[])
    for gid, (name, parent) in nodes.items():
        if parent:
            transforms[parent].m_Children.append(SimpleNamespace(read=lambda t=transforms[gid]: t))
        objects.append(_Object("Transform", gid + 1000, "CAB-ui", data=transforms[gid]))
    scripts = {}
    for pid, gid, cls, fields in behaviours:
        objects.append(_Object("MonoBehaviour", pid, "CAB-ui", tree={
            "m_GameObject": {"m_FileID": 0, "m_PathID": gid}, "m_Enabled": 1,
            "m_Script": {"m_FileID": 0, "m_PathID": scripts.setdefault(cls, 2000 + len(scripts))},
            "m_Name": "", **fields}))
    objects += [_Object("MonoScript", pid, "CAB-ui", data=SimpleNamespace(m_ClassName=cls))
                for cls, pid in scripts.items()]
    return SimpleNamespace(objects=objects)


def _without_states(node: dict) -> dict:
    """A layout without the state controllers' "states", the export format before layout-v2."""
    result = dict(node, widgets=[{k: v for k, v in w.items() if k != "states"} for w in node["widgets"]])
    if "children" in node:
        result["children"] = [_without_states(child) for child in node["children"]]
    return result


def _pointer(pid: int, fid: int = 0) -> dict:
    return {"m_FileID": fid, "m_PathID": pid}


def test_layout_exports_state_controller_nodes():
    """The game's buttons have no NGUI button colours: a locked or disabled button is a node of its own that a
    controller shows instead of the normal one (the lobby's bottom menu: Able, and Disable with the icon tinted
    #797979). The export names each controller field's node by its path below the controller's node."""
    nodes = {1: ("Root", 0), 2: ("Craft", 1), 3: ("Label", 2), 4: ("Able", 2), 5: ("Disable", 2), 6: ("Icon", 5),
             7: ("Lock", 5), 8: ("BlockEntry", 2), 9: ("Other", 1), 10: ("Entry", 1), 11: ("Locked", 10),
             12: ("Cover", 11)}
    grey = 121 / 255
    behaviours = [
        (100, 2, "OpenConditionButtonController", {
            "contentType": 7, "prohibitionType": 0, "Enable": _pointer(4), "Disable": _pointer(5),
            "Prohibited": _pointer(8), "CallCheckInEnable": 0, "PrefsKeyPrefix": ""}),
        (101, 6, "UISprite", {"mSpriteName": "Common_Icon_Craft", "mAtlas": _pointer(0), "mType": 0, "mFlip": 0,
                              "mWidth": 120, "mHeight": 120, "mColor": {"r": grey, "g": grey, "b": grey, "a": 1.0}}),
        # a component pointer resolves to its node, also when the component is read after the controller; a node
        # outside the controller's, an external pointer and an unset one give None
        (102, 10, "ButtonActivator", {"activeObject": _pointer(12), "inactiveObject": _pointer(9),
                                      "button": _pointer(103), "contentsLockObject": _pointer(0)}),
        (103, 10, "MXButton", {"PlaySound": 1, "onClick": [], "label": _pointer(0)}),
        (104, 1, "UIButtonEnableSwitch", {"enableButton": _pointer(1004), "disableButton": _pointer(5, fid=1)}),
    ]
    tree = export_layout(_fake_prefab(nodes, behaviours, inactive=(5, 8)), "Root", {})
    assert json.loads(json.dumps(tree)) == tree
    craft = subtree(tree, "Craft")
    assert craft["widgets"] == [{"cls": "OpenConditionButtonController",
                                 "states": {"Enable": "Able", "Disable": "Disable", "Prohibited": "BlockEntry"}}]
    disabled = subtree(craft, craft["widgets"][0]["states"]["Disable"])
    assert not disabled["active"] and subtree(craft, "Able")["active"]
    icon = subtree(disabled, "Icon")["widgets"][0]
    assert (icon["sprite"], icon["color"]) == ("Common_Icon_Craft", "#797979/1.00")
    activator, button = subtree(tree, "Entry")["widgets"]
    assert activator["states"] == {"activeObject": "Locked/Cover", "inactiveObject": None, "button": "",
                                   "contentsLockObject": None}
    assert button == {"cls": "MXButton"}
    assert tree["widgets"][0]["states"] == {"enableButton": "Craft/Able", "disableButton": None}
    assert _without_states(tree)["widgets"] == [{"cls": "UIButtonEnableSwitch"}]


def test_layout_cache_key_carries_the_export_format(tmp_path, monkeypatch):
    """A layout cached in the format before the state controllers ("layout/") is exported again under its new key;
    the old entry and every other cached entry stay."""
    game = GameAssets([tmp_path], AssetCache(root=tmp_path / "cache", allowed=True))
    version = game.resource_version
    stale = json.dumps({"name": "Root", "widgets": [{"cls": "OpenConditionButtonController"}]}).encode()
    game.cache.put(service._SCHEMA + "layout/Root", stale, version=version)
    game.cache.put(service._SCHEMA + "atlases", b"{}", version=version)
    fresh = {"name": "Root", "active": True, "widgets": [{"cls": "OpenConditionButtonController", "states": {
        "Enable": "Able", "Disable": "Disable", "Prohibited": None}}]}
    exports = []

    @contextmanager
    def open_fake(path):
        yield SimpleNamespace(objects=[])

    def export(env, root, names):
        exports.append(root)
        return fresh

    monkeypatch.setattr(service, "open_bundle", open_fake)
    monkeypatch.setattr(service, "export_layout", export)
    monkeypatch.setattr(GameAssets, "_prefab_bundle", lambda self, root: tmp_path / "prefab.bundle")
    monkeypatch.setattr(GameAssets, "_index", lambda self, key, build, **kwargs: {})
    monkeypatch.setattr(GameAssets, "_atlas_index", lambda self: {"names": {}})
    monkeypatch.setattr(GameAssets, "_texture_index", lambda self: {"names": {}})
    assert game.layout("Root") == fresh and exports == ["Root"]
    # a new memory cache: what it finds is on disk
    warm = GameAssets([tmp_path], AssetCache(root=tmp_path / "cache", allowed=True))
    assert warm.layout("Root", "") == fresh and exports == ["Root"]
    assert warm.cache.get(service._SCHEMA + "layout/Root", version=version) == stale
    assert warm.cache.get(service._SCHEMA + "atlases", version=version) == b"{}"


def test_external_atlas_crop_orientation_and_decode_once(tmp_path, monkeypatch):
    original, relocated = tmp_path / "original", tmp_path / "relocated"
    for directory in (original, relocated):
        directory.mkdir()
        (directory / "uis-atlas-first.bundle").touch()
        (directory / "uis-atlas-second.bundle").touch()
    first, second = original / "uis-atlas-first.bundle", original / "uis-atlas-second.bundle"
    atlas = _Object("MonoBehaviour", 1, "CAB-atlas", externals=["archive:/CAB-texture"], tree={
        "m_Name": "Test", "mSprites": [{"name": "top", "x": 1, "y": 0, "width": 1, "height": 1},
                                          {"name": "bottom", "x": 1, "y": 1, "width": 1, "height": 1},
                                          {"name": "left", "x": 0, "y": 0, "width": 1, "height": 1}],
        "material": {"m_FileID": 1, "m_PathID": 2}})
    material = _Object("Material", 2, "CAB-texture", tree={"m_SavedProperties": {
        "m_TexEnvs": [("_MainTex", {"m_Texture": {"m_FileID": 0, "m_PathID": 3}})]}})
    image = Image.new("RGBA", (2, 2), "blue")
    image.putpixel((1, 0), (255, 0, 0, 255))
    texture = _Object("Texture2D", 3, "CAB-texture", name="Test", data=SimpleNamespace(image=image))
    envs = {first: SimpleNamespace(objects=[atlas]), second: SimpleNamespace(objects=[material, texture])}
    envs.update({relocated / path.name: env for path, env in list(envs.items())})
    loads = []

    @contextmanager
    def open_fake(path):
        loads.append(path)
        yield envs[path]

    monkeypatch.setattr(service, "open_bundle", open_fake)
    game = GameAssets([original], AssetCache(root=tmp_path / "cache", allowed=True))
    assert Image.open(BytesIO(game.sprite_png("Test", "top"))).getpixel((0, 0)) == (255, 0, 0, 255)
    assert Image.open(BytesIO(game.sprite_png("Test", "bottom"))).getpixel((0, 0)) == (0, 0, 255, 255)
    assert texture.reads == 1
    assert game.atlases()["Test"]["top"]["paddingBottom"] == 0
    # Disk indexes locate bundles in the current install after relocation.
    moved = GameAssets([relocated], AssetCache(root=tmp_path / "cache", allowed=True))
    assert moved.resource_version == game.resource_version
    assert Image.open(BytesIO(moved.sprite_png("Test", "left"))).getpixel((0, 0)) == (0, 0, 255, 255)
    assert loads[-1] == relocated / second.name


POINTER_BUNDLES = (
    "assets-_mx-uis-glpc_cursor-_mxdependency-textures-2026-10-13_assets_all_4004527728.bundle",
    "assets-_mx-uis-_mxcommon-_mxdependency-textures-2026-04-06_assets_all_3563113514.bundle",
    "assets-_mx-effectsfreezed-texture-_mxdependency-2024-11-18_001_assets_all_3681797415.bundle",
    "prologdepengroup-assets-_mx-effectsfreezed-texture-_mxprolog-2024-11-18_assets_all_1621163271.bundle",
)


def test_pointer_texture_families():
    for name in POINTER_BUNDLES:
        assert is_pointer_texture(Path(name))
        # an index of their own: the UI texture index (and its listing) stays as it was
        assert not is_texture(Path(name))
    for name in ("assets-_mx-characters-ch0305-_mxdependency-textures-2026-04-06_assets_all_4018753285.bundle",
                 "uis-00_images-_mxload-2024-11-18.bundle", "assets-_mx-effectsfreezed-material-_mxdependency-1.bundle"):
        assert not is_pointer_texture(Path(name))


def test_texture_route_falls_back_to_the_pointer_textures(tmp_path, monkeypatch):
    ui, cursor, fx = (tmp_path / name for name in ("uis-00_images-_mxload-2024-11-18.bundle", *POINTER_BUNDLES[::2]))
    for path in (ui, cursor, fx):
        path.touch()
    pointer = Image.new("RGBA", (4, 4), (0, 128, 255, 255))
    envs = {
        ui: SimpleNamespace(objects=[_Object("Texture2D", 1, "CAB-ui", name="UITex_BGBlueLight",
                                             data=SimpleNamespace(image=Image.new("RGBA", (2, 2), "white")))]),
        cursor: SimpleNamespace(objects=[_Object("Texture2D", 1, "CAB-cursor", name="PCIcon_MousePoint",
                                                 data=SimpleNamespace(image=pointer))]),
        fx: SimpleNamespace(objects=[_Object("Texture2D", 7, "CAB-fx", name="FX_TEX_Trail_03",
                                             data=SimpleNamespace(image=Image.new("RGBA", (8, 2), "red")))]),
    }

    @contextmanager
    def open_fake(path):
        yield envs[path]

    monkeypatch.setattr(service, "open_bundle", open_fake)
    game = GameAssets([tmp_path], AssetCache(root=tmp_path / "cache", allowed=True))
    assert game.textures() == ["UITex_BGBlueLight"]
    assert Image.open(BytesIO(game.texture_png("PCIcon_MousePoint"))).getpixel((1, 1)) == (0, 128, 255, 255)
    assert Image.open(BytesIO(game.texture_png("FX_TEX_Trail_03"))).size == (8, 2)
    assert Image.open(BytesIO(game.texture_png("UITex_BGBlueLight"))).size == (2, 2)
    with pytest.raises(AssetNotFound):
        game.texture_png("Cursor_404")
    # light assets: the pointer index and its PNGs may be kept on disk with consent
    fresh = GameAssets([tmp_path], AssetCache(root=tmp_path / "cache", allowed=True))
    envs.clear()
    assert Image.open(BytesIO(fresh.texture_png("PCIcon_MousePoint"))).size == (4, 4)


def test_collection_art_names():
    # backgrounds named after a scenario background (CostumeExcel's CollectionBGTexturePath, e.g. Junko (New Year))
    for name in ("BG_Abydos_Collection", "BG_NewYearFestival2", "BG_WaterFall", "BG_Hyakkiyako_Collection_kr",
                 "Student_Portrait_CH0192_Collection"):
        assert service.is_collection_art(name)
    for name in ("NPC_Portrait_Arona_Collection", "Student_Portrait_CH0192", "UITex_BGPoliLight_1"):
        assert not service.is_collection_art(name)


def test_collection_backgrounds_without_the_collection_suffix(tmp_path, monkeypatch):
    collect = tmp_path / "uis-01_common-14_charactercollect-_mxload-2024-11-18_000_assets_all_1238120891.bundle"
    scenario = tmp_path / "uis-03_scenario-01_background-_mxload-2024-11-18_assets_all_3187232994.bundle"
    for path in (collect, scenario):
        path.touch()

    def texture(pid, name, color):
        return _Object("Texture2D", pid, "CAB-collect", name=name,
                       data=SimpleNamespace(image=Image.new("RGB", (4, 3), color)))
    envs = {collect: SimpleNamespace(objects=[
        texture(1, "BG_Abydos_Collection", "white"), texture(2, "BG_NewYearFestival2", "red"),
        texture(3, "Student_Portrait_CH0192_Collection", "blue"), texture(4, "NPC_Portrait_Arona_Collection", "black"),
    ]), scenario: SimpleNamespace(objects=[_Object("Texture2D", 1, "CAB-scenario", name="BG_ScenarioOnly")])}

    @contextmanager
    def open_fake(path):
        yield envs[path]

    monkeypatch.setattr(service, "open_bundle", open_fake)
    cache = AssetCache(root=tmp_path / "cache", allowed=True)
    game = GameAssets([tmp_path], cache)
    assert game.collection_names() == {"bg": ["BG_Abydos_Collection", "BG_NewYearFestival2"],
                                       "portrait": ["Student_Portrait_CH0192_Collection"]}
    data, mime = game.collection_bg("BG_NewYearFestival2")
    assert mime == "image/png"
    assert Image.open(BytesIO(data)).getpixel((0, 0))[:3] == (255, 0, 0)
    # the routes' prefix checks: only backgrounds as backgrounds, only portraits as portraits
    for call in (lambda: game.collection_bg("Student_Portrait_CH0192_Collection"),
                 lambda: game.collection_portrait("BG_NewYearFestival2"),
                 lambda: game.collection_bg("BG_ScenarioOnly"),
                 lambda: game.collection_portrait("NPC_Portrait_Arona_Collection")):
        with pytest.raises(AssetNotFound):
            call()
    # heavy art: neither the index nor the image reaches the disk, even with consent
    assert not cache.root.exists()


def test_loading_screen_prefab_hints():
    # UILoading lives in Resources/UI, which the prefab scan has to reach after a game update renames the bundle
    assert is_prefab(Path("prologgroup-assets-_mx-resources-ui-_mxprolog-2026-04-13_assets_all_2006567787.bundle"))
    assert not is_prefab(Path("prologgroup-assets-_mx-resources-excel-_mxprolog-2026-04-13_assets_all_1.bundle"))
    assert service.PREFAB_HINTS["UILoading"].startswith("prologgroup-assets-_mx-resources-ui-")
    assert is_prefab(Path(service.PREFAB_HINTS["UILoading"]))
    assert is_prefab(Path(service.PREFAB_HINTS["UIRepeater"]))


def test_unknown_names_raise_asset_not_found(tmp_path):
    game = GameAssets([tmp_path], AssetCache(root=tmp_path / "cache"))
    for call in (lambda: game.sprite_png("missing", "missing"), lambda: game.texture_png("missing"),
                 lambda: game.layout("missing"), lambda: game.collection_bg("missing"),
                 lambda: game.collection_portrait("missing"), lambda: game.spine_files("spr", "missing"),
                 lambda: game.spine_cores("invalid"), lambda: game.spine_files_from([])):
        with pytest.raises(AssetNotFound):
            call()


def test_spine_atlas_pages_and_aliases(tmp_path, monkeypatch):
    atlas = b"\nPages/Hero.PNG\nsize: 1,1\nfilter: Linear,Linear\nregion.png\n  xy: 0,0\n\nsecond.png\nsize: 1,1\n"
    assert atlas_pages(atlas) == ["Pages/Hero.PNG", "second.png"]
    objects = [
        _Object("TextAsset", 1, "CAB", data=SimpleNamespace(m_Name="hero.atlas", m_Script=atlas.decode())),
        _Object("TextAsset", 2, "CAB", data=SimpleNamespace(m_Name="hero.skel", m_Script="\udcffbinary")),
        _Object("Texture2D", 3, "CAB", data=SimpleNamespace(m_Name="hero", image=Image.new("RGBA", (1, 1)))),
        _Object("Texture2D", 4, "CAB", data=SimpleNamespace(m_Name="second.png", image=Image.new("RGBA", (1, 1)))),
    ]

    @contextmanager
    def open_fake(path):
        yield SimpleNamespace(objects=objects)

    monkeypatch.setattr("ba_modding_toolkit.gameassets.spine.open_bundle", open_fake)
    files = extract_spine([tmp_path / "fake.bundle"])
    assert files["hero.skel"] == b"\xffbinary"
    assert files["Pages/Hero.PNG"] == files["hero.png"]
    assert files["second.png"].startswith(b"\x89PNG")
    assert "second.png.png" not in files


def test_mod_spine_cache_invalidates_without_disk_writes(tmp_path, monkeypatch):
    path = tmp_path / "mod.bundle"
    path.write_bytes(b"first")
    cache = AssetCache(root=tmp_path / "cache", allowed=True)
    game = GameAssets([tmp_path], cache)
    calls = []

    def extract(paths):
        calls.append(1)
        return {"test.skel": paths[0].read_bytes()}

    monkeypatch.setattr(service, "extract_spine", extract)
    result = game.spine_files_from([path])
    assert result == {"test.skel": b"first"}
    result["test.skel"] = b"caller mutation"
    assert game.spine_files_from([path]) == {"test.skel": b"first"}
    assert len(calls) == 1
    path.write_bytes(b"updated")
    assert game.spine_files_from([path]) == {"test.skel": b"updated"}
    assert len(calls) == 2
    assert not cache.root.exists()
    with pytest.raises(AssetNotFound):
        game.spine_files_from([tmp_path / "absent.bundle"])


@pytest.mark.parametrize("library_dir,game_dir", [("a-library", "z-game"), ("z-library", "a-game")])
@pytest.mark.parametrize("texture_only", [False, True])
def test_spine_mod_overrides_win_independent_of_paths_and_cache_order(
        tmp_path, monkeypatch, library_dir, game_dir, texture_only):
    official = tmp_path / game_dir / "preload.bundle"
    mod = tmp_path / library_dir / "mod.bundle"
    for path in (official, mod):
        path.parent.mkdir()
        path.touch()
    atlas = "Pages/Hero.PNG\nsize: 1,1\n"
    def objects(color, skeleton):
        return [
            _Object("TextAsset", 1, "CAB", data=SimpleNamespace(m_Name="hero.skel", m_Script=skeleton)),
            _Object("TextAsset", 2, "CAB", data=SimpleNamespace(m_Name="hero.atlas", m_Script=atlas)),
            _Object("Texture2D", 3, "CAB", data=SimpleNamespace(
                m_Name="hero", image=Image.new("RGBA", (1, 1), color))),
        ]
    official_objects = objects("blue", "official")
    official_objects.append(_Object("TextAsset", 4, "CAB", data=SimpleNamespace(
        m_Name="extra.skel", m_Script="official extra")))
    mod_objects = objects("red", "modded")
    if texture_only:
        mod_objects = mod_objects[-1:]
    loads = []
    @contextmanager
    def open_fake(path):
        loads.append(path)
        yield SimpleNamespace(objects=mod_objects if path == mod else official_objects)
    monkeypatch.setattr("ba_modding_toolkit.gameassets.spine.open_bundle", open_fake)
    cache = AssetCache(root=tmp_path / "cache", allowed=True)
    game = GameAssets([official.parent], cache)
    files = game.spine_files_from([official, mod])
    assert files["hero.skel"] == (b"official" if texture_only else b"modded")
    assert files["hero.atlas"] == atlas.encode()
    assert files["extra.skel"] == b"official extra"
    assert files["Pages/Hero.PNG"] == files["hero.png"]
    assert Image.open(BytesIO(files["hero.png"])).getpixel((0, 0)) == (255, 0, 0, 255)
    assert loads == [official, mod]
    assert game.spine_files_from([official, mod]) == files
    assert loads == [official, mod]
    # The same paths in another order are a different composition, not a cache hit.
    reversed_files = game.spine_files_from([mod, official])
    assert reversed_files["hero.skel"] == b"official"
    assert Image.open(BytesIO(reversed_files["hero.png"])).getpixel((0, 0)) == (0, 0, 255, 255)
    assert loads == [official, mod, mod, official]
    assert not cache.root.exists()


@pytest.fixture(scope="module")
def real_game(tmp_path_factory):
    if not GAME_DIR.is_dir():
        pytest.skip("No local game install")
    cache = AssetCache(root=tmp_path_factory.mktemp("gameassets") / "cache", allowed=True)
    return GameAssets(get_search_dirs(GAME_DIR), cache)


@real_install
def test_real_atlases_and_sprite_pixels(real_game):
    start = time.perf_counter()
    index = real_game.atlases()
    logger.info("Cold atlases: %.3f s", time.perf_counter() - start)
    assert "Common_Icon_Back" in index["Common"]
    for sprite in ("Common_Icon_Back", "Common_Btn_BG", "Common_Bg_Raius10px_Shadow"):
        rect = index["Common"][sprite]
        image = Image.open(BytesIO(real_game.sprite_png("Common", sprite))).convert("RGBA")
        assert image.size == (rect["width"], rect["height"])
        prototype = PROTOTYPE / "assets/game-ui/sprites/Common" / (sprite + ".png")
        if prototype.is_file():
            with Image.open(prototype) as expected:
                assert image.tobytes() == expected.convert("RGBA").tobytes()


@real_install
def test_real_pointer_and_touch_effect_textures(real_game):
    """The PC client's pointer (UIs/GLPC_Cursor) and FX_Touch's textures, as cursor.js asks for them."""
    sizes = {"PCIcon_MousePoint": (64, 64), "FX_TEX_Grad_Ring3": (256, 128), "FX_TEX_Circle_01": (512, 512),
             "FX_TEX_Triangle_02_1": (256, 128), "FX_TEX_Trail_03": (512, 512)}
    for name, size in sizes.items():
        image = Image.open(BytesIO(real_game.texture_png(name))).convert("RGBA")
        assert image.size == size, name
    pointer = Image.open(BytesIO(real_game.texture_png("PCIcon_MousePoint"))).convert("RGBA")
    assert pointer.getpixel((1, 1))[3] > 0          # the arrow's tip is the top left corner (hotspot 0, 0)
    assert pointer.getpixel((63, 63))[3] == 0
    assert "PCIcon_MousePoint" not in real_game.textures()


@real_install
def test_real_textures(real_game):
    names = real_game.textures()
    assert "UITex_BGBlueLight" in names
    prototype = PROTOTYPE / "assets/game-ui/sprites/textures.json"
    if prototype.is_file():
        assert set(json.loads(prototype.read_text())) <= set(names)
    image = Image.open(BytesIO(real_game.texture_png("UITex_BGBlueLight")))
    assert image.width > 0 and image.height > 0


@real_install
@pytest.mark.parametrize("root,subpath,filename", [
    ("UICharacterDetail", "", "UICharacterDetail"),
    ("UICharacterCollection", "", "UICharacterCollection"),
    ("UICharacterCollectionPopulatorUnit", "", "UICharacterCollectionPopulatorUnit"),
    ("UIPopup_Sort", "", "UIPopup_Sort"),
    ("UIPopup_GachaCharList", "Center/Popup/Btn_Checkbox", "UIPopup_GachaCharList.Btn_Checkbox"),
])
def test_real_layouts_match_prototype(real_game, root, subpath, filename):
    start = time.perf_counter()
    layout = real_game.layout(root, subpath)
    logger.info("Layout %s: %.3f s", root, time.perf_counter() - start)
    assert layout["name"] == (subpath.rsplit("/", 1)[-1] if subpath else root)
    prototype = PROTOTYPE / "research-v4/layouts" / (filename + ".json")
    if prototype.is_file():
        # the saved layouts predate the state controllers' "states" (test_layout_exports_state_controller_nodes)
        assert _without_states(layout) == json.loads(prototype.read_text())
    assert json.loads(json.dumps(layout)) == layout
    with pytest.raises(AssetNotFound):
        real_game.layout(root, "does-not-exist")


@real_install
def test_real_disk_warm_without_unity_loads(real_game, monkeypatch):
    expected_atlases = real_game.atlases()
    expected_layout = real_game.layout("UICharacterDetail")
    # A new memory cache proves these are genuinely disk hits.
    cache = AssetCache(root=real_game.cache.root, allowed=True)
    warm = GameAssets(real_game.resource_dirs, cache)

    def forbidden(path):
        pytest.fail("A disk-warm request must not load Unity bundles")

    monkeypatch.setattr(service, "open_bundle", forbidden)
    start = time.perf_counter()
    assert warm.atlases() == expected_atlases
    assert warm.layout("UICharacterDetail") == expected_layout
    logger.info("Disk-warm atlases and detail layout: %.3f s", time.perf_counter() - start)


@real_install
def test_real_collection_art_stays_in_memory(real_game):
    before = {p: p.stat().st_mtime_ns for p in real_game.cache.root.rglob("*") if p.is_file()}
    names = real_game.collection_names()
    assert "Student_Portrait_Hoshino_Collection" in names["portrait"]
    assert "BG_Abydos_Collection" in names["bg"]
    portrait = real_game.collection_portrait("Student_Portrait_Hoshino_Collection")
    background, mime = real_game.collection_bg("BG_Abydos_Collection")
    assert mime == "image/png"
    for data in (portrait, background):
        image = Image.open(BytesIO(data))
        assert image.width > 0 and image.height > 0
    after = {p: p.stat().st_mtime_ns for p in real_game.cache.root.rglob("*") if p.is_file()}
    assert before == after


@real_install
def test_real_catalog_backgrounds_resolve(real_game):
    """Every shipped background of a variant whose collection portrait is installed (so released on this server) is
    in the collection index, including the ones not named *_Collection (Junko (New Year): BG_NewYearFestival2)."""
    from ba_modding_toolkit.catalog import DEFAULT_DATA

    names = real_game.collection_names()
    portraits, backgrounds = set(names["portrait"]), set(names["bg"])
    variants = json.loads(DEFAULT_DATA.read_text(encoding="utf-8"))["variants"]
    expected = {entry["bg"] for entry in variants.values() if entry.get("bg") and entry.get("portrait") in portraits}
    assert {"BG_NewYearFestival2", "BG_WaterFall"} <= expected
    assert sorted(expected - backgrounds) == []
    background, mime = real_game.collection_bg("BG_NewYearFestival2")
    assert mime == "image/png" and Image.open(BytesIO(background)).size == (1024, 768)


@real_install
@pytest.mark.parametrize("kind,core", [("spr", "hoshino_spr"), ("lobby", "hoshino_home")])
def test_real_spine_files_and_pages_stay_in_memory(real_game, kind, core):
    before = set(real_game.cache.root.rglob("*.cache"))
    groups = real_game.spine_cores(kind)
    assert len(groups[core]) > 1
    files = real_game.spine_files(kind, core)
    assert any(name.endswith(".skel") for name in files)
    atlases = [name for name in files if name.endswith(".atlas")]
    assert atlases
    for name in atlases:
        pages = atlas_pages(files[name])
        assert pages
        for page in pages:
            assert files[page].startswith(b"\x89PNG")
    assert set(real_game.cache.root.rglob("*.cache")) == before





@real_install
def test_real_detail_layout_places_the_portrait(real_game):
    # the detail screen frames portraits on this node (web/js/portrait-view.js): its origin and a uniform scale
    detail = real_game.layout("UICharacterDetail")
    content = next(c for c in detail["children"] if c["name"] == "Inventory_ListControl")
    node = next(c for c in content["children"] if c["name"] == "CharacterPos")
    assert len(node["pos"]) == 2 and node["scale"][0] == node["scale"][1] > 0


@real_install
def test_real_lobby_menu_disabled_look(real_game):
    """The lobby's bottom menu, where the greyed navigation takes the game's disabled look from: each entry with an
    open condition swaps Able for Disable, the same icon tinted #797979 beside a lock; the label is outside both."""
    grid = real_game.layout("UILobby", "Front/Bottom/Menu/BG/Grid")
    for name in ("Cafe", "Craft", "Shop", "Gacha"):
        entry = subtree(grid, name)
        controller = next(w for w in entry["widgets"] if w["cls"] == "OpenConditionButtonController")
        assert (controller["states"]["Enable"], controller["states"]["Disable"]) == ("Able", "Disable"), name
        able, disabled = subtree(entry, "Able"), subtree(entry, "Disable")
        assert able["active"] and not disabled["active"]
        normal = next(w for w in able["widgets"] if "sprite" in w)
        icon = subtree(disabled, "Icon")["widgets"][0]
        assert (icon["sprite"], icon["color"], normal["color"]) == (normal["sprite"], "#797979/1.00", "#ffffff/1.00")
        assert subtree(disabled, "Lock")["widgets"][0]["sprite"] == "Common_Icon_Lock"
        assert "text" in subtree(entry, "Label")["widgets"][0]
