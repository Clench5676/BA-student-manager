"""Library behavior with synthetic headers, fakes, and temporary game copies."""

from __future__ import annotations

import json
import os
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageChops, ImageStat

from ba_modding_toolkit import core, mod_install
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.catalog.models import CoreMap
from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.i18n import I18n
from ba_modding_toolkit.library import ModLibrary
from ba_modding_toolkit.library import safety, service, storage
from ba_modding_toolkit.models import AssetType, FilePair, ModUpdateResult
from ba_modding_toolkit.naming import parse_filename
from ba_modding_toolkit.searching import get_search_dirs
from ba_modding_toolkit.utils import CRCUtils


@dataclass
class FakeVariant:
    key: str
    spr: str | None
    lobby: str | None = None
    family: str = "test"


class FakeCatalog:
    def __init__(self, *variants):
        self.variants = {v.key: v for v in variants}

    def variant(self, key):
        return self.variants[key]

    def variant_for_core(self, core):
        return next((v for v in self.variants.values() if core in (v.spr, v.lobby)), None)

    def families(self):
        return [SimpleNamespace(key="test", variants=list(self.variants.values()))]

    def core_map(self, spr_cores, lobby_cores, special_cores=()):
        """Any install's cores by the variants' cores; another core by the plain rule (the core less its suffix)."""
        keys, spr, lobby = {}, {}, {}
        for core in [*spr_cores, *lobby_cores]:
            variant = self.variant_for_core(core.lower())
            key = variant.key if variant else core.lower().removesuffix("_spr").split("_home")[0]
            keys[core.lower()] = key
            (spr if core.lower().endswith("_spr") else lobby).setdefault(key, core)
        return CoreMap(keys, spr, lobby, {})


def header_bundle(payload=b"official"):
    header = b"UnityFS\x00" + (6).to_bytes(4, "big") + b"5.x.x\x002021.3\x00"
    return header + (len(header) + 8 + len(payload)).to_bytes(8, "big") + payload


def game_bundle(directory, core_name="test_spr", part="003", date="2026-01-01", payload=b"official", category=None):
    directory.mkdir(parents=True, exist_ok=True)
    data = header_bundle(payload)
    category = category or ("spinecharacters" if core_name.endswith("_spr") else "spinelobbies")
    suffix = f"{date}_{part}" if part.isdigit() else f"{part}-{date}"
    name = f"assets-_mx-{category}-{core_name}-_mxdependency-{suffix}_assets_all_{CRCUtils.compute_crc32(data)}.bundle"
    path = directory / name
    path.write_bytes(data)
    return path


def make_mod(source, directory, payload=b"modded!!", fixed=False):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / source.name
    data = header_bundle(payload)
    if fixed:
        data = CRCUtils.apply_crc_fix(data, int(parse_filename(source.name).crc))
    path.write_bytes(data)
    return path


@pytest.fixture
def setup_library(tmp_path, monkeypatch, header_only_bundles):
    game_dir = tmp_path / "game"
    original = game_bundle(game_dir)
    catalog = FakeCatalog(FakeVariant("test", "test_spr", "test_home_gl"),
                          FakeVariant("other", "other_spr", family="other"))
    settings = Settings(tmp_path / "config.toml")
    settings.set("game_resource_dir", str(game_dir))
    settings.set("enable_crc_correction", "false")
    settings.set("compression_method", "none")
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    monkeypatch.setattr(Bundle, "check_need_crc", lambda *args, **kwargs: False)
    library = ModLibrary(tmp_path / "library", catalog, object(), settings)
    return SimpleNamespace(library=library, original=original, catalog=catalog, settings=settings,
                           root=library.root, tmp=tmp_path, game_dir=game_dir)


def reload_library(env):
    return ModLibrary(env.root, env.catalog, object(), env.settings)


def expect_error(code, action):
    with pytest.raises(ServiceError) as caught:
        action()
    assert caught.value.code == code
    json.dumps(caught.value.to_json())


@pytest.mark.parametrize("language", ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"])
def test_add_apply_and_restore_progress_name_the_phase(setup_library, monkeypatch, language):
    env = setup_library
    translate = I18n(language).t
    monkeypatch.setattr(service, "t", translate)
    progress = []
    source = make_mod(env.original, env.tmp / "upload", fixed=True)
    monkeypatch.setattr(env.settings, "crc_needed", lambda path: True)
    result = env.library.add_and_apply([source], progress=lambda *args: progress.append(args))
    assert result.applied and not result.failed
    assert progress[:2] == [(i, 1, translate("webui.progress.add", name=source.name)) for i in (0, 1)]
    assert progress[-1] == (1, 1, translate("webui.progress.apply", name=env.original.name))
    progress.clear()
    env.library.restore("test", progress=lambda *args: progress.append(args))
    assert progress == [(1, 1, translate("webui.progress.restore", name=env.original.name))]


def test_direct_install_build_progress_names_processing(setup_library, monkeypatch):
    env = setup_library
    translate = I18n("en-US").t
    monkeypatch.setattr(service, "t", translate)
    source = make_mod(env.original, env.tmp / "upload")
    entry, = env.library.add([source])
    execute = mod_install.execute_mod_install

    def report(*args, **kwargs):
        kwargs["progress_callback"](0, 1, "test_spr")
        return execute(*args, **kwargs)

    monkeypatch.setattr(mod_install, "execute_mod_install", report)
    progress = []
    env.library.apply("test", f"mod:{entry.id}", progress=lambda *args: progress.append(args))
    assert (0, 1, "Processing: test_spr") in progress
    assert progress[-1] == (1, 1, f"Applying: {env.original.name}")


@pytest.mark.parametrize("kind", ["spr", "lobby"])
def test_apply_already_crc_fixed_mod_copies_without_unity_rebuild(setup_library, monkeypatch, kind):
    env = setup_library
    target = env.original if kind == "spr" else game_bundle(env.game_dir, "test_home_gl", part="textures")
    mod = make_mod(target, env.tmp / "fixed", fixed=True)
    entry = env.library.add([mod])[0]
    monkeypatch.setattr(env.settings, "crc_needed", lambda path: True)

    def no_rebuild(*args, **kwargs):
        pytest.fail("A verified CRC-fixed mod must not be loaded or recompressed")

    monkeypatch.setattr(Bundle, "load", no_rebuild)
    result = env.library.apply("test", f"mod:{entry.id}", kind=kind)
    assert result.files == [target]
    assert target.read_bytes() == mod.read_bytes()
    assert next(part for part in env.library.state("test").files if part.file == target).applied == f"mod:{entry.id}"


def test_crc_skip_checks_actual_bytes_and_valid_header(setup_library, monkeypatch):
    env = setup_library
    monkeypatch.setattr(env.settings, "crc_needed", lambda path: True)
    fixed = make_mod(env.original, env.tmp / "fixed", fixed=True)
    unfixed = make_mod(env.original, env.tmp / "unfixed")
    assert not env.library._needs_crc_fix(fixed, env.original)
    assert env.library._needs_crc_fix(unfixed, env.original)
    # A CRC suffix alone, or a CRC collision on truncated bytes, cannot authorize the fast path.
    fixed.write_bytes(fixed.read_bytes()[:-1])
    assert env.library._needs_crc_fix(fixed, env.original)
    fixed.write_bytes(CRCUtils.apply_crc_fix(b"invalid header", int(parse_filename(fixed.name).crc)))
    assert env.library._needs_crc_fix(fixed, env.original)


def test_add_deduplicates_preserves_filename_and_detects_targets(setup_library):
    env = setup_library
    mod = make_mod(env.original, env.tmp / "input")
    entries = env.library.add([mod, mod])
    assert len(entries) == 1
    entry = entries[0]
    assert entry.file == env.root / "mods" / entry.id / mod.name
    assert entry.file.read_bytes() == mod.read_bytes()
    assert (entry.target, entry.kind, entry.fresh, entry.date) == ("test", "spr", True, "2026-01-01")
    assert entry.added.endswith("+00:00")
    assert entry.user_added and reload_library(env).mods()[0].user_added
    assert env.library.add([mod]) == []
    lobby = game_bundle(env.tmp / "lobby", "test_home_gl", payload=b"lobby")
    assert env.library.add([lobby])[0].kind == "lobby"
    lobby = game_bundle(env.tmp / "home", "test_home", payload=b"home")
    env.catalog.variants["test"].lobby = "test_home"
    assert env.library.add([lobby])[0].target == "test"
    json.dumps(entry.to_json())


def test_add_bundle_backup_strips_only_backup_suffix(setup_library):
    env = setup_library
    backup = env.tmp / (env.original.name + ".backup")
    backup.write_bytes(env.original.read_bytes())
    entry = env.library.add([backup])[0]
    assert entry.file.name == env.original.name
    assert entry.crc == parse_filename(env.original.name).crc


@pytest.mark.parametrize("parts", [("002", "003"), ("textassets", "textures")])
def test_add_groups_parts_and_deduplicates_whole_mods(setup_library, parts):
    env = setup_library
    sources = [game_bundle(env.tmp / "input", part=part, payload=part.encode()) for part in parts]
    entry, = env.library.add([*sources, sources[0]])
    assert entry.size == sum(path.stat().st_size for path in sources)
    library = reload_library(env)
    assert library.mods() == [entry]
    assert {path.name for path in entry.file.parent.glob("*.bundle")} == {path.name for path in sources}
    assert library.add(list(reversed(sources))) == []
    # A separate partial mod remains selectable, and sharing a file with it must
    # not strip that part from a later complete pack.
    partial, = library.add([sources[0]])
    library.remove(entry.id)
    complete, = library.add(sources)
    assert partial.id != complete.id
    assert complete.size == entry.size
    assert len(list(complete.file.parent.glob("*.bundle"))) == 2


def test_add_separates_cores_dates_and_kinds(setup_library):
    env = setup_library
    sources = [env.original,
               game_bundle(env.tmp / "input", date="2026-02-01", payload=b"newer"),
               game_bundle(env.tmp / "input", "other_spr"),
               game_bundle(env.tmp / "input", "test_home_gl")]
    entries = env.library.add(sources)
    assert len(entries) == 4
    assert {(entry.target, entry.kind, entry.date) for entry in entries} == {
        ("test", "spr", "2026-01-01"), ("test", "spr", "2026-02-01"),
        ("other", "spr", "2026-01-01"), ("test", "lobby", "2026-01-01")}


def test_add_rolls_back_incomplete_pack(setup_library, monkeypatch):
    env = setup_library
    sources = [game_bundle(env.tmp / "input", part=part) for part in ("002", "003")]
    from ba_modding_toolkit.library import service
    original_copy = service.atomic_copy
    def copy(source, target):
        if source == sources[1]:
            raise PermissionError(13, "Read failure", str(source))
        original_copy(source, target)
    monkeypatch.setattr(service, "atomic_copy", copy)
    expect_error("library_io_error", lambda: env.library.add(sources))
    assert env.library.mods() == reload_library(env).mods() == []
    assert not list((env.root / "mods").glob("*/*.bundle"))


@pytest.mark.parametrize("parts", [("002", "003"), ("textassets", "textures")])
def test_applying_partial_mod_resets_other_parts_and_tracks_logical_source(setup_library, parts):
    env = setup_library
    env.original.unlink()
    targets = [game_bundle(env.game_dir, part=part, payload=part.encode()) for part in parts]
    official = {path: path.read_bytes() for path in targets}
    pack_files = [make_mod(path, env.tmp / "pack", payload=b"pack " + part.encode())
                  for path, part in zip(targets, parts)]
    pack, = env.library.add(pack_files)
    partial, = env.library.add([make_mod(targets[1], env.tmp / "partial", payload=b"texture only")])
    assert set(env.library.apply("test", f"mod:{pack.id}").files) == set(targets)
    assert [path.read_bytes() for path in targets] == [path.read_bytes() for path in pack_files]
    assert env.library.state("test").applied == f"mod:{pack.id}"
    result = env.library.apply("test", f"mod:{partial.id}")
    assert set(result.files) == set(targets)
    assert targets[0].read_bytes() == official[targets[0]]
    assert targets[1].read_bytes() == partial.file.read_bytes()
    library = reload_library(env)
    assert library.state("test").applied == f"mod:{partial.id}"
    assert all(file.applied == f"mod:{partial.id}" for file in library.state("test").files)
    assert library.modified() == {"test": f"mod:{partial.id}"}
    assert library.apply("test", f"mod:{partial.id}").unchanged
    assert library.modified() == {"test": f"mod:{partial.id}"}
    library.restore("test")
    assert {path: path.read_bytes() for path in targets} == official


def test_partial_mod_tracks_source_for_untouched_official_parts(setup_library):
    env = setup_library
    untouched = game_bundle(env.game_dir, part="002", payload=b"skeleton")
    before = untouched.stat().st_mtime_ns
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    assert untouched.stat().st_mtime_ns == before
    library = reload_library(env)
    assert library.state("test").applied == f"mod:{entry.id}"
    assert library.modified() == {"test": f"mod:{entry.id}"}
    # The unchanged baseline part also has the cheap stamp used by modified().
    data = json.loads((env.root / "state.json").read_text())
    assert data["applied"][str(untouched)]["mtime"] == before


@pytest.mark.parametrize("parts", [("000", "001", "002", "003"),
                                     ("materials", "textassets", "textures")])
@pytest.mark.parametrize("complete", [False, True])
def test_preview_matches_individual_parts_and_keeps_official_fallbacks(setup_library, parts, complete):
    env = setup_library
    env.original.unlink()
    targets = [game_bundle(env.game_dir, part=part, payload=part.encode()) for part in parts]
    lobby = game_bundle(env.game_dir, "test_home_gl", payload=b"lobby")
    # Install another mod so the preview must use a retained original rather
    # than the currently installed skeleton/atlas.
    old, = env.library.add([make_mod(targets[-2], env.tmp / "old", payload=b"old atlas")])
    env.library.apply("test", f"mod:{old.id}")
    selected = parts if complete else parts[-1:]
    sources = [game_bundle(env.tmp / "input", part=part, date="2025-01-01", payload=b"mod " + part.encode())
               for part in selected]
    entry, = env.library.add(sources)
    result = env.library.preview_bundles(entry.id)
    mod_paths = sorted(entry.file.parent.glob("*.bundle"))
    expected = [env.root / "originals" / path.name if path == targets[-2] else path
                for path in sorted(targets) if parse_filename(path.name).res_type not in selected]
    assert result == expected + mod_paths
    assert all(env.library._is_official(path) for path in expected)
    assert lobby not in result


def test_preview_keeps_preload_parts_before_mod_overrides(setup_library):
    env = setup_library
    preload = env.game_dir / ("prologdepengroup-" + env.original.name)
    preload.write_bytes(env.original.read_bytes())
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    assert env.library.preview_bundles(entry.id) == [preload, entry.file]


@pytest.mark.parametrize("core,kind", [("test_spr", "spr"), ("test_home_gl", "lobby"), ("other_spr", "spr")])
def test_official_preview_uses_kept_parts_and_is_unavailable_without_them(setup_library, monkeypatch, core, kind):
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.webui.services import Services

    env = setup_library
    env.original.unlink()
    targets = [game_bundle(env.game_dir, core, part=part, payload=b"official")
               for part in ("textassets", "textures")]
    expected = targets[0].read_bytes()
    game = GameAssets([env.game_dir], AssetCache(root=env.tmp / "cache", allowed=False))
    reads = []

    def extract(paths):
        reads.append(paths)
        files = {}
        for path in paths:
            if parse_filename(path.name).res_type == "textassets":
                files.update({f"{core}.skel": path.read_bytes(), f"{core}.atlas": path.read_bytes()})
            else:
                files["Pages/portrait.png"] = path.read_bytes()
        return files

    monkeypatch.setattr("ba_modding_toolkit.gameassets.service.extract_spine", extract)
    services = Services(env.settings, env.tmp / "ui", game=game, catalog=env.catalog, library=env.library)
    prefix = f"spine/official-{kind}/{core}"
    try:
        before = json.loads(services.asset(f"{prefix}/manifest.json", {}).body)["revision"]
        assert services.asset(f"{prefix}/{before}/skeleton.skel", {}).body == expected
        entry, = env.library.add([make_mod(targets[0], env.tmp / "input", payload=b"modified")])
        variant = "other" if core == "other_spr" else "test"
        env.library.apply(variant, f"mod:{entry.id}", kind=kind)
        kept = env.root / "originals" / targets[0].name
        assert targets[0].read_bytes() != expected
        assert env.library.official_bundles(core) == [kept, targets[1]]
        after = json.loads(services.asset(f"{prefix}/manifest.json", {}).body)["revision"]
        assert after != before
        for name in ("skeleton.skel", "skeleton.atlas", "Pages/portrait.png"):
            assert services.asset(f"{prefix}/{after}/{name}", {}).body == expected
        assert reads[-1] == [kept, targets[1]]
        assert services.asset(f"spine/mod/{entry.id}/skeleton.skel", {}).body == entry.file.read_bytes()
        with pytest.raises(KeyError):
            services.asset(f"{prefix}/{before}/Pages/portrait.png", {})
        kept.unlink()
        expect_error("original_unavailable", lambda: env.library.official_bundles(core))
        expect_error("original_unavailable", lambda: services.asset(f"{prefix}/manifest.json", {}))
        expect_error("original_unavailable", lambda: services.asset(f"{prefix}/{after}/Pages/portrait.png", {}))
    finally:
        services.close()


def test_live_bundles_put_the_parts_that_carry_a_mod_last(setup_library):
    env = setup_library
    # file names list the text assets before the textures: a mod over the first would be merged under the official
    # texture, which wins a name both carry (the mod's atlas drawn over the official page)
    targets = [game_bundle(env.game_dir, "test_home_gl", part=part, payload=b"official")
               for part in ("textassets", "textures")]
    other = game_bundle(env.game_dir, "test_home_gl", part="textures", payload=b"other", date="2026-02-02")
    stray = env.game_dir / other.name.replace("-spinelobbies-", "-characters-")
    other.rename(stray)  # same core, another category: no Spine files
    assert sorted(targets) == targets  # the order the game folder lists them
    assert env.library.live_bundles("test_home_gl") == targets
    entry, = env.library.add([make_mod(targets[0], env.tmp / "input", payload=b"modified")])
    env.library.apply("test", f"mod:{entry.id}", kind="lobby")
    assert env.library.live_bundles("TEST_HOME_GL") == [targets[1], targets[0]]
    assert env.library.live_bundles("test_home_gl") == env.library.live_bundles("test_home_gl")
    # the preview of the mod and the official parts leave the other category out too
    assert stray not in env.library.official_bundles("test_home_gl")
    assert stray not in env.library.preview_bundles(entry.id)
    expect_error("game_file_not_found", lambda: env.library.live_bundles("absent_home"))


@pytest.mark.parametrize("kind,core_name", [("spr", "test_spr"), ("lobby", "test_home_gl")])
def test_live_spine_files_merge_in_the_previews_order(setup_library, monkeypatch, kind, core_name):
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.webui.api import build_api
    from ba_modding_toolkit.webui.services import Services

    env = setup_library
    first = env.original if kind == "spr" else game_bundle(env.game_dir, core_name, part="textassets")
    targets = [first, game_bundle(env.game_dir, core_name, part="textures")]
    cache = AssetCache(root=env.tmp / "cache", allowed=True)
    game = GameAssets([env.game_dir], cache)
    reads = []

    def extract(paths):
        reads.append(paths)
        return {f"{core_name}.skel": b"skeleton", f"{core_name}.atlas": b"atlas",
                "page.png": paths[-1].read_bytes()}

    monkeypatch.setattr("ba_modding_toolkit.gameassets.service.extract_spine", extract)
    services = Services(env.settings, env.tmp / "ui", cache=cache, game=game, catalog=env.catalog, library=env.library)
    prefix = f"spine/{kind}/{core_name}"
    try:
        for name in ("manifest.json", "skeleton.skel"):
            services.asset(f"{prefix}/{name}", {})
        entry, = env.library.add([make_mod(targets[0], env.tmp / "input", payload=b"modified")])
        env.library.apply("test", f"mod:{entry.id}", kind=kind)
        revision = json.loads(services.asset(f"{prefix}/manifest.json", {}).body)["revision"]
        for clear in (False, True):
            if clear:
                assert build_api(services).call("settings.clearCache", {}) == {"result": None}
            assert json.loads(services.asset(f"{prefix}/manifest.json", {}).body)["revision"] == revision
            assert services.asset(f"{prefix}/{revision}/skeleton.skel", {}).body == b"skeleton"
            assert services.asset(f"{prefix}/{revision}/page.png", {}).body == targets[0].read_bytes()
        # the applied part goes after the official one, whatever the file names say
        assert reads == [targets, [targets[1], targets[0]], [targets[1], targets[0]]]
    finally:
        services.close()


def test_partial_mod_preview_rejects_same_size_live_mod_as_official_fallback(setup_library):
    env = setup_library
    texture = game_bundle(env.game_dir, part="textures")
    entry, = env.library.add([make_mod(texture, env.tmp / "input")])
    # An external overwrite has a valid header and official size, but no original exists.
    env.original.write_bytes(header_bundle(b"modified"))
    expect_error("original_unavailable", lambda: env.library.preview_bundles(entry.id))


def test_legacy_single_file_record_can_apply_and_reset_other_parts(setup_library):
    env = setup_library
    mod_id = "a" * 32
    mod = make_mod(env.original, env.root / "mods" / mod_id)
    (env.root / "state.json").write_text(json.dumps({"version": 1, "mods": [{
        "id": mod_id, "files": [mod.name], "label": "Legacy", "target": "test", "kind": "spr",
        "added": "2026-01-01T00:00:00+00:00", "seen": False}]}))
    other_part = game_bundle(env.game_dir, part="002", payload=b"skeleton")
    official = other_part.read_bytes()
    library = reload_library(env)
    old, = library.add([make_mod(other_part, env.tmp / "old", payload=b"stale atlas")])
    library.apply("test", f"mod:{old.id}")
    library.apply("test", f"mod:{mod_id}")
    assert other_part.read_bytes() == official
    assert env.original.read_bytes() == mod.read_bytes()
    assert library.state("test").applied == f"mod:{mod_id}"


@pytest.mark.parametrize("name", ["image.png", "unknown.bundle", "test_spr.bundle",
                                      "assets-_mx-characters-test-2026-01-01_123.bundle",
                                      "assets-_mx-spinecharacters-absent_spr-2026-01-01_123.bundle"])
def test_add_rejects_unsupported_targets(setup_library, name):
    env = setup_library
    path = env.tmp / name
    path.write_bytes(header_bundle())
    expect_error("mod_target_unknown" if "absent_spr" in name else "mod_unsupported",
                 lambda: env.library.add([path]))
    assert env.library.mods() == []


def test_add_accepts_every_memorial_lobby_core(setup_library):
    env = setup_library
    env.catalog.variants["other"].lobby = "other_home_teen"
    lobby = game_bundle(env.game_dir, "other_home_teen", payload=b"teen lobby")
    entry, = env.library.add([make_mod(lobby, env.tmp / "input")])
    assert (entry.kind, entry.target) == ("lobby", "other")


def test_state_round_trip_seen_labels_favorites_and_removal(setup_library):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    env.library.rename(entry.id, "My portrait")
    env.library.mark_seen(entry.id)
    env.library.set_favorite("test", True)
    library = reload_library(env)
    assert library.mods()[0].label == "My portrait"
    assert library.mods()[0].fresh is False
    assert library.favorites() == {"test"}
    snapshot = library.favorites()
    snapshot.clear()
    assert library.favorites() == {"test"}
    library.set_favorite("test", False)
    library.remove(entry.id)
    assert reload_library(env).mods() == []
    assert not entry.file.exists()
    assert reload_library(env).favorites() == set()
    expect_error("mod_not_found", lambda: library.mark_seen(entry.id))


@pytest.mark.parametrize("contents", ["{broken", "[]", "null", '{"version":1,"mods":null}',
                                       '{"version":1,"mods":[{}]}'])
def test_corrupt_state_is_tolerated(setup_library, contents):
    env = setup_library
    env.root.mkdir(exist_ok=True)
    (env.root / "state.json").write_text(contents)
    library = reload_library(env)
    assert library.mods() == []
    assert library.favorites() == set()
    library.set_favorite("test", True)
    assert json.loads((env.root / "state.json").read_text())["favorites"] == ["test"]


def test_state_lists_all_parts_and_uses_cached_hashes_without_loading(setup_library, monkeypatch):
    env = setup_library
    game_bundle(env.game_dir, part="002", payload=b"skeleton")
    game_bundle(env.game_dir, "test_home_gl", payload=b"lobby")
    monkeypatch.setattr(Bundle, "load", lambda *args, **kwargs: pytest.fail("State must not load bundles"))
    state = env.library.state("test")
    assert len(state.files) == 3
    assert state.applied == "official" and state.crc == "ok" and state.backup is False
    assert all(file.date == "2026-01-01" for file in state.files)
    monkeypatch.setattr(CRCUtils, "compute_crc32", lambda *args: pytest.fail("Hashes should be cached"))
    assert env.library.state("test") == state
    json.dumps(state.to_json())


def test_apply_keeps_original_once_tracks_hashes_and_restores(setup_library):
    env = setup_library
    original_bytes = env.original.read_bytes()
    first = env.library.add([make_mod(env.original, env.tmp / "first")])[0]
    logs, events = [], []
    result = env.library.apply("test", f"mod:{first.id}", logs.append, lambda *args: events.append(args))
    assert result.files == [env.original]
    backup = env.root / "originals" / env.original.name
    assert backup.read_bytes() == original_bytes
    backup_stat = backup.stat()
    assert env.library.state("test").applied == f"mod:{first.id}"
    assert env.library.state("test").crc == "needs_fix"
    assert reload_library(env).state("test").applied == f"mod:{first.id}"
    second = env.library.add([make_mod(env.original, env.tmp / "second", b"another!")])[0]
    env.library.apply("test", f"mod:{second.id}")
    assert backup.read_bytes() == original_bytes
    assert backup.stat().st_mtime_ns == backup_stat.st_mtime_ns
    assert env.library.apply("test", f"mod:{second.id}").unchanged
    assert env.library.state("test").applied == f"mod:{second.id}"
    assert env.library.state("test").backup is True
    assert env.library.restore("test").source == "official"
    assert env.original.read_bytes() == original_bytes
    assert env.library.state("test").applied == "official"
    # verified official again: the kept copy is deleted
    assert not backup.exists() and env.library.state("test").backup is False
    assert env.library.restore("test").unchanged
    assert logs and events
    json.dumps(result.to_json())


def test_crc_fixed_state_and_external_change_invalidates_applied_record(setup_library):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])[0]
    env.library.apply("test", f"mod:{entry.id}")
    assert env.library.state("test").crc == "fixed"
    env.original.write_bytes(header_bundle(b"external"))
    # the detail screen judges cheaply: no trailing bytes and the official size read as official
    state = env.library.state("test")
    assert state.applied == "official" and state.crc == "ok"
    env.library.apply("test", "official")
    assert env.library.state("test").applied == "official"
    # the write judges in full: the outside change was kept as a mod before it was overwritten
    kept, = [m for m in env.library.mods() if m.id != entry.id]
    assert kept.file.read_bytes() == header_bundle(b"external")


def test_reapplying_identical_external_mod_records_its_source(setup_library):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    env.library.apply("test", f"mod:{entry.id}")
    # Lose just the applied history, as can happen after recovering corrupt state.
    state_path = env.root / "state.json"
    data = json.loads(state_path.read_text())
    data["applied"] = {}
    state_path.write_text(json.dumps(data))
    library = reload_library(env)
    assert library.state("test").applied == "official"  # no record, the official size, no trailing bytes
    assert library.apply("test", f"mod:{entry.id}").unchanged
    assert reload_library(env).state("test").applied == f"mod:{entry.id}"


@pytest.mark.parametrize("enabled", [False, True])
def test_crc_setting_overrides_installer_platform_detection(setup_library, monkeypatch, enabled):
    env = setup_library
    env.settings.set("enable_crc_correction", "true" if enabled else "false")
    monkeypatch.setattr(Bundle, "check_need_crc", lambda *args, **kwargs: not enabled)
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    saved = []
    def load(path, *args, **kwargs):
        def save(output, options):
            saved.append(options.perform_crc)
            data = CRCUtils.apply_crc_fix(path.read_bytes(), int(parse_filename(output.name).crc))
            output.write_bytes(data)
            return True, "saved"
        return SimpleNamespace(save=save)
    monkeypatch.setattr(Bundle, "load", load)
    env.library.apply("test", f"mod:{entry.id}")
    assert saved == ([True] if enabled else [])
    assert env.library.state("test").crc == ("fixed" if enabled else "needs_fix")


def test_atomic_state_failure_keeps_previous_state_and_memory(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    previous = (env.root / "state.json").read_bytes()
    original_replace = storage.os.replace
    def fail_state(source, target):
        if Path(target).name == "state.json":
            raise PermissionError(13, "Read-only state", str(target))
        return original_replace(source, target)
    monkeypatch.setattr(storage.os, "replace", fail_state)
    expect_error("library_io_error", lambda: env.library.rename(entry.id, "New label"))
    expect_error("library_io_error", lambda: env.library.mark_seen(entry.id))
    expect_error("library_io_error", lambda: env.library.set_favorite("test", True))
    assert env.library.mods()[0] == entry
    assert env.library.favorites() == set()
    assert (env.root / "state.json").read_bytes() == previous
    assert not list(env.root.glob(".state-*"))


def test_install_rolls_back_when_state_cannot_be_saved(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    original_bytes = env.original.read_bytes()
    original_replace = storage.os.replace
    def fail_state(source, target):
        if Path(target).name == "state.json":
            raise PermissionError(13, "Read-only state", str(target))
        return original_replace(source, target)
    monkeypatch.setattr(storage.os, "replace", fail_state)
    expect_error("library_io_error", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert env.original.read_bytes() == original_bytes
    assert env.library.state("test").applied == "official"
    # the game file is official again after the rollback: its kept copy is not needed
    assert not (env.root / "originals" / env.original.name).exists()
    assert reload_library(env).state("test").applied == "official"


@pytest.mark.parametrize("cloning", [False, True])
def test_multi_part_install_rolls_back_every_part_on_write_failure(setup_library, monkeypatch, cloning):
    env = setup_library
    atlas = game_bundle(env.game_dir, part="002", payload=b"atlas")
    targets = [atlas, env.original]
    before = {path: path.read_bytes() for path in targets}
    entry, = env.library.add([make_mod(path, env.tmp / "input", payload=b"mod " + path.name.encode())
                              for path in targets])
    from ba_modding_toolkit.library import service
    monkeypatch.setattr(storage, "_clone", lambda source, target: bool(shutil.copyfile(source, target)) if cloning else False)
    original_copy = service.atomic_copy
    original_clone, original_move = service.atomic_clone, service.verified_move
    written = []
    def copy(source, target):
        if target == env.original:
            assert written == [atlas]
            # every official part is kept before the first game file is written
            assert all((env.root / "originals" / path.name).read_bytes() == before[path] for path in targets)
            raise PermissionError(13, "Write failure", str(target))
        original_copy(source, target)
        if target in targets:
            written.append(target)

    def clone(source, target):
        result = original_clone(source, target)
        if result and target in targets:
            written.append(target)
        return result

    def move(source, target, sha1):
        original_move(source, target, sha1)
        if target in targets:
            written.append(target)

    monkeypatch.setattr(service, "atomic_copy", copy)
    monkeypatch.setattr(service, "atomic_clone", clone)
    monkeypatch.setattr(service, "verified_move", move)
    expect_error("game_file_locked", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert written == ([atlas, atlas] if cloning else [atlas, env.original, atlas])
    assert {path: path.read_bytes() for path in targets} == before
    assert reload_library(env).state("test").applied == "official"
    # rolled back to official: the kept copies are released
    assert not any((env.root / "originals" / path.name).exists() for path in targets)


@pytest.mark.parametrize("fixed", [False, True])
def test_never_keeps_a_modded_game_file_as_original(setup_library, fixed):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    foreign = make_mod(env.original, env.tmp / "foreign", b"foreign!", fixed=fixed)
    shutil.copyfile(foreign, env.original)
    before = env.original.read_bytes()
    expect_error("original_unavailable", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert env.original.read_bytes() == before
    assert not (env.root / "originals" / env.original.name).exists()


def test_invalid_kept_original_is_never_overwritten(setup_library):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    backup = env.root / "originals" / env.original.name
    backup.parent.mkdir(parents=True)
    backup.write_bytes(b"invalid")
    expect_error("original_invalid", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert backup.read_bytes() == b"invalid"


def test_refuses_install_plan_outside_resource_dirs(setup_library, monkeypatch):
    env = setup_library
    outside = game_bundle(env.tmp / "outside")
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    groups = mod_install.plan_mod_install([entry.file], [outside.parent])
    monkeypatch.setattr(mod_install, "plan_mod_install", lambda *args: groups)
    before = outside.read_bytes()
    expect_error("game_file_outside_resources", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert outside.read_bytes() == before
    assert not (env.root / "originals").exists()


def test_symlink_destination_cannot_escape_resources(setup_library, monkeypatch):
    env = setup_library
    outside = game_bundle(env.tmp / "outside")
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    groups = mod_install.plan_mod_install([entry.file], [env.game_dir])
    env.original.unlink()
    env.original.symlink_to(outside)
    monkeypatch.setattr(mod_install, "plan_mod_install", lambda *args: groups)
    monkeypatch.setattr(env.library, "_game_files", lambda *args: [env.original])
    expect_error("game_file_outside_resources", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert env.original.is_symlink()
    assert not (env.root / "originals").exists()


def test_read_only_files_fail_cleanly(setup_library):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    before = env.original.read_bytes()
    env.original.chmod(0o444)
    try:
        expect_error("game_file_locked", lambda: env.library.apply("test", f"mod:{entry.id}"))
    finally:
        env.original.chmod(0o644)
    assert env.original.read_bytes() == before


def test_running_game_blocks_replacement(setup_library, monkeypatch):
    # outside dev mode (devmode): inside BAMT_DEV_WRITABLE a game folder is written without the game check
    monkeypatch.delenv("BAMT_DEV_ROOTS", raising=False)
    monkeypatch.delenv("BAMT_DEV_WRITABLE", raising=False)
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    def running():
        raise ServiceError("game_running")
    monkeypatch.setattr(safety, "check_game_not_running", running)
    expect_error("game_running", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert env.library.state("test").applied == "official"


def test_detects_game_process(monkeypatch):
    # the process list readers have their own tests in test_safety.py
    monkeypatch.setattr(safety, "game_processes", lambda: ["/game/BlueArchive.exe"])
    expect_error("game_running", safety.check_game_not_running)


def test_posix_advisory_lock_is_reported(setup_library):
    if os.name == "nt":
        pytest.skip("POSIX advisory lock test")
    import fcntl
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    with env.original.open("rb") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        expect_error("game_file_locked", lambda: env.library.apply("test", f"mod:{entry.id}"))


def test_target_mismatch_and_missing_targets(setup_library):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    expect_error("mod_target_mismatch", lambda: env.library.apply("other", f"mod:{entry.id}"))
    expect_error("variant_not_found", lambda: env.library.state("missing"))
    expect_error("source_unsupported", lambda: env.library.apply("test", "bad"))
    env.original.unlink()
    expect_error("game_file_not_found", lambda: env.library.apply("test", f"mod:{entry.id}"))


@pytest.mark.parametrize("kind", ["spr", "lobby"])
def test_mod_apply_and_restore_are_isolated_by_kind(setup_library, kind):
    env = setup_library
    lobby = game_bundle(env.game_dir, "test_home_gl", payload=b"lobby")
    originals = {path: path.read_bytes() for path in (env.original, lobby)}
    entries = env.library.add([make_mod(env.original, env.tmp / "input", payload=b"portrait mod"),
                               make_mod(lobby, env.tmp / "input", payload=b"lobby mod")])
    mods = {entry.kind: entry for entry in entries}
    selected, other = (env.original, lobby) if kind == "spr" else (lobby, env.original)
    other_kind = "lobby" if kind == "spr" else "spr"
    env.library.apply("test", f"mod:{mods[other_kind].id}", kind=other_kind)
    before = other.read_bytes()
    expect_error("mod_target_mismatch", lambda:
                 env.library.apply("test", f"mod:{mods[other_kind].id}", kind=kind))
    env.library.apply("test", f"mod:{mods[kind].id}", kind=kind)
    assert selected.read_bytes() == mods[kind].file.read_bytes()
    assert other.read_bytes() == before
    env.library.restore("test", kind=kind)
    assert selected.read_bytes() == originals[selected]
    assert other.read_bytes() == before
    env.library.apply("test", f"mod:{mods[kind].id}", kind=kind)
    env.library.apply("test", "official", kind=kind)
    assert selected.read_bytes() == originals[selected]
    assert other.read_bytes() == before


@pytest.mark.parametrize("kind", ["spr", "lobby", None])
def test_variant_apply_and_restore_select_kinds(setup_library, monkeypatch, kind):
    env = setup_library
    lobby = game_bundle(env.game_dir, "test_home_gl", payload=b"lobby")
    game_bundle(env.game_dir, "other_spr", payload=b"other portrait")
    game_bundle(env.game_dir, "other_home", payload=b"other lobby")
    env.catalog.variants["other"].lobby = "other_home"
    originals = {path: path.read_bytes() for path in (env.original, lobby)}
    for path, current in ((env.original, "spr"), (lobby, "lobby")):
        entry, = env.library.add([make_mod(path, env.tmp / "input", payload=current.encode())])
        env.library.apply("test", f"mod:{entry.id}", kind=current)
    before = {path: path.read_bytes() for path in originals}
    monkeypatch.setattr("ba_modding_toolkit.library.service.adapt_variant_sources",
                        lambda sources, *args: sources)
    calls = []
    def update(sources, targets, output, *args, **kwargs):
        calls.extend(target.name for target in targets)
        pairs = []
        for target in targets:
            assert target.read_bytes() == originals[env.game_dir / target.name]
            result = output / target.name
            result.write_bytes(sources[0].read_bytes())
            pairs.append(FilePair(result, target))
        return ModUpdateResult(True, "updated", pairs)
    monkeypatch.setattr(core, "process_mod_update", update)
    selected = {path for path in originals if kind is None or (path == env.original) == (kind == "spr")}
    result = env.library.apply("test", "variant:other", kind=kind)
    assert set(result.files) == selected
    assert set(calls) == {path.name for path in selected}
    assert all(path.read_bytes() == before[path] for path in originals.keys() - selected)
    restored = env.library.restore("test", kind=kind)
    assert set(restored.files) == selected
    assert all(path.read_bytes() == originals[path] for path in selected)
    assert all(path.read_bytes() == before[path] for path in originals.keys() - selected)


def test_default_portrait_choices_ignore_unavailable_lobby_originals(setup_library, monkeypatch):
    env = setup_library
    lobby = game_bundle(env.game_dir, "test_home_gl", payload=b"lobby")
    other_lobby = game_bundle(env.game_dir, "other_home", payload=b"other lobby")
    game_bundle(env.game_dir, "other_spr", payload=b"other portrait")
    env.catalog.variants["other"].lobby = "other_home"
    # Classic installs can leave a modified lobby without a retained original.
    for path in (lobby, other_lobby):
        path.write_bytes(header_bundle(b"external lobby mod"))
    untouched = {path: path.read_bytes() for path in (lobby, other_lobby)}
    original = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    env.library.restore("test")
    assert env.original.read_bytes() == original
    env.library.apply("test", f"mod:{entry.id}")
    env.library.apply("test", "official")
    assert env.original.read_bytes() == original
    monkeypatch.setattr("ba_modding_toolkit.library.service.adapt_variant_sources",
                        lambda sources, *args: sources)
    def update(sources, targets, output, *args, **kwargs):
        result = output / targets[0].name
        result.write_bytes(header_bundle(b"adapted portrait"))
        return ModUpdateResult(True, "updated", [FilePair(result, targets[0])])
    monkeypatch.setattr(core, "process_mod_update", update)
    env.library.apply("test", "variant:other")
    assert {path: path.read_bytes() for path in untouched} == untouched
    expect_error("original_unavailable", lambda: env.library.restore("test", kind=None))


def test_cross_variant_mod_uses_mod_parts_official_baselines_and_tracks_source(setup_library, monkeypatch):
    env = setup_library
    env.catalog.variants["other"].family = "test"
    target_atlas = game_bundle(env.game_dir, part="002", payload=b"target atlas")
    source_atlas = game_bundle(env.game_dir, "other_spr", part="002", payload=b"source atlas")
    source_texture = game_bundle(env.game_dir, "other_spr", payload=b"source texture")
    official = {path: path.read_bytes() for path in (target_atlas, env.original, source_atlas, source_texture)}
    source_mod, = env.library.add([make_mod(source_texture, env.tmp / "source", payload=b"selected mod")])
    # Both variants already wear different mods. Neither current game payload
    # may become the baseline for this transplant.
    for key, path in (("test", target_atlas), ("other", source_atlas)):
        entry, = env.library.add([make_mod(path, env.tmp / "old", payload=b"stale atlas")])
        env.library.apply(key, f"mod:{entry.id}")
    source_before = {path: path.read_bytes() for path in (source_atlas, source_texture)}
    calls = []
    def adapt(sources, targets, *args):
        assert sources == [env.root / "originals" / source_atlas.name, source_mod.file]
        assert [path.read_bytes() for path in sources] == [official[source_atlas], source_mod.file.read_bytes()]
        assert {path.name: path.read_bytes() for path in targets} == {
            path.name: official[path] for path in (target_atlas, env.original)}
        return sources
    def update(sources, targets, output, *args, **kwargs):
        calls.append(kwargs)
        target = next(path for path in targets if path.name == env.original.name)
        result = output / target.name
        result.write_bytes(header_bundle(b"adapted selected mod"))
        return ModUpdateResult(True, "updated", [FilePair(result, target)])
    monkeypatch.setattr("ba_modding_toolkit.library.service.adapt_variant_sources", adapt)
    monkeypatch.setattr(core, "process_mod_update", update)
    result = env.library.apply("test", f"mod:{source_mod.id}")
    assert set(result.files) == {target_atlas, env.original}
    assert target_atlas.read_bytes() == official[target_atlas]
    assert env.original.read_bytes() == header_bundle(b"adapted selected mod")
    assert calls[0]["match_strategy"] == "name_type" and calls[0]["skip_unchanged"] is True
    assert reload_library(env).state("test").applied == f"mod:{source_mod.id}"
    assert {path: path.read_bytes() for path in source_before} == source_before
    env.library.restore("test")
    assert all(path.read_bytes() == official[path] for path in (target_atlas, env.original))


def test_cross_variant_mod_rejects_other_kind_and_missing_targets(setup_library):
    env = setup_library
    env.catalog.variants["other"].family = "test"
    lobby = game_bundle(env.game_dir, "test_home_gl", payload=b"lobby")
    entry, = env.library.add([make_mod(lobby, env.tmp / "input")])
    expect_error("mod_target_mismatch", lambda: env.library.apply("other", f"mod:{entry.id}"))
    expect_error("game_file_not_found", lambda: env.library.apply("other", f"mod:{entry.id}", kind="lobby"))


def test_variant_swap_uses_official_source_and_keeps_target_original(setup_library, monkeypatch):
    env = setup_library
    other = game_bundle(env.game_dir, "other_spr", payload=b"variant!")
    entry = env.library.add([make_mod(other, env.tmp / "input")])[0]
    env.library.apply("other", f"mod:{entry.id}")
    calls = []
    monkeypatch.setattr("ba_modding_toolkit.library.service.adapt_variant_sources",
                        lambda sources, *args: sources)
    def update(sources, targets, output, *args, **kwargs):
        calls.append((sources, targets, kwargs))
        result = output / targets[0].name
        result.write_bytes(header_bundle(b"variant!"))
        return ModUpdateResult(True, "updated", [FilePair(result, targets[0])])
    monkeypatch.setattr(core, "process_mod_update", update)
    original_bytes = env.original.read_bytes()
    result = env.library.apply("test", "variant:other")
    assert result.files == [env.original]
    assert calls[0][0] == [env.root / "originals" / other.name]
    assert calls[0][2]["match_strategy"] == "name_type"
    assert env.library.state("test").applied == "variant:other"
    env.library.restore("test")
    assert env.original.read_bytes() == original_bytes


@pytest.mark.parametrize("core_name", ["other_spr", "test_home_gl"])
def test_official_preview_uses_kept_parts_while_a_mod_remains_in_game(setup_library, core_name):
    env = setup_library
    source = game_bundle(env.game_dir, core_name, payload=b"official source")
    official = source.read_bytes()
    entry, = env.library.add([make_mod(source, env.tmp / "input")])
    kind = "spr" if core_name.endswith("_spr") else "lobby"
    env.library.apply(entry.target, f"mod:{entry.id}", kind=kind)
    live = source.read_bytes()
    bundles = env.library.official_bundles(core_name)
    assert bundles == [env.root / "originals" / source.name]
    assert bundles[0].read_bytes() == official
    assert source.read_bytes() == live != official
    expect_error("game_file_not_found", lambda: env.library.official_bundles("missing_spr"))


@pytest.mark.parametrize("source_type", ["variant", "mod"])
def test_variant_swap_rejects_incompatible_texture_page_counts(setup_library, monkeypatch, source_type):
    env = setup_library
    env.catalog.variants["other"].family = "test"
    other = game_bundle(env.game_dir, "other_spr", payload=b"variant!")
    entry, = env.library.add([make_mod(other, env.tmp / "input")])
    def load(path, *args, **kwargs):
        objects = [fake_asset("page", "Texture2D", b"data")]
        if path.name != other.name:
            objects.append(fake_asset("page2", "Texture2D", b"data"))
        return SimpleNamespace(env=SimpleNamespace(objects=objects))
    monkeypatch.setattr(Bundle, "load", load)
    before = {path: path.read_bytes() for path in (env.original, other)}
    source = "variant:other" if source_type == "variant" else f"mod:{entry.id}"
    expect_error("variant_incompatible", lambda: env.library.apply("test", source))
    assert {path: path.read_bytes() for path in before} == before
    assert not (env.root / "originals").exists()


@pytest.mark.parametrize("legacy", [False, True])
def test_update_uses_official_baseline_preserves_previous_and_reports_unchanged(setup_library, monkeypatch, legacy):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    if legacy:
        env.library._records[entry.id].pop("user_added")
        env.library._save()
        env.library = reload_library(env)
        entry, = env.library.mods()
        assert not entry.user_added, "legacy records must not acquire a new-mod dot during repair"
    old_bytes = entry.file.read_bytes()
    env.library.apply("test", f"mod:{entry.id}")
    calls = []
    def update(sources, targets, output, *args, **kwargs):
        calls.append(targets)
        result = output / targets[0].name
        result.write_bytes(header_bundle(b"updated!"))
        return ModUpdateResult(True, "updated", [FilePair(result, targets[0])])
    monkeypatch.setattr(core, "process_mod_update", update)
    progress = []
    result = env.library.update(entry.id, progress=lambda *args: progress.append(args))
    assert progress == [(1, 1, service.t("webui.progress.repair", name=env.original.name))]
    assert result.unchanged is False
    assert result.previous[0].read_bytes() == old_bytes
    assert result.previous[0].is_relative_to(entry.file.parent / "previous")
    assert result.mod.file.read_bytes() == header_bundle(b"updated!")
    assert result.mod.id == entry.id and result.mod.user_added == entry.user_added
    assert calls == [[env.root / "originals" / env.original.name]]
    assert reload_library(env).mods()[0] == result.mod
    assert env.library.update(entry.id).unchanged
    monkeypatch.setattr(core, "process_mod_update", lambda *args, **kwargs:
                        ModUpdateResult(True, "all_targets_unchanged", []))
    assert env.library.update(entry.id).unchanged
    json.dumps(result.to_json())


def test_update_can_split_an_old_mod_into_current_bundle_parts(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    old_bytes = entry.file.read_bytes()
    env.original.unlink()
    targets = [game_bundle(env.game_dir, part=part, date="2026-10-01", payload=part.encode())
               for part in ("002", "003")]
    original_bytes = {target: target.read_bytes() for target in targets}
    monkeypatch.setattr(mod_install, "_asset_match", lambda sources, candidates, log: (candidates, ""))
    def update(sources, current, output, *args, **kwargs):
        result = output / current[0].name
        result.write_bytes(header_bundle(b"split mod " + parse_filename(current[0].name).res_type.encode()))
        return ModUpdateResult(True, "updated", [FilePair(result, current[0])])
    monkeypatch.setattr(core, "process_mod_update", update)
    result = env.library.update(entry.id)
    assert len(result.files) == 2 and len(result.previous) == 1
    assert result.previous[0].read_bytes() == old_bytes
    assert not entry.file.exists()
    assert result.mod.id == entry.id and result.mod.date == "2026-10-01"
    library = reload_library(env)
    library.apply("test", f"mod:{entry.id}")
    assert all(file.applied == f"mod:{entry.id}" for file in library.state("test").files)
    library.restore("test")
    assert {target: target.read_bytes() for target in targets} == original_bytes


def test_failed_rebuild_keeps_mod_and_game_bytes(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    mod_bytes, game_bytes = entry.file.read_bytes(), env.original.read_bytes()
    monkeypatch.setattr(core, "process_mod_update", lambda *args, **kwargs:
                        ModUpdateResult(False, "failed", []))
    expect_error("mod_update_failed", lambda: env.library.update(entry.id))
    assert entry.file.read_bytes() == mod_bytes
    assert env.original.read_bytes() == game_bytes
    assert not (entry.file.parent / "previous").exists()


def test_failed_install_preparation_keeps_game_and_originals(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    game_bytes = env.original.read_bytes()
    monkeypatch.setattr(mod_install, "execute_mod_install", lambda *args, **kwargs:
                        mod_install.InstallResult(failed_groups=[("test_spr", "failed")]))
    expect_error("mod_apply_failed", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert env.original.read_bytes() == game_bytes
    assert not (env.root / "originals").exists()


def test_extract_uses_core_and_returns_core_folder(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    calls = []
    def extract(paths, output, **kwargs):
        calls.append(paths)
        (output / "test.atlas").write_bytes(b"atlas")
        return True, "done"
    monkeypatch.setattr(core, "process_asset_extraction", extract)
    folder = env.library.extract(f"mod:{entry.id}", env.tmp / "extracted")
    assert folder == env.tmp / "extracted" / "test_spr"
    assert (folder / "test.atlas").read_bytes() == b"atlas"
    env.library.extract("variant:test", env.tmp / "extracted")
    assert calls == [[entry.file], [env.original]]


def fake_asset(name, type_name, raw):
    return SimpleNamespace(type=getattr(AssetType, type_name), peek_name=lambda: name,
                           get_raw_data=lambda: raw, read=lambda: SimpleNamespace(m_StreamData=None))


def test_compare_raw_asset_statuses_and_official_baseline(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    env.library.apply("test", f"mod:{entry.id}")
    official = [fake_asset("changed", "Texture2D", b"old"), fake_asset("same", "TextAsset", b"same"),
                fake_asset("removed", "Mesh", b"removed")]
    modified = [fake_asset("changed", "Texture2D", b"new texture"), fake_asset("same", "TextAsset", b"same"),
                fake_asset("added", "AnimationClip", b"added")]
    loaded = []
    def load(path, *args, **kwargs):
        loaded.append(path)
        return SimpleNamespace(env=SimpleNamespace(objects=modified if path == entry.file else official))
    monkeypatch.setattr(Bundle, "load", load)
    result = env.library.compare(entry.id)
    assert {asset.name: asset.status for asset in result.assets} == {
        "changed": "changed", "same": "same", "removed": "removed", "added": "added"}
    changed = next(asset for asset in result.assets if asset.name == "changed")
    assert (changed.official_size, changed.mod_size) == (3, 11)
    assert loaded == [entry.file, env.root / "originals" / env.original.name]
    json.dumps(result.to_json())


def test_compare_detects_changes_in_streamed_payloads(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    def load(path, *args, **kwargs):
        obj = fake_asset("streamed", "Texture2D", b"same serialized metadata")
        obj.assets_file = path
        obj.read = lambda: SimpleNamespace(m_StreamData=SimpleNamespace(path="image.resS", offset=0, size=3))
        return SimpleNamespace(env=SimpleNamespace(objects=[obj]))
    monkeypatch.setattr(Bundle, "load", load)
    monkeypatch.setattr("ba_modding_toolkit.library.service.get_resource_data",
                        lambda _, path, *args: b"new" if path == entry.file else b"old")
    result = env.library.compare(entry.id)
    assert len(result.assets) == 1 and result.assets[0].status == "changed"
    assert result.assets[0].mod_size == len(b"same serialized metadata") + 3


def test_add_is_thread_safe_and_deduplicates_concurrent_calls(setup_library):
    env = setup_library
    mod = make_mod(env.original, env.tmp / "input")
    with ThreadPoolExecutor(max_workers=6) as pool:
        added = list(pool.map(lambda _: env.library.add([mod]), range(12)))
    assert sum(len(entries) for entries in added) == 1
    assert len(reload_library(env).mods()) == 1


# --- switching keeps what it replaces: official files in originals/ until verified official again, mods in mods/ ---

def kept_copy(env, path):
    return env.root / "originals" / path.name


def swap_by_copying(monkeypatch, payload=b"adapted"):
    """Variant swaps and cross-variant mods without UnityPy: the adapted result is a fixed payload."""
    monkeypatch.setattr("ba_modding_toolkit.library.service.adapt_variant_sources", lambda sources, *args: sources)
    def update(sources, targets, output, *args, **kwargs):
        result = output / targets[0].name
        result.write_bytes(header_bundle(payload))
        return ModUpdateResult(True, "updated", [FilePair(result, targets[0])])
    monkeypatch.setattr(core, "process_mod_update", update)


@pytest.mark.parametrize("kind", ["spr", "lobby"])
def test_switching_keeps_the_official_file_until_it_is_restored(setup_library, kind):
    env = setup_library
    lobby = game_bundle(env.game_dir, "test_home_gl", payload=b"lobby")
    target, other = (env.original, lobby) if kind == "spr" else (lobby, env.original)
    official = target.read_bytes()
    first, = env.library.add([make_mod(target, env.tmp / "first", payload=b"first mod")])
    second, = env.library.add([make_mod(target, env.tmp / "second", payload=b"second mod")])
    backup = kept_copy(env, target)
    env.library.apply("test", f"mod:{first.id}", kind=kind)
    assert target.read_bytes() == first.file.read_bytes() and backup.read_bytes() == official
    # a mod over a mod: the official copy stays as it is and the replaced mod stays in the library
    env.library.apply("test", f"mod:{second.id}", kind=kind)
    assert target.read_bytes() == second.file.read_bytes() and backup.read_bytes() == official
    assert first.file.read_bytes() == header_bundle(b"first mod")
    assert not kept_copy(env, other).exists()
    env.library.apply("test", "official", kind=kind)
    assert target.read_bytes() == official and not backup.exists()
    # switched again: kept again, from the verified game file
    env.library.apply("test", f"mod:{first.id}", kind=kind)
    assert backup.read_bytes() == official
    env.library.restore("test", kind=kind)
    assert target.read_bytes() == official and not any((env.root / "originals").iterdir())
    assert [entry.id for entry in env.library.mods()] == [first.id, second.id]
    assert reload_library(env).state("test").backup is False


def test_parts_reset_to_official_release_their_kept_copies(setup_library):
    env = setup_library
    atlas = game_bundle(env.game_dir, part="002", payload=b"atlas")
    pack, = env.library.add([make_mod(path, env.tmp / "pack", payload=b"pack " + path.name.encode())
                             for path in (atlas, env.original)])
    partial, = env.library.add([make_mod(env.original, env.tmp / "partial", payload=b"texture only")])
    env.library.apply("test", f"mod:{pack.id}")
    assert kept_copy(env, atlas).exists() and kept_copy(env, env.original).exists()
    env.library.apply("test", f"mod:{partial.id}")
    assert env.library._is_official(atlas) and not kept_copy(env, atlas).exists()
    assert kept_copy(env, env.original).exists()


def test_variant_swap_keeps_and_releases_only_the_target_copy(setup_library, monkeypatch):
    env = setup_library
    other = game_bundle(env.game_dir, "other_spr", payload=b"variant!")
    entry, = env.library.add([make_mod(other, env.tmp / "input")])
    env.library.apply("other", f"mod:{entry.id}")
    swap_by_copying(monkeypatch)
    official = env.original.read_bytes()
    env.library.apply("test", "variant:other")
    assert kept_copy(env, env.original).read_bytes() == official
    env.library.restore("test")
    assert env.original.read_bytes() == official and not kept_copy(env, env.original).exists()
    # the other variant still wears its mod: its official copy stays
    assert kept_copy(env, other).exists()


def test_cross_variant_mod_keeps_and_releases_the_target_copy(setup_library, monkeypatch):
    env = setup_library
    env.catalog.variants["other"].family = "test"
    other = game_bundle(env.game_dir, "other_spr", payload=b"other portrait")
    entry, = env.library.add([make_mod(other, env.tmp / "input")])
    swap_by_copying(monkeypatch)
    official = env.original.read_bytes()
    env.library.apply("test", f"mod:{entry.id}")
    assert kept_copy(env, env.original).read_bytes() == official
    assert not kept_copy(env, other).exists()  # the source variant's game file is only read
    env.library.restore("test")
    assert not kept_copy(env, env.original).exists()


def test_prune_releases_copies_of_files_verified_official_outside_the_library(setup_library):
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    backup = kept_copy(env, env.original)
    assert env.library.prune() == [] and backup.exists()  # the game shows the mod
    env.original.write_bytes(header_bundle(b"from another tool"))
    assert env.library.prune() == [] and backup.exists()  # changed again, still not official
    env.original.write_bytes(official)  # the launcher verified the game files
    library = reload_library(env)
    # by stat alone a file verified outside the library is not known official, and the entry is configured
    assert library.prune() == [] and backup.exists()
    # a restore that finds it official writes nothing, records it and releases the copy
    assert library.restore("test").unchanged
    assert not backup.exists()
    assert library.state("test").applied == "official"


def test_prune_deletes_copies_of_files_a_game_update_replaced(setup_library):
    env = setup_library
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    backup = kept_copy(env, env.original)
    # a game update: the part comes back official under a new date and CRC, the old file is gone
    env.original.unlink()
    updated = game_bundle(env.game_dir, date="2026-02-01", payload=b"updated official")
    library = reload_library(env)
    assert library.prune() == [backup] and not backup.exists()
    assert str(env.original) not in json.loads((env.root / "state.json").read_text())["applied"]
    assert library.state("test").applied == "official"
    assert [m.id for m in library.mods()] == [entry.id]
    # a mod for the new file is switched and the new official file is kept under its own name
    current, = library.add([make_mod(updated, env.tmp / "current", payload=b"current mod")])
    library.apply("test", f"mod:{current.id}")
    assert kept_copy(env, updated).exists()


def test_prune_keeps_a_copy_an_older_official_file_does_not_replace(setup_library):
    env = setup_library
    older = env.original.read_bytes()
    env.original.unlink()
    newer = game_bundle(env.game_dir, date="2026-02-01", payload=b"newer official")
    entry, = env.library.add([make_mod(newer, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    backup = kept_copy(env, newer)
    # the newer file is gone and an older official file of the same part is back (an old copy of the folder put back)
    newer.unlink()
    env.original.write_bytes(older)
    library = reload_library(env)
    assert library.prune() == [] and backup.read_bytes() == header_bundle(b"newer official")


@pytest.mark.parametrize("case", ["modded", "missing", "unrecorded", "other_install"])
def test_prune_keeps_copies_it_cannot_verify(setup_library, case):
    env = setup_library
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    backup = kept_copy(env, env.original)
    env.original.unlink()
    if case != "missing":
        updated = game_bundle(env.game_dir, date="2026-02-01", payload=b"updated official")
        if case == "modded":
            updated.write_bytes(header_bundle(b"modded again elsewhere"))
    if case == "unrecorded":
        data = json.loads((env.root / "state.json").read_text())
        data["applied"] = {}
        (env.root / "state.json").write_text(json.dumps(data))
    if case == "other_install":
        other_game = env.tmp / "other_game"
        game_bundle(other_game, "other_spr")
        env.settings.set("game_resource_dir", str(other_game))
    library = reload_library(env)
    if case in ("modded", "other_install"):
        # a successor counts by its name and date (a modded one is the scan's concern), and the first folder stays
        # a known install by its record
        assert library.prune() == [backup] and not backup.exists()
    else:  # no successor, or no record placing the old file: it may be the only copy for a folder not seen
        assert library.prune() == [] and backup.exists()


@pytest.mark.parametrize("clone_unavailable", [False, True])
def test_a_copy_shared_by_two_installs_is_kept_until_both_are_official(setup_library, monkeypatch,
                                                                   clone_unavailable):
    if clone_unavailable:
        monkeypatch.setattr(storage, "_clone", lambda *args: False)
    env = setup_library
    official = env.original.read_bytes()
    second = env.tmp / "second_game" / env.original.name
    second.parent.mkdir()
    second.write_bytes(official)
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    env.settings.set("game_resource_dir", str(second.parent))
    env.library.apply("test", f"mod:{entry.id}")
    backup = kept_copy(env, env.original)
    env.library.restore("test")
    # the first install still wears the mod and needs the same copy
    assert second.read_bytes() == official and backup.read_bytes() == official
    assert env.library.prune() == [] and backup.exists()
    env.settings.set("game_resource_dir", str(env.game_dir))
    env.library.restore("test")
    assert env.original.read_bytes() == official and not backup.exists()


def second_install(env, subfolder=""):
    """Another game folder sharing the library, holding the same official file as the first; returns that file."""
    folder = env.tmp / "second_game"
    path = folder / subfolder / env.original.name
    path.parent.mkdir(parents=True)
    path.write_bytes(env.original.read_bytes())
    return path


def use_install(env, game_file):
    env.settings.set("game_resource_dir", str(game_file.parent))


def test_a_moved_install_releases_its_copy_once_restored(setup_library):
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    backup = kept_copy(env, env.original)
    # the install's files move to another folder; the old folder stays behind without them
    moved = env.tmp / "moved_game" / env.original.name
    moved.parent.mkdir()
    shutil.move(env.original, moved)
    use_install(env, moved)
    env.library.restore("test")
    # the old folder's record no longer describes a file: nothing there needs the copy
    assert moved.read_bytes() == official and not backup.exists()
    assert [m.id for m in env.library.mods()] == [entry.id]  # the moved mod is in the library already


def test_a_copy_is_released_when_another_folder_was_verified_in_its_launcher(setup_library):
    env = setup_library
    official = env.original.read_bytes()
    second = second_install(env)
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    env.original.write_bytes(official)  # the first install's launcher verified its files
    use_install(env, second)
    env.library.apply("test", f"mod:{entry.id}")
    backup = kept_copy(env, env.original)
    assert backup.read_bytes() == official
    env.library.restore("test")
    # the first install's file was verified outside the library: by stat it may still need the copy
    assert second.read_bytes() == official and backup.exists()
    use_install(env, env.original)
    env.library.restore("test")
    assert not backup.exists()


@pytest.mark.parametrize("clone_unavailable", [False, True])
def test_a_copy_is_kept_while_another_folder_cannot_be_seen(setup_library, monkeypatch, clone_unavailable):
    if clone_unavailable:
        monkeypatch.setattr(storage, "_clone", lambda *args: False)
    env = setup_library
    official = env.original.read_bytes()
    second = second_install(env)
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    use_install(env, second)
    env.library.apply("test", f"mod:{entry.id}")
    unmounted = env.tmp / "unmounted"
    shutil.move(env.game_dir, unmounted)  # the first install's drive is unmounted
    env.library.restore("test")
    backup = kept_copy(env, env.original)
    assert second.read_bytes() == official and backup.read_bytes() == official
    assert env.library.prune() == [] and backup.exists()
    # mounted again and restored there too: the copy goes
    shutil.move(unmounted, env.game_dir)
    use_install(env, env.original)
    env.library.restore("test")
    assert env.original.read_bytes() == official and not backup.exists()


def test_a_copy_is_kept_while_another_folder_is_modded_outside_the_library(setup_library):
    env = setup_library
    official = env.original.read_bytes()
    second = second_install(env)
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    external = header_bundle(b"from another tool")
    env.original.write_bytes(external)  # the first install changed outside the library since
    use_install(env, second)
    env.library.apply("test", f"mod:{entry.id}")
    env.library.restore("test")
    backup = kept_copy(env, env.original)
    assert second.read_bytes() == official and backup.read_bytes() == official
    # the copy is what lets the first install switch back: its file is kept as a mod, the copy restored
    use_install(env, env.original)
    env.library.restore("test")
    assert env.original.read_bytes() == official and not backup.exists()
    kept, = [m for m in env.library.mods() if m.id != entry.id]
    assert kept.file.read_bytes() == external


def test_prune_deletes_an_outdated_copy_another_folder_no_longer_needs(setup_library):
    env = setup_library
    official = env.original.read_bytes()
    second = second_install(env)
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    use_install(env, second)
    env.library.apply("test", f"mod:{entry.id}")
    second.write_bytes(official)  # the second install's launcher verified its files
    use_install(env, env.original)
    # a game update in the first install
    env.original.unlink()
    game_bundle(env.game_dir, date="2026-02-01", payload=b"updated official")
    backup = kept_copy(env, env.original)
    library = reload_library(env)
    # the second install still holds the name, verified outside the library
    assert library.prune() == [] and backup.exists()
    use_install(env, second)
    library.restore("test")
    assert not backup.exists()
    # the first install's gone record went with the copy, leaving the entry's updated marker
    assert str(env.original) not in json.loads((env.root / "state.json").read_text())["applied"]
    profiles = json.loads((env.root / "profiles.json").read_text())
    assert "test_spr" in profiles["folders"][str(env.game_dir.resolve())]["updated"]


def test_deleting_an_applied_mod_restores_official(setup_library):
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    assert env.library.removal_info(entry.id) == {"name": entry.label, "used": True}
    result = env.library.remove(entry.id)
    assert result.failed == [] and result.done
    assert env.original.read_bytes() == official
    assert not entry.file.exists() and reload_library(env).mods() == []
    assert env.library.configured("test")["spr"] is None


def test_deleting_a_mod_restores_every_game_folder(setup_library):
    env = setup_library
    official = env.original.read_bytes()
    second = second_install(env, "GameData/Windows")
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.settings.set("game_resource_dir", str(env.tmp / "second_game"))
    env.library.apply("test", f"mod:{entry.id}")
    use_install(env, env.original)
    env.library.apply("test", f"mod:{entry.id}")
    result = env.library.remove(entry.id)
    assert len(result.done) == 2 and result.failed == []
    assert second.read_bytes() == env.original.read_bytes() == official
    assert env.library.mods() == []


def test_a_mod_whose_changed_part_is_official_again_can_be_removed(setup_library):
    env = setup_library
    game_bundle(env.game_dir, part="002", payload=b"skeleton")
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    # a launcher check writes the official bytes back to the part the mod changed
    env.original.write_bytes(official)
    library = reload_library(env)
    library.remove(entry.id)
    assert library.mods() == []
    # the untouched official part, still recorded under the removed mod, is not kept as a mod by the next switch
    other, = library.add([make_mod(env.original, env.tmp / "next", payload=b"next mod")])
    library.apply("test", f"mod:{other.id}")
    assert [m.id for m in library.mods()] == [other.id]


@pytest.mark.parametrize("language", ["en-US", "zh-CN"])
def test_the_in_use_refusals_have_their_messages(language):
    locales = Path(core.__file__).parent / "locales"
    errors = json.loads((locales / f"{language}.json").read_text(encoding="utf-8"))["webui"]["error"]
    assert errors["mod_in_use"] and "{folder}" in errors["mod_in_use_elsewhere"]


def test_deleting_a_mod_restores_an_adapted_variant(setup_library, monkeypatch):
    env = setup_library
    env.catalog.variants["other"].family = "test"
    other = game_bundle(env.game_dir, "other_spr", payload=b"other portrait")
    entry, = env.library.add([make_mod(other, env.tmp / "input")])
    swap_by_copying(monkeypatch)
    env.library.apply("test", f"mod:{entry.id}")
    assert env.library.remove(entry.id).failed == []
    assert env.library.state("test").applied == "official"
    assert env.library.mods() == []


def test_switching_keeps_a_file_changed_outside_the_library_as_a_mod(setup_library):
    env = setup_library
    official = env.original.read_bytes()
    first, = env.library.add([make_mod(env.original, env.tmp / "first")])
    env.library.apply("test", f"mod:{first.id}")
    external = header_bundle(b"from another tool")
    env.original.write_bytes(external)
    assert env.library.state("test").applied == "unknown"
    env.library.apply("test", "official")
    assert env.original.read_bytes() == official and not kept_copy(env, env.original).exists()
    kept, = [entry for entry in env.library.mods() if entry.id != first.id]
    assert kept.file.name == env.original.name and kept.file.read_bytes() == external
    assert (kept.kind, kept.target, kept.fresh) == ("spr", "test", True)
    assert not kept.user_added
    assert [m.id for m in reload_library(env).mods()] == [first.id, kept.id]
    # switching back puts it in the game again
    env.library.apply("test", f"mod:{kept.id}")
    assert env.original.read_bytes() == external
    assert env.library.state("test").applied == f"mod:{kept.id}"


def test_switching_keeps_an_applied_mod_missing_from_the_library(setup_library):
    env = setup_library
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    installed = env.original.read_bytes()
    # removed from the library before removing an applied mod was refused
    data = json.loads((env.root / "state.json").read_text())
    data["mods"] = []
    (env.root / "state.json").write_text(json.dumps(data))
    shutil.rmtree(env.root / "mods" / entry.id)
    library = reload_library(env)
    # the bytes of a mod the library no longer has are offered for adoption
    assert library.state("test").applied == "unknown"
    library.restore("test")
    kept, = library.mods()
    assert kept.file.read_bytes() == installed and kept.id != entry.id


def test_a_replaced_file_already_in_the_library_is_not_stored_twice(setup_library):
    env = setup_library
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    env.library.apply("test", f"mod:{entry.id}")
    data = json.loads((env.root / "state.json").read_text())
    data["applied"] = {}
    (env.root / "state.json").write_text(json.dumps(data))
    library = reload_library(env)
    assert library.state("test").applied == "official"  # judged cheaply; the restore judges in full
    library.restore("test")
    assert [m.id for m in library.mods()] == [entry.id]


def test_kept_mods_are_dropped_when_the_switch_is_rolled_back(setup_library, monkeypatch):
    env = setup_library
    first, = env.library.add([make_mod(env.original, env.tmp / "first")])
    second, = env.library.add([make_mod(env.original, env.tmp / "second", payload=b"second!!")])
    env.library.apply("test", f"mod:{first.id}")
    external = header_bundle(b"from another tool")
    env.original.write_bytes(external)
    from ba_modding_toolkit.library import service
    original_copy = service.atomic_copy
    def copy(source, target):
        if target == env.original:
            assert len(env.library.mods()) == 3  # kept before the game file is written
            raise PermissionError(13, "Write failure", str(target))
        original_copy(source, target)
    monkeypatch.setattr(service, "atomic_copy", copy)
    expect_error("game_file_locked", lambda: env.library.apply("test", f"mod:{second.id}"))
    assert env.original.read_bytes() == external
    assert [m.id for m in env.library.mods()] == [first.id, second.id]
    assert [m.id for m in reload_library(env).mods()] == [first.id, second.id]
    assert sorted(path.name for path in (env.root / "mods").iterdir()) == sorted([first.id, second.id])
    assert kept_copy(env, env.original).exists()  # the game file is not official


# the real-install tests run only on an official game folder named by BAMT_TEST_GAME_DIR
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="Blue Archive install unavailable")
def test_integration_real_bundle_add_apply_compare_restore(tmp_path, monkeypatch):
    # This fake game folder is isolated from any running game. Process listing is
    # blocked by some test sandboxes; process detection has separate unit coverage.
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    resources = get_search_dirs(GAME_DIR)
    candidates = [path for directory in resources for path in directory.glob("assets-_mx-spinecharacters-*.bundle")
                  if parse_filename(path.name).core.endswith("_spr")
                  and parse_filename(path.name).res_type in ("003", "textures")]
    selected = None
    for path in sorted(candidates, key=lambda p: p.stat().st_size)[:12]:
        bundle = Bundle.load(path)
        if bundle:
            textures = [obj for obj in bundle.env.objects if obj.type == AssetType.Texture2D]
            if textures:
                selected = path
                break
    if selected is None:
        pytest.skip("No small portrait texture bundle available")
    parsed = parse_filename(selected.name)
    game_dir = tmp_path / "game"
    game_dir.mkdir()
    siblings = [p for directory in resources for p in directory.glob("*.bundle")
                if parse_filename(p.name).core == parsed.core]
    for path in siblings:
        shutil.copyfile(path, game_dir / path.name)
    original = game_dir / selected.name
    original_bytes = original.read_bytes()
    settings = Settings(tmp_path / "config.toml")
    settings.set("game_resource_dir", str(game_dir))
    settings.set("compression_method", "lz4")
    catalog = FakeCatalog(FakeVariant("test", parsed.core))
    library = ModLibrary(tmp_path / "library", catalog, object(), settings)
    loaded = Bundle.load(original)
    texture = next(obj for obj in loaded.env.objects if obj.type == AssetType.Texture2D)
    image = texture.read().image.convert("RGBA")
    Image.new("RGBA", image.size, (255, 0, 255, 255)).save(tmp_path / f"{texture.peek_name()}.png")
    mod_dir = tmp_path / "mod"
    mod_dir.mkdir()
    success, message, pairs = core.process_asset_packing(
        [original], [tmp_path / f"{texture.peek_name()}.png"], mod_dir, settings.save_options(False))
    assert success, message
    entry = library.add([pairs[0].output])[0]
    assert library.state("test").applied == "official"
    events = []
    result = library.apply("test", f"mod:{entry.id}", progress=lambda *args: events.append(args))
    assert result.files == [original] and events
    installed = next(file for file in library.state("test").files if file.file == original)
    assert (installed.applied, installed.crc, installed.original) == (f"mod:{entry.id}", "fixed", True)
    differences = library.compare(entry.id)
    changed = [asset for asset in differences.assets if asset.status == "changed"]
    assert [(asset.name, asset.type) for asset in changed] == [(texture.peek_name(), "Texture2D")]
    assert all(asset.status in ("changed", "same") for asset in differences.assets)
    library.restore("test")
    assert original.read_bytes() == original_bytes
    assert library.state("test").applied == "official"

    # A filename from a previous game release takes the classic UPDATE path.
    library.remove(entry.id)
    old_mod = mod_dir / selected.name.replace(parsed.date, "2000-01-01")
    old_mod.write_bytes(pairs[0].output.read_bytes())
    old_entry = library.add([old_mod])[0]
    updated = library.update(old_entry.id)
    assert updated.unchanged is False and updated.mod.date == parsed.date
    assert updated.previous[0].read_bytes() == old_mod.read_bytes()
    library.apply("test", f"mod:{old_entry.id}")
    assert next(file for file in library.state("test").files if file.file == original).crc == "fixed"
    library.restore("test")
    assert original.read_bytes() == original_bytes


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="Blue Archive install unavailable")
def test_integration_variant_swap_adapts_names_and_atlas_pages(tmp_path, monkeypatch):
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    resources = get_search_dirs(GAME_DIR)
    all_files = [path for directory in resources for path in directory.glob("assets-_mx-spinecharacters-*.bundle")]
    textures = sorted((path for path in all_files if parse_filename(path.name).core.endswith("_spr")
                       and parse_filename(path.name).res_type in ("003", "textures")), key=lambda p: p.stat().st_size)
    cores = []
    for path in textures:
        core_name = parse_filename(path.name).core
        if core_name not in cores:
            cores.append(core_name)
        if len(cores) == 2:
            break
    if len(cores) < 2:
        pytest.skip("Two portrait variants unavailable")
    game_dir = tmp_path / "game"
    game_dir.mkdir()
    for path in all_files:
        if parse_filename(path.name).core in cores:
            shutil.copyfile(path, game_dir / path.name)
    originals = {path: path.read_bytes() for path in game_dir.iterdir()}
    settings = Settings(tmp_path / "config.toml")
    settings.set("game_resource_dir", str(game_dir))
    settings.set("compression_method", "lz4")
    catalog = FakeCatalog(FakeVariant("test", cores[0]), FakeVariant("other", cores[1]))
    library = ModLibrary(tmp_path / "library", catalog, object(), settings)
    result = library.apply("test", "variant:other")
    assert result.files
    def assets(core_name):
        return {obj.type.name: obj.read() for path in game_dir.iterdir()
                if parse_filename(path.name).core == core_name
                for obj in Bundle.load(path).env.objects if obj.type in (AssetType.Texture2D, AssetType.TextAsset)
                and (obj.type == AssetType.Texture2D or obj.peek_name().endswith(".skel"))}
    source_assets, target_assets = assets(cores[1]), assets(cores[0])
    source_image = source_assets["Texture2D"].image.convert("RGBA")
    target_image = target_assets["Texture2D"].image.convert("RGBA")
    assert target_image.size == source_image.size
    # The shared core re-encodes the texture using the target's lossy format.
    rms = ImageStat.Stat(ImageChops.difference(target_image, source_image)).rms
    assert sum(value * value for value in rms) / len(rms) < 20
    assert target_assets["TextAsset"].m_Script == source_assets["TextAsset"].m_Script
    target_texture_name = target_assets["Texture2D"].m_Name
    for path in game_dir.iterdir():
        if parse_filename(path.name).core != cores[0]:
            continue
        for obj in Bundle.load(path).env.objects:
            if obj.type == AssetType.TextAsset and obj.peek_name().endswith(".atlas"):
                assert target_texture_name + ".png" in obj.read().m_Script.splitlines()
    assert all(file.crc == "fixed" and file.applied == "variant:other"
               for file in library.state("test").files if file.file in result.files)
    library.restore("test")
    assert {path: path.read_bytes() for path in game_dir.iterdir()} == originals

    # A partial library mod for the other variant uses the same adaptation,
    # taking its missing skeleton/atlas from the other variant's official parts.
    source_texture = next(path for path in game_dir.iterdir()
                          if parse_filename(path.name).core == cores[1]
                          and parse_filename(path.name).res_type in ("003", "textures"))
    texture = next(obj for obj in Bundle.load(source_texture).env.objects if obj.type == AssetType.Texture2D)
    image_path = tmp_path / f"{texture.peek_name()}.png"
    Image.new("RGBA", texture.read().image.size, (255, 0, 255, 255)).save(image_path)
    mod_dir = tmp_path / "mod"
    mod_dir.mkdir()
    success, message, pairs = core.process_asset_packing(
        [source_texture], [image_path], mod_dir, settings.save_options(False))
    assert success, message
    entry, = library.add([pair.output for pair in pairs])
    mod_image = next(obj.read().image.convert("RGBA") for obj in Bundle.load(entry.file).env.objects
                     if obj.type == AssetType.Texture2D)
    result = library.apply("test", f"mod:{entry.id}")
    assert result.files
    target_assets = assets(cores[0])
    target_image = target_assets["Texture2D"].image.convert("RGBA")
    assert target_image.size == mod_image.size
    rms = ImageStat.Stat(ImageChops.difference(target_image, mod_image)).rms
    assert sum(value * value for value in rms) / len(rms) < 20
    assert target_assets["TextAsset"].m_Script == source_assets["TextAsset"].m_Script
    assert library.state("test").applied == f"mod:{entry.id}"
    assert all(path.read_bytes() == data for path, data in originals.items()
               if parse_filename(path.name).core == cores[1])
    library.restore("test")
    assert {path: path.read_bytes() for path in game_dir.iterdir()} == originals


def test_duplicate_add_reports_the_existing_mod_even_with_another_filename(setup_library):
    env = setup_library
    source = make_mod(env.original, env.tmp / "input")
    entry, = env.library.add([source])
    env.library.rename(entry.id, "My mod")
    renamed = env.tmp / source.name.replace("2026-01-01_003", "2026-02-01_002")
    renamed.write_bytes(source.read_bytes())
    plain = env.tmp / "My renamed portrait.bundle"
    plain.write_bytes(source.read_bytes())
    for path in (source, renamed, plain):
        result = reload_library(env).add([path])
        assert result == []
        assert [(m.id, m.label) for m in result.duplicates] == [(entry.id, "My mod")]
        assert result.to_json()["duplicates"][0]["target"] == "test"
    assert len(list((env.root / "mods").iterdir())) == 1


def test_duplicate_adds_from_two_instances_are_serialized(setup_library):
    env = setup_library
    source = make_mod(env.original, env.tmp / "input")
    second = reload_library(env)
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda lib: lib.add([source]), [env.library, second]))
    assert sum(len(result) for result in results) == 1
    assert sum(len(result.duplicates) for result in results) == 1
    assert len(reload_library(env).mods()) == 1


def test_existing_duplicate_records_are_logged_and_preserved(setup_library, caplog):
    env = setup_library
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    data = json.loads((env.root / "state.json").read_text())
    duplicate = dict(data["mods"][0], id="d" * 32, label="Old duplicate")
    shutil.copytree(entry.file.parent, env.root / "mods" / duplicate["id"])
    data["mods"].append(duplicate)
    (env.root / "state.json").write_text(json.dumps(data))
    assert len(reload_library(env).mods()) == 2
    assert "Duplicate library mods" in caplog.text
    assert entry.id in caplog.text and duplicate["id"] in caplog.text


def test_add_recognizes_an_untracked_installed_mod_without_writing_game_files(setup_library, monkeypatch):
    env = setup_library
    source = make_mod(env.original, env.tmp / "input", fixed=True)
    official = env.original.read_bytes()
    env.original.with_suffix(".bundle.backup").write_bytes(official)
    env.original.write_bytes(source.read_bytes())
    before = env.original.stat()
    monkeypatch.setattr(env.library, "_commit", lambda *a, **kw: pytest.fail("adoption must not write game files"))
    result = env.library.add([source])
    entry, = result
    assert result.installed == [entry]
    assert env.original.stat().st_mtime_ns == before.st_mtime_ns
    assert env.original.read_bytes() == source.read_bytes()
    assert env.library.configured("test")["spr"] == f"mod:{entry.id}"
    assert env.library.state("test").applied == f"mod:{entry.id}"
    assert len(env.library.mods()) == 1


@pytest.mark.parametrize("fixed", [False, True])
def test_add_recognizes_installed_multipart_mods_with_official_parts(setup_library, monkeypatch, fixed):
    env = setup_library
    skeleton = game_bundle(env.game_dir, part="002", payload=b"skeleton")
    source = make_mod(env.original, env.tmp / "input", fixed=fixed)
    official = env.original.read_bytes()
    env.original.with_name(env.original.name + ".backup").write_bytes(official)
    env.original.write_bytes(source.read_bytes())
    before = {p: p.stat().st_mtime_ns for p in (skeleton, env.original)}
    result = env.library.add([skeleton, source])
    entry, = result
    assert result.installed == [entry] and len(env.library.mods()) == 1
    assert before == {p: p.stat().st_mtime_ns for p in before}
    assert env.library.configured("test")["spr"] == f"mod:{entry.id}"
    assert env.library.apply("test", f"mod:{entry.id}").unchanged
    assert env.original.read_bytes() == source.read_bytes()


def test_an_adopted_overwritten_mod_applies_as_unchanged_without_a_build(setup_library, monkeypatch):
    env = setup_library
    source = make_mod(env.original, env.tmp / "input", fixed=True)
    env.original.write_bytes(source.read_bytes())
    result = env.library.add([source])
    entry, = result.installed
    monkeypatch.setattr(env.library, "_cached_build", lambda *a, **kw: pytest.fail("already installed"))
    before = env.original.stat().st_mtime_ns
    assert env.library.apply("test", f"mod:{entry.id}").unchanged
    assert env.original.stat().st_mtime_ns == before
    assert not (env.root / "originals").exists()


def test_unchanged_apply_restamps_identical_bytes_and_confirmation_finds_their_use(setup_library):
    env = setup_library
    entry, = env.library.add([make_mod(env.original, env.tmp / "input")])
    source = f"mod:{entry.id}"
    env.library.apply("test", source)
    env.library.profiles.update(lambda data: data["folders"][env.library.current_pin().key]["configured"].clear())
    stamp = env.original.stat()
    os.utime(env.original, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 10_000_000))
    assert env.library.removal_info(entry.id)["used"]
    assert env.library.apply("test", source).unchanged
    assert env.library.state("test").applied == source
    assert reload_library(env).state("test").applied == source


# --- originals share blocks or move, with a durable record before either game path changes ---

class InterruptedWrite(BaseException):
    """A process exit, bypassing the ordinary exception rollback."""


@pytest.mark.parametrize("cloning", [False, True])
def test_original_moves_or_clones_and_restores_without_a_byte_copy(setup_library, monkeypatch, cloning):
    from ba_modding_toolkit.library import service
    env = setup_library
    official = env.original.read_bytes()
    inode = env.original.stat().st_ino
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    clones = []

    def clone(source, target):
        if not cloning:
            return False
        clones.append((source, target))
        shutil.copyfile(source, target)  # stand-in for a native clone on any test filesystem
        return True

    monkeypatch.setattr(storage, "_clone", clone)
    copy = service.atomic_copy
    original = env.library._original_path(env.original)

    def no_original_copy(source, target):
        assert target != original
        assert not (source == original and target == env.original)
        return copy(source, target)

    monkeypatch.setattr(service, "atomic_copy", no_original_copy)
    env.library.apply("test", f"mod:{entry.id}")
    assert original.read_bytes() == official
    if not cloning:
        assert original.stat().st_ino == inode
    env.library.restore("test")
    assert env.original.read_bytes() == official
    assert not original.exists()
    if not cloning:
        assert env.original.stat().st_ino == inode
    else:
        assert len(clones) >= 2
    assert not list((env.root / "transactions").glob("*/journal.json"))
    assert reload_library(env).state("test").applied == "official"


@pytest.mark.parametrize("point", ["journal", "copied", "kept", "prepared", "first_part", "saved"])
def test_crash_recovers_every_part_and_the_previous_records(setup_library, monkeypatch, point):
    from ba_modding_toolkit.library import service
    env = setup_library
    atlas = game_bundle(env.game_dir, part="002", payload=b"atlas")
    before = {path: path.read_bytes() for path in (atlas, env.original)}
    entry, = env.library.add([make_mod(path, env.tmp / "input", fixed=True) for path in before])
    monkeypatch.setattr(storage, "_clone", lambda *args: False)
    move, copy, save = service.verified_move, service.atomic_copy, service.atomic_json
    replace, verify = storage.os.replace, storage.verify_file
    interrupted = False

    def crash():
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise InterruptedWrite()

    def moving(source, target, sha1):
        move(source, target, sha1)
        if point == "kept" and target.parent == env.root / "originals":
            crash()

    def copying(source, target):
        copy(source, target)
        if point == "first_part" and target == atlas:
            crash()

    def saving(path, data):
        if point == "saved" and path.name == "journal.json" and data["phase"] == "committed":
            crash()
        save(path, data)
        if path.name == "journal.json" and ((point == "journal" and data["phase"] == "preparing")
                                            or (point == "prepared" and data["phase"] == "writing")):
            crash()

    def replacing(source, target):
        if point == "copied" and source in before and target.parent == env.root / "originals":
            import errno
            raise OSError(errno.EXDEV, "Different volumes")
        return replace(source, target)

    def verifying(path, sha1):
        verify(path, sha1)
        if point == "copied" and path.parent == env.root / "originals":
            crash()

    monkeypatch.setattr(service, "verified_move", moving)
    monkeypatch.setattr(service, "atomic_copy", copying)
    monkeypatch.setattr(service, "atomic_json", saving)
    monkeypatch.setattr(storage.os, "replace", replacing)
    monkeypatch.setattr(storage, "verify_file", verifying)
    with pytest.raises(InterruptedWrite):
        env.library.apply("test", f"mod:{entry.id}")
    journals = list((env.root / "transactions").glob("*/journal.json"))
    assert len(journals) == 1
    assert json.loads(journals[0].read_text())["phase"] != "committed"
    if point == "kept":
        assert not atlas.exists()
        assert env.library._original_path(atlas).read_bytes() == before[atlas]
    recovered = reload_library(env)
    assert {path: path.read_bytes() for path in before} == before
    assert recovered.state("test").applied == "official"
    assert all(str(path.resolve()) not in recovered._applied for path in before)
    assert not list((env.root / "transactions").glob("*/journal.json"))


@pytest.mark.parametrize("published", [False, True])
def test_commit_marker_failure_keeps_recoverable_files_and_state(setup_library, monkeypatch, published):
    from ba_modding_toolkit.library import service
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    monkeypatch.setattr(storage, "_clone", lambda *args: False)
    save = service.atomic_json

    def saving(path, data):
        if path.name == "journal.json" and data["phase"] == "committed":
            if published:
                save(path, data)
            raise OSError(5, "Commit flush failed", str(path))
        save(path, data)

    monkeypatch.setattr(service, "atomic_json", saving)
    expect_error("library_io_error", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert env.original.read_bytes() == entry.file.read_bytes()
    assert env.library._original_path(env.original).read_bytes() == official
    monkeypatch.setattr(service, "atomic_json", save)
    recovered = reload_library(env)
    assert recovered.state("test").applied == (f"mod:{entry.id}" if published else "official")
    assert env.original.read_bytes() == (entry.file.read_bytes() if published else official)
    assert not list((env.root / "transactions").glob("*/journal.json"))


def test_a_state_flush_failure_after_publication_rolls_back_its_records(setup_library, monkeypatch):
    from ba_modding_toolkit.library import service
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    save = service.atomic_json
    failed = False

    def saving(path, data):
        nonlocal failed
        save(path, data)
        if path.name == "state.json" and not failed:
            failed = True
            raise OSError(5, "State flush failed", str(path))

    monkeypatch.setattr(service, "atomic_json", saving)
    expect_error("library_io_error", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert env.original.read_bytes() == official
    assert json.loads((env.root / "state.json").read_text())["applied"] == {}
    assert reload_library(env).state("test").applied == "official"


def test_recovery_follows_a_relocated_library(setup_library, monkeypatch):
    from ba_modding_toolkit.library import service
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    monkeypatch.setattr(storage, "_clone", lambda *args: False)
    move = service.verified_move

    def moving(source, target, sha1):
        move(source, target, sha1)
        raise InterruptedWrite()

    monkeypatch.setattr(service, "verified_move", moving)
    with pytest.raises(InterruptedWrite):
        env.library.apply("test", f"mod:{entry.id}")
    destination = env.tmp / "relocated-library"
    env.root.rename(destination)
    monkeypatch.setattr(service, "verified_move", move)
    recovered = ModLibrary(destination, env.catalog, object(), env.settings)
    assert env.original.read_bytes() == official
    assert recovered.state("test").applied == "official"
    assert not list((destination / "transactions").glob("*/journal.json"))


@pytest.mark.parametrize("crash_again", [False, True])
def test_crash_during_restore_returns_original_to_library_before_rolling_back_mod(setup_library, monkeypatch,
                                                                                crash_again):
    from ba_modding_toolkit.library import service
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    monkeypatch.setattr(storage, "_clone", lambda *args: False)
    env.library.apply("test", f"mod:{entry.id}")
    modded = env.original.read_bytes()
    original = env.library._original_path(env.original)
    move = service.verified_move
    interruptions = 0

    def moving(source, target, sha1):
        nonlocal interruptions
        move(source, target, sha1)
        if source == original and target == env.original and interruptions == 0:
            interruptions += 1
            raise InterruptedWrite()
        if crash_again and source == env.original and target == original and interruptions == 1:
            interruptions += 1
            raise InterruptedWrite()

    monkeypatch.setattr(service, "verified_move", moving)
    with pytest.raises(InterruptedWrite):
        env.library.restore("test")
    assert not original.exists() and env.original.read_bytes() == official
    if crash_again:
        with pytest.raises(InterruptedWrite):
            reload_library(env)
        assert original.read_bytes() == official and not env.original.exists()
    recovered = reload_library(env)
    assert original.read_bytes() == official
    assert env.original.read_bytes() == modded
    assert recovered.state("test").applied == f"mod:{entry.id}"
    recovered.restore("test")
    assert env.original.read_bytes() == official and not original.exists()


@pytest.mark.parametrize("dev_sandbox", [False, True], ids=["normal", "dev-sandbox"])
def test_recovery_repeats_game_and_caller_checks_before_restoring_missing_file(setup_library, monkeypatch,
                                                                            dev_sandbox):
    from ba_modding_toolkit.library import service
    env = setup_library
    # Writable dev sandboxes deliberately skip the running-game check.
    if dev_sandbox:
        monkeypatch.setenv("BAMT_DEV_ROOTS", str(env.tmp))
        monkeypatch.setenv("BAMT_DEV_WRITABLE", str(env.tmp))
    else:
        monkeypatch.delenv("BAMT_DEV_ROOTS", raising=False)
        monkeypatch.delenv("BAMT_DEV_WRITABLE", raising=False)
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    monkeypatch.setattr(storage, "_clone", lambda *args: False)
    move = service.verified_move

    def moving(source, target, sha1):
        move(source, target, sha1)
        raise InterruptedWrite()

    monkeypatch.setattr(service, "verified_move", moving)
    with pytest.raises(InterruptedWrite):
        env.library.apply("test", f"mod:{entry.id}")
    monkeypatch.setattr(service, "verified_move", move)

    def running():
        raise ServiceError("game_running")

    monkeypatch.setattr(safety, "check_game_not_running", running)

    def steam(folder):
        raise ServiceError("steam_busy")

    # Keep constructor recovery pending even when the running-game check is skipped.
    monkeypatch.setattr(safety, "check_steam_idle", steam)
    recovered = reload_library(env)
    expect_error("steam_busy", lambda: recovered.state("test"))
    assert not env.original.exists()
    assert env.library._original_path(env.original).read_bytes() == official
    monkeypatch.setattr(safety, "check_steam_idle", lambda folder: None)
    if not dev_sandbox:
        expect_error("game_running", lambda: recovered.state("test"))
        assert not env.original.exists()
        monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    mode = env.game_dir.stat().st_mode & 0o777
    env.game_dir.chmod(0o555)
    try:
        expect_error("game_file_locked", lambda: recovered.state("test"))
        assert not env.original.exists()
    finally:
        env.game_dir.chmod(mode)

    def classic(pin):
        raise ServiceError("classic_open")

    recovered._write_check = classic
    expect_error("classic_open", lambda: recovered.state("test"))
    assert not env.original.exists()
    recovered._write_check = None
    assert recovered.state("test").applied == "official"
    assert env.original.read_bytes() == official


def test_prune_waits_for_the_shared_transaction_lock(setup_library, monkeypatch):
    from contextlib import contextmanager
    from ba_modding_toolkit.library import service
    env = setup_library
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    env.library.apply("test", f"mod:{entry.id}")
    env.library.restore("test")
    original = env.library._original_path(env.original)
    shutil.copyfile(env.original, original)
    attempted = threading.Event()
    lock = service.file_lock

    @contextmanager
    def tracked(path, **kwargs):
        if path.name == "transactions.lock":
            attempted.set()
        with lock(path, **kwargs):
            yield

    monkeypatch.setattr(service, "file_lock", tracked)
    with ThreadPoolExecutor(max_workers=1) as pool:
        with lock(env.root / "transactions.lock"):
            result = pool.submit(env.library.prune)
            assert attempted.wait(5)
            assert not result.done()
            assert original.read_bytes() == env.original.read_bytes()
        assert result.result(timeout=5) == [original]


def test_recovery_keeps_an_external_change_and_the_only_official_original(setup_library, monkeypatch):
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    monkeypatch.setattr(storage, "_clone", lambda *args: False)

    def log(message):
        if message.startswith("Installed "):
            raise InterruptedWrite()

    with pytest.raises(InterruptedWrite):
        env.library.apply("test", f"mod:{entry.id}", log=log)
    external = header_bundle(b"outside change after interruption")
    env.original.write_bytes(external)
    recovered = reload_library(env)
    expect_error("entry_changed", lambda: recovered.state("test"))
    assert env.original.read_bytes() == external
    assert env.library._original_path(env.original).read_bytes() == official
    assert len(list((env.root / "transactions").glob("*/journal.json"))) == 1


def test_off_and_on_with_no_clone_rekeep_the_moved_original(setup_library, monkeypatch):
    env = setup_library
    official = env.original.read_bytes()
    entry, = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])
    monkeypatch.setattr(storage, "_clone", lambda *args: False)
    source = f"mod:{entry.id}"
    env.library.apply("test", source)
    original = env.library._original_path(env.original)
    for _ in range(2):
        assert not env.library.toggle(False, expect=True).failed
        assert env.original.read_bytes() == official and not original.exists()
        assert not env.library.toggle(True, expect=False).failed
        assert original.read_bytes() == official
        assert env.library.state("test").applied == source
