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
    name = f"assets-_mx-{category}-{core_name}-_mxdependency-{date}_{part}_assets_all_{CRCUtils.compute_crc32(data)}.bundle"
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
    catalog = FakeCatalog(FakeVariant("test", "test_spr", "test_home_gl"), FakeVariant("other", "other_spr"))
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


def test_variant_swap_rejects_incompatible_texture_page_counts(setup_library, monkeypatch):
    env = setup_library
    other = game_bundle(env.game_dir, "other_spr", payload=b"variant!")
    def load(path, *args, **kwargs):
        objects = [fake_asset("page", "Texture2D", b"data")]
        if path.name != other.name:
            objects.append(fake_asset("page2", "Texture2D", b"data"))
        return SimpleNamespace(env=SimpleNamespace(objects=objects))
    monkeypatch.setattr(Bundle, "load", load)
    before = {path: path.read_bytes() for path in (env.original, other)}
    expect_error("variant_incompatible", lambda: env.library.apply("test", "variant:other"))
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
