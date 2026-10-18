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
    bundle_paths, group_bundles, is_prefab, is_texture, resource_version,
)
from ba_modding_toolkit.gameassets.spine import atlas_pages, extract_spine
from ba_modding_toolkit.searching import get_search_dirs

logger = logging.getLogger(__name__)
PROTOTYPE = Path("/Users/A200237264/Repos/BA-student-manager/prototype")
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR", str(
    Path.home() / "Library/Application Support/Blue Archive/Game")))
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
        assert layout == json.loads(prototype.read_text())
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
