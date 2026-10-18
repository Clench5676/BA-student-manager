"""Library behavior with synthetic headers, fakes, and temporary game copies."""

from __future__ import annotations

import json
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image, ImageChops, ImageStat

from ba_modding_toolkit import core, mod_install
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import ModLibrary
from ba_modding_toolkit.library import safety, storage
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


def header_bundle(payload=b"official"):
    header = b"UnityFS\x00" + (6).to_bytes(4, "big") + b"5.x.x\x002021.3\x00"
    return header + (len(header) + 8 + len(payload)).to_bytes(8, "big") + payload


def game_bundle(directory, core_name="test_spr", part="003", date="2026-01-01", payload=b"official"):
    directory.mkdir(parents=True, exist_ok=True)
    data = header_bundle(payload)
    category = "spinecharacters" if core_name.endswith("_spr") else "spinelobbies"
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
def setup_library(tmp_path, monkeypatch):
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
               game_bundle(env.tmp / "input", date="2026-02-01"),
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
    expect_error("mod_unsupported", lambda: env.library.add([path]))
    assert env.library.mods() == []


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
    assert env.library.restore("test").source == "official"
    assert env.original.read_bytes() == original_bytes
    assert env.library.state("test").applied == "official"
    assert env.library.restore("test").unchanged
    assert logs and events
    json.dumps(result.to_json())


def test_crc_fixed_state_and_external_change_invalidates_applied_record(setup_library):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input", fixed=True)])[0]
    env.library.apply("test", f"mod:{entry.id}")
    assert env.library.state("test").crc == "fixed"
    env.original.write_bytes(header_bundle(b"external"))
    state = env.library.state("test")
    assert state.applied == "unknown" and state.crc == "needs_fix"
    env.library.apply("test", "official")
    assert env.library.state("test").applied == "official"


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
    assert library.state("test").applied == "unknown"
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
    assert (env.root / "originals" / env.original.name).read_bytes() == original_bytes
    assert reload_library(env).state("test").applied == "official"


def test_multi_part_install_rolls_back_every_part_on_write_failure(setup_library, monkeypatch):
    env = setup_library
    atlas = game_bundle(env.game_dir, part="002", payload=b"atlas")
    targets = [atlas, env.original]
    before = {path: path.read_bytes() for path in targets}
    entry, = env.library.add([make_mod(path, env.tmp / "input", payload=b"mod " + path.name.encode())
                              for path in targets])
    from ba_modding_toolkit.library import service
    original_copy = service.atomic_copy
    written = []
    def copy(source, target):
        if target == env.original:
            assert written == [atlas]
            raise PermissionError(13, "Write failure", str(target))
        original_copy(source, target)
        if target in targets:
            written.append(target)
    monkeypatch.setattr(service, "atomic_copy", copy)
    expect_error("game_file_locked", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert written == [atlas, atlas]
    assert {path: path.read_bytes() for path in targets} == before
    assert reload_library(env).state("test").applied == "official"
    assert all((env.root / "originals" / path.name).read_bytes() == before[path] for path in targets)


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
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    def running():
        raise ServiceError("game_running")
    monkeypatch.setattr(safety, "check_game_not_running", running)
    expect_error("game_running", lambda: env.library.apply("test", f"mod:{entry.id}"))
    assert env.library.state("test").applied == "official"


def test_detects_game_process(monkeypatch):
    monkeypatch.setattr(safety.subprocess, "run", lambda *args, **kwargs:
                        SimpleNamespace(stdout='"BlueArchive.exe","123"\n' if os.name == "nt" else '/game/BlueArchive.exe\n'))
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


def test_update_uses_official_baseline_preserves_previous_and_reports_unchanged(setup_library, monkeypatch):
    env = setup_library
    entry = env.library.add([make_mod(env.original, env.tmp / "input")])[0]
    old_bytes = entry.file.read_bytes()
    env.library.apply("test", f"mod:{entry.id}")
    calls = []
    def update(sources, targets, output, *args, **kwargs):
        calls.append(targets)
        result = output / targets[0].name
        result.write_bytes(header_bundle(b"updated!"))
        return ModUpdateResult(True, "updated", [FilePair(result, targets[0])])
    monkeypatch.setattr(core, "process_mod_update", update)
    result = env.library.update(entry.id)
    assert result.unchanged is False
    assert result.previous[0].read_bytes() == old_bytes
    assert result.previous[0].is_relative_to(entry.file.parent / "previous")
    assert result.mod.file.read_bytes() == header_bundle(b"updated!")
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


GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR", "/Users/A200237264/Library/Application Support/Blue Archive/Game"))


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
