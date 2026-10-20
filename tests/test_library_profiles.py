"""The mod configuration (profiles.json), the Enable Mods switch, adoption, drift and built copies, with synthetic
header-only bundles in temporary game folders (never a real install, library or settings)."""

from __future__ import annotations

import json
import os
import shutil
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import core, mod_install
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.i18n import I18n
from ba_modding_toolkit.library import ModLibrary, safety, service, storage
from ba_modding_toolkit.library import profiles as profiles_module
from ba_modding_toolkit.library.judge import carried_of, classify, install_key, install_root, leaves
from ba_modding_toolkit.library.profiles import Profiles
from ba_modding_toolkit.models import FilePair, ModUpdateResult
from ba_modding_toolkit.naming import parse_filename
from ba_modding_toolkit.utils import CRCUtils

from test_library import FakeCatalog, FakeVariant, game_bundle, header_bundle, make_mod

DATA = Path(__file__).parent / "data"


def expect_error(code, action):
    with pytest.raises(ServiceError) as caught:
        action()
    assert caught.value.code == code, caught.value
    json.dumps(caught.value.to_json())
    return caught.value


@pytest.fixture(params=[False, True])
def original_cloning(request, monkeypatch):
    def clone(source, target):
        if not request.param:
            return False
        shutil.copy2(source, target)
        return True

    monkeypatch.setattr(storage, "_clone", clone)
    return request.param


# --- profiles.json ---

def test_profiles_round_trip_keeps_unknown_keys(tmp_path):
    profiles = Profiles(tmp_path)
    assert profiles.read() is None
    profiles.update(lambda data: data.update(enabled=False, future={"kept": 1}))
    profiles.update(lambda data: data["folders"].setdefault("/game", {"server": "global", "later": [1]}))
    data = Profiles(tmp_path).read()
    assert data["enabled"] is False and data["future"] == {"kept": 1}
    assert data["folders"]["/game"]["later"] == [1]
    assert json.loads((tmp_path / "profiles.json").read_text())["future"] == {"kept": 1}


def test_two_profiles_on_one_file_keep_both_changes(tmp_path):
    first, second = Profiles(tmp_path), Profiles(tmp_path)
    first.read(), second.read()
    first.update(lambda data: data["folders"].setdefault("/a", {"server": "global"}))
    second.update(lambda data: data["folders"].setdefault("/b", {"server": "japan"}))
    assert set(first.read()["folders"]) == set(second.read()["folders"]) == {"/a", "/b"}


def test_a_missing_switch_means_on(tmp_path):
    from ba_modding_toolkit.library.profiles import enabled
    assert enabled(None) and enabled({"version": 1, "folders": {}})
    (tmp_path / "profiles.json").write_text('{"version": 1, "folders": {}}')
    assert enabled(Profiles(tmp_path).read())


def test_a_corrupt_file_reads_its_last_good_copy_and_keeps_the_bad_one(tmp_path):
    profiles = Profiles(tmp_path)
    profiles.update(lambda data: data.update(enabled=False))
    profiles.update(lambda data: data["folders"].setdefault("/game", {"server": "global"}))
    (tmp_path / "profiles.json").write_text("{broken")
    data = Profiles(tmp_path).read()
    assert data["enabled"] is False  # mods stay off: nothing is lost
    Profiles(tmp_path).update(lambda data: data.update(note="next write"))
    assert (tmp_path / "profiles.json.bad").read_text() == "{broken"
    assert Profiles(tmp_path).read()["note"] == "next write"


def test_a_missing_file_with_its_prev_reads_the_prev(tmp_path):
    profiles = Profiles(tmp_path)
    profiles.update(lambda data: data.update(enabled=False))
    profiles.update(lambda data: data.update(toggled="t"))
    (tmp_path / "profiles.json").unlink()
    data = Profiles(tmp_path).read()
    assert data["enabled"] is False and "toggled" not in data  # the last good file before the last write


def test_both_files_unreadable_is_an_error_and_writes_nothing(tmp_path):
    (tmp_path / "profiles.json").write_text("{broken")
    (tmp_path / "profiles.json.prev").write_text("[]")
    profiles = Profiles(tmp_path)
    expect_error("profiles_unreadable", profiles.read)
    expect_error("profiles_unreadable", lambda: profiles.update(lambda data: data.update(enabled=False)))
    assert (tmp_path / "profiles.json").read_text() == "{broken"
    assert not (tmp_path / "profiles.json.bad").exists()


def test_a_failed_write_keeps_the_file_as_it_was(tmp_path, monkeypatch):
    profiles = Profiles(tmp_path)
    profiles.update(lambda data: data.update(enabled=False))
    before = (tmp_path / "profiles.json").read_bytes()
    from ba_modding_toolkit import filelock
    real = filelock.os.replace

    def fail(source, target):
        if Path(target).name == "profiles.json":
            raise PermissionError(13, "Read-only", str(target))
        return real(source, target)

    monkeypatch.setattr(filelock.os, "replace", fail)
    with pytest.raises(PermissionError):
        profiles.update(lambda data: data.update(enabled=True))
    monkeypatch.setattr(filelock.os, "replace", real)
    assert (tmp_path / "profiles.json").read_bytes() == before
    assert Profiles(tmp_path).read()["enabled"] is False
    assert not list(tmp_path.glob(".profiles.json.*"))


def test_a_change_may_write_nothing(tmp_path):
    profiles = Profiles(tmp_path)
    seen = []
    data = profiles.update(lambda data: False, after=seen.append)
    assert seen == [data]
    assert profiles.read() is None
    assert not (tmp_path / "profiles.json").exists()


@pytest.mark.parametrize("write", [False, True])
def test_profiles_after_runs_under_the_lock_with_the_stored_configuration(tmp_path, monkeypatch, write):
    profiles = Profiles(tmp_path)
    profiles.update(lambda data: data.update(enabled=False))
    lock = profiles_module.file_lock
    held = False
    seen = []

    @contextmanager
    def tracked(path):
        nonlocal held
        with lock(path):
            held = True
            try:
                yield
            finally:
                held = False

    def change(data):
        data["enabled"] = True
        return None if write else False

    def after(data):
        assert held
        assert data == json.loads(profiles.path.read_text())
        assert data["enabled"] is write
        seen.append(data)

    monkeypatch.setattr(profiles_module, "file_lock", tracked)
    data = profiles.update(change, after=after)
    assert seen == [data]


def test_reading_no_configuration_touches_nothing(tmp_path):
    assert Profiles(tmp_path / "library").read() is None
    assert not (tmp_path / "library").exists()


# --- a library over temporary game folders ---

class World:
    """Game folders, the settings naming them, and libraries over them, all in tmp_path."""

    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.catalog = FakeCatalog(FakeVariant("test", "test_spr", "test_home"),
                                   FakeVariant("other", "other_spr", family="other"))
        self.settings = Settings(tmp / "config.toml")
        self.settings.set("enable_crc_correction", "false")
        self.settings.set("compression_method", "none")
        self.game = tmp / "game"
        self.spr = game_bundle(self.game)
        self.settings.set("game_resource_dir", str(self.game))
        self.consent = False
        self.root = tmp / "library"
        self.library = self.build()

    def build(self, data_id: str = "A", settings: Settings | None = None) -> ModLibrary:
        return ModLibrary(self.root, self.catalog, None, settings or self.settings,
                          scan_allowed=lambda: self.consent, data_id=data_id)

    def reload(self) -> ModLibrary:
        self.library = self.build()
        return self.library

    def key(self, game: Path | None = None) -> str:
        return install_key(install_root(game or self.game))

    def profiles(self) -> dict:
        return json.loads((self.root / "profiles.json").read_text())

    def folder(self, game: Path | None = None) -> dict:
        return self.profiles()["folders"][self.key(game)]

    def add(self, path: Path, payload: bytes = b"modded!!", fixed: bool = False, where: str = "input"):
        entry, = self.library.add([make_mod(path, self.tmp / where, payload, fixed)])
        return entry

    def entries(self, **kwargs) -> dict:
        return {(e.install, e.core): e for e in self.library.entries(**kwargs)}

    def toggle(self, enabled: bool, **kwargs):
        return self.library.toggle(enabled, not enabled, **kwargs)

    def unfinished(self) -> list[dict]:
        return self.profiles()["unfinished"]

    def original(self, path: Path) -> Path:
        return self.root / "originals" / path.name


@pytest.fixture
def world(tmp_path, monkeypatch, header_only_bundles):
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    monkeypatch.setattr(Bundle, "check_need_crc", lambda *args, **kwargs: False)
    return World(tmp_path)


OFFICIAL = header_bundle(b"official")


# --- switching and the configuration ---

@pytest.mark.parametrize("language", ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"])
def test_adoption_toggle_and_drift_progress_name_the_action(world, monkeypatch, language):
    translate = I18n(language).t
    monkeypatch.setattr(service, "t", translate)
    world.consent = True
    keep_backup(world.spr)
    outside_mod(world.spr)
    listed = [{"install": world.key(), "core": "test_spr"}]
    progress = []
    report = lambda *args: progress.append(args)
    result = world.library.adopt(listed, progress=report)
    assert result.added and not result.failed
    assert progress == [(1, 1, translate("webui.progress.add", name="test_spr"))]
    for enabled, action in [(False, "restore"), (True, "apply")]:
        progress.clear()
        assert not world.toggle(enabled, progress=report).failed
        assert progress == [(1, 1, translate(f"webui.progress.{action}", name="test_spr"))]
    world.spr.write_bytes(OFFICIAL)
    progress.clear()
    assert not world.library.restore_drift([{**listed[0], "state": "reset"}], progress=report).failed
    assert progress == [(1, 1, translate("webui.progress.apply", name="test_spr"))]


def test_apply_configures_and_restore_drops_it(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    configured = world.folder()["configured"]["test_spr"]
    assert (configured["source"], configured["variant"], configured["kind"]) == (f"mod:{mod.id}", "test", "spr")
    assert world.library.configured("test") == {"spr": f"mod:{mod.id}", "lobby": None}
    assert list(world.folder()["named_by"]) == ["A"]  # the first record names its data directory
    world.library.restore("test")
    assert world.folder()["configured"] == {}
    assert world.spr.read_bytes() == OFFICIAL


def test_the_records_say_what_was_written(world):
    atlas = game_bundle(world.game, part="002", payload=b"skeleton")
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    texture, skeleton = applied[str(world.spr.resolve())], applied[str(atlas.resolve())]
    assert (texture["official"], texture["crc"], skeleton["official"], skeleton["crc"]) == (False, "fixed", True, "ok")
    assert texture["tail"] == world.spr.read_bytes()[-8:].hex() and skeleton["tail"] is None
    assert texture["at"] and skeleton["source"] == f"mod:{mod.id}"


def test_apply_while_off_is_saved_and_written_by_on(world):
    mod = world.add(world.spr)
    world.toggle(False)
    result = world.library.apply("test", f"mod:{mod.id}")
    assert result.deferred and result.unchanged and result.files == []
    assert world.spr.read_bytes() == OFFICIAL
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{mod.id}"
    assert not world.library.would_write("test", f"mod:{mod.id}")
    world.toggle(True)
    assert world.spr.read_bytes() == mod.file.read_bytes()


def test_off_then_on_brings_back_every_configured_entry(world):
    lobby = game_bundle(world.game, "test_home", payload=b"lobby!!!")
    portrait, home = world.add(world.spr), world.add(lobby, payload=b"lobbymod")
    world.library.apply("test", f"mod:{portrait.id}")
    world.library.apply("test", f"mod:{home.id}", kind="lobby")
    result = world.toggle(False)
    assert {item["core"] for item in result.done} == {"test_spr", "test_home"}
    assert world.spr.read_bytes() == OFFICIAL and lobby.read_bytes() == header_bundle(b"lobby!!!")
    assert world.library.configured("test") == {"spr": f"mod:{portrait.id}", "lobby": f"mod:{home.id}"}
    assert world.unfinished() == []
    result = world.toggle(True)
    assert {item["core"] for item in result.done} == {"test_spr", "test_home"}
    assert world.spr.read_bytes() == portrait.file.read_bytes() and lobby.read_bytes() == home.file.read_bytes()
    assert result.cores == ["test_home", "test_spr"] and result.kinds == ["lobby", "spr"]


def test_an_off_with_nothing_to_adopt_changes_only_the_intent(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    before = world.profiles()
    world.toggle(False)
    after = world.profiles()
    assert after["enabled"] is False and after["toggled"] and after["unfinished"] == []
    folder_before, folder_after = before["folders"][world.key()], after["folders"][world.key()]
    assert folder_after["configured"] == folder_before["configured"]
    assert folder_after["updated"] == folder_before["updated"] == {}


def test_toggles_are_idempotent(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    again = world.library.toggle(False, False)  # a Retry of the Off
    assert again.done == [] and world.spr.read_bytes() == OFFICIAL
    world.toggle(True)
    again = world.library.toggle(True, True)
    assert again.done == [] and world.spr.read_bytes() == mod.file.read_bytes()


def test_a_stale_expectation_is_refused(world):
    expect_error("state_changed", lambda: world.library.toggle(True, False))
    assert "enabled" not in (world.library.profiles.read() or {})


def test_an_off_then_a_scan_keeps_every_configured_source(world):
    world.consent = True
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "ok" and entry.configured == f"mod:{mod.id}"
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{mod.id}"  # official never takes over


def test_refusals_leave_the_intent_unchanged(world, monkeypatch):
    def running():
        raise ServiceError("game_running")

    monkeypatch.setattr(safety, "check_game_not_running", running)
    expect_error("game_running", lambda: world.toggle(False))
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)

    def busy(folder):
        raise ServiceError("steam_busy")

    monkeypatch.setattr(safety, "check_steam_idle", busy, raising=False)
    expect_error("steam_busy", lambda: world.toggle(False))
    assert world.library.intent()["enabled"] is True


def test_a_changed_set_of_game_folders_is_refused(world):
    pins = world.library.installs()
    other = world.tmp / "japan"
    game_bundle(other)
    world.settings.set("game_resource_dir_japan", str(other))
    expect_error("folder_changed", lambda: world.library.toggle(False, True, pins=pins))
    assert world.library.intent()["enabled"] is True


# --- mods already in use: adoption, Off and untracked entries ---

def outside_mod(path: Path, payload: bytes = b"outside!", fixed: bool = True) -> bytes:
    """Another tool's mod written over a game file (CRC-fixed by default, as working mods are)."""
    data = header_bundle(payload)
    if fixed:
        data = CRCUtils.apply_crc_fix(data, int(parse_filename(path.name).crc))
    path.write_bytes(data)
    return data


def keep_backup(path: Path, data: bytes = OFFICIAL) -> Path:
    """The classic GUI's .backup of the official file beside it."""
    backup = path.with_name(path.name + ".backup")
    backup.write_bytes(data)
    return backup


def test_untracked_mods_are_adopted_before_an_off_and_come_back_on(world, original_cloning):
    world.consent = True
    keep_backup(world.spr)
    data = outside_mod(world.spr)
    entry = world.entries()[(world.key(), "test_spr")]
    assert (entry.state, entry.fixed, entry.overwritten, entry.size) == ("untracked", True, False, len(data))
    assert entry.files[0].copy == "backup"
    result = world.toggle(False)
    assert [item["core"] for item in result.adopted] == ["test_spr"]
    assert world.spr.read_bytes() == OFFICIAL
    assert world.original(world.spr).exists() == original_cloning
    if original_cloning:
        assert world.original(world.spr).read_bytes() == OFFICIAL
    mod, = world.library.mods()
    assert mod.file.read_bytes() == data and mod.core == "test_spr" and mod.target == "test"
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{mod.id}"
    world.toggle(True)
    assert world.spr.read_bytes() == data


def test_a_dismissed_untracked_entry_is_adopted_by_an_off_all_the_same(world):
    world.consent = True
    keep_backup(world.spr)
    outside_mod(world.spr)
    world.library.dismiss("untracked", [{"install": world.key(), "core": "test_spr"}])
    assert world.entries()[(world.key(), "test_spr")].dismissed
    world.toggle(False)
    assert world.spr.read_bytes() == OFFICIAL and len(world.library.mods()) == 1


def test_a_dismissal_lasts_until_a_file_changes(world):
    world.consent = True
    keep_backup(world.spr)
    outside_mod(world.spr)
    world.library.dismiss("untracked", [{"install": world.key(), "core": "test_spr"}])
    assert world.entries()[(world.key(), "test_spr")].dismissed
    assert not world.entries(include_dismissed=True)[(world.key(), "test_spr")].dismissed
    outside_mod(world.spr, b"another!")
    assert not world.entries()[(world.key(), "test_spr")].dismissed


def test_a_configured_entry_changed_outside_is_adopted_with_the_change_on_off(world):
    world.consent = True
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    data = outside_mod(world.spr)
    assert world.entries()[(world.key(), "test_spr")].state == "changed"
    world.toggle(False)
    assert world.spr.read_bytes() == OFFICIAL
    adopted = next(m for m in world.library.mods() if m.id != mod.id)
    assert adopted.file.read_bytes() == data
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{adopted.id}"  # the user's latest choice
    world.toggle(True)
    assert world.spr.read_bytes() == data


def test_an_overwritten_untracked_entry_is_adopted_and_left_stuck(world):
    world.consent = True
    data = outside_mod(world.spr)  # no official copy anywhere
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.overwritten and entry.files[0].copy is None and not entry.files[0].restorable
    result = world.toggle(False)
    assert [item["core"] for item in result.adopted] == ["test_spr"]
    assert [item["core"] for item in result.stuck] == ["test_spr"]
    assert world.spr.read_bytes() == data  # left as it is, its mod now safe in the library
    assert world.library.mods()[0].file.read_bytes() == data
    assert world.unfinished() == [{"install": world.key(), "core": "test_spr", "why": "stuck"}]
    assert world.library.intent()["unfinished"] == {"pending": 0, "left": 0, "stuck": 1}


def test_without_scan_consent_an_off_reverts_what_the_library_wrote_and_nothing_else(world):
    other = game_bundle(world.game, "other_spr", payload=b"other!!!")
    keep_backup(other, header_bundle(b"other!!!"))
    outside = outside_mod(other)  # never recorded: not looked for
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    changed = outside_mod(world.spr, b"changed!")  # recorded, changed since: adopted when reached
    expect_error("scan_off", world.library.entries)
    result = world.toggle(False)
    assert [item["core"] for item in result.adopted] == ["test_spr"]
    assert world.spr.read_bytes() == OFFICIAL and other.read_bytes() == outside
    assert any(m.file.read_bytes() == changed for m in world.library.mods())


def test_adopting_a_partial_lobby_stores_one_mod_and_records_every_part(world):
    world.consent = True
    parts = [game_bundle(world.game, "test_home", part=part, payload=part.encode() * 3) for part in ("002", "003")]
    for part in parts:
        keep_backup(part, part.read_bytes())
    data = outside_mod(parts[1], b"lobby mod")
    entry = world.entries()[(world.key(), "test_home")]
    result = world.library.adopt([{"install": entry.install, "core": entry.core}])
    mod, = result.added
    assert mod.kind == "lobby" and [p.name for p in mod.file.parent.glob("*.bundle")] == [parts[1].name]
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    assert {applied[str(p.resolve())]["source"] for p in parts} == {f"mod:{mod.id}"}
    assert applied[str(parts[0].resolve())]["official"] is True and "crc" not in applied[str(parts[1].resolve())]
    built = world.folder()["built"]["test_home"]
    assert built == {"source": f"mod:{mod.id}", "inputs": [],
                     "parts": {parts[1].name: {"sha1": built["parts"][parts[1].name]["sha1"],
                                               "mod_file": parts[1].name}}}
    assert parts[1].read_bytes() == data
    assert world.library.remove(mod.id).failed == []
    assert parts[1].read_bytes() == header_bundle(b"003" * 3)


def test_an_adoption_that_matches_a_library_mod_configures_that_mod(world):
    world.consent = True
    keep_backup(world.spr)
    mod = world.add(world.spr, payload=b"lib mod!", fixed=True)
    shutil.copyfile(mod.file, world.spr)  # the classic GUI installed the library's mod
    result = world.library.adopt([{"install": world.key(), "core": "test_spr"}])
    assert [m.id for m in result.added] == [mod.id] and len(world.library.mods()) == 1
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{mod.id}"


def test_a_failed_adoption_is_rolled_back(world, monkeypatch):
    world.consent = True
    keep_backup(world.spr)
    outside_mod(world.spr)
    real = Profiles.update

    def fail(self, change, after=None):
        raise PermissionError(13, "Read-only", "profiles.json")

    monkeypatch.setattr(Profiles, "update", fail)
    result = world.library.adopt([{"install": world.key(), "core": "test_spr"}])
    monkeypatch.setattr(Profiles, "update", real)
    assert result.added == [] and result.failed[0]["code"] == "library_io_error"
    assert world.library.mods() == [] and not any((world.root / "mods").iterdir())
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    assert str(world.spr.resolve()) not in applied


def test_an_adoption_that_does_not_fit_is_refused(world, monkeypatch):
    world.consent = True
    keep_backup(world.spr)
    outside_mod(world.spr)
    monkeypatch.setattr(service.shutil, "disk_usage", lambda path: SimpleNamespace(free=1000))
    error = expect_error("not_enough_space", lambda: world.library.adopt(
        [{"install": world.key(), "core": "test_spr"}]))
    assert error.params["free"] == 1000 and error.params["need"] > 0
    assert world.library.mods() == []


def test_a_damaged_entry_is_never_adopted(world):
    world.consent = True
    world.spr.write_bytes(OFFICIAL[:-4])  # shorter than its header says
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "damaged"
    result = world.library.adopt([{"install": world.key(), "core": "test_spr"}])
    assert result.added == [] and result.skipped[0]["why"] == "entry_changed"
    assert world.toggle(False).adopted == []


# --- built copies ---

def no_installer(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("the installer must not run")

    monkeypatch.setattr(mod_install, "execute_mod_install", fail)
    monkeypatch.setattr(core, "process_mod_update", fail)


def rebuilding_installer(monkeypatch, payload=b"rebuilt!", only=None):
    """An installer that rebuilds the mod (CRC-fixed bytes no file of the mod holds)."""
    real = mod_install.execute_mod_install

    def install(groups, output, *args, **kwargs):
        if only is not None and groups[0].files[0].mod_path.name != only:
            return real(groups, output, *args, **kwargs)
        for group in groups:
            # a mod for this game file, or one of an earlier release updated to the files there now
            for target in [file.existing_path for file in group.files if file.existing_path] or group.target_paths:
                target.write_bytes(CRCUtils.apply_crc_fix(header_bundle(payload), int(parse_filename(target.name).crc)))
        return mod_install.InstallResult()

    monkeypatch.setattr(mod_install, "execute_mod_install", install)


def test_an_off_keeps_built_copies_and_on_writes_them_back_without_the_installer(world, monkeypatch):
    atlas = game_bundle(world.game, part="002", payload=b"skeleton")
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    rebuilt = world.spr.read_bytes()
    world.toggle(False)
    built = world.folder()["built"]["test_spr"]
    sha1 = built["parts"][world.spr.name]["sha1"]
    assert built["source"] == f"mod:{mod.id}" and list(built["parts"]) == [world.spr.name]  # the modded part only
    assert built["parts"][world.spr.name]["mod_file"] is None
    assert (world.root / "built" / f"{sha1}.bundle").read_bytes() == rebuilt
    assert world.library.sizes("built")["builtSize"] == len(rebuilt)
    no_installer(monkeypatch)
    world.toggle(True)
    assert world.spr.read_bytes() == rebuilt and atlas.read_bytes() == header_bundle(b"skeleton")


def test_a_direct_mod_is_kept_as_its_own_file(world, monkeypatch):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    part = world.folder()["built"]["test_spr"]["parts"][world.spr.name]
    assert part["mod_file"] == world.spr.name and not (world.root / "built").exists()
    no_installer(monkeypatch)
    world.toggle(True)
    assert world.spr.read_bytes() == mod.file.read_bytes()


def test_an_adopted_crc_fixed_mod_comes_back_byte_identical(world, monkeypatch):
    world.consent = True
    keep_backup(world.spr)
    data = outside_mod(world.spr)
    world.toggle(False)
    no_installer(monkeypatch)
    world.toggle(True)
    assert world.spr.read_bytes() == data
    assert not (world.root / "built").exists()


def test_a_built_copy_whose_bytes_changed_is_dropped_and_rebuilt(world, monkeypatch):
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    rebuilt = world.spr.read_bytes()
    world.toggle(False)
    copy, = (world.root / "built").iterdir()
    copy.write_bytes(b"damaged copy")
    world.toggle(True)
    assert world.spr.read_bytes() == rebuilt
    assert "test_spr" not in world.folder()["built"] and not copy.exists()


def test_clear_built_mods_keeps_keys_of_mod_files(world, monkeypatch):
    lobby = game_bundle(world.game, "test_home", payload=b"lobby!!!")
    portrait, home = world.add(world.spr, fixed=True), world.add(lobby, payload=b"lobbymod")
    rebuilding_installer(monkeypatch, only=world.spr.name)
    world.library.apply("test", f"mod:{portrait.id}")
    world.library.apply("test", f"mod:{home.id}", kind="lobby")
    world.toggle(False)
    assert set(world.folder()["built"]) == {"test_spr", "test_home"}
    freed = world.library.clear_built()
    assert freed > 0 and (world.root / "built").is_dir()
    assert not list((world.root / "built").glob("*.bundle"))
    assert set(world.folder()["built"]) == {"test_home"}  # all its parts are files of its mod
    no_installer(monkeypatch)
    rebuilding_installer(monkeypatch, only=world.spr.name)
    world.toggle(True)
    assert lobby.read_bytes() == home.file.read_bytes()
    assert world.library.sizes("built")["builtSize"] == 0
    assert world.library.sizes("originals")["originalsSize"] > 0


def test_clear_built_mods_keeps_another_instances_copy_in_progress(world, monkeypatch):
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    directory = world.root / "built"
    (directory / "unreferenced.bundle").write_bytes(b"unreferenced")
    freed = sum(path.stat().st_size for path in directory.glob("*.bundle"))
    temporary = directory / ".library-in-progress"
    temporary.write_bytes(b"copy in progress")
    stale = directory / ".library-abandoned"
    stale.write_bytes(b"abandoned copy")
    stamp = time.time()
    os.utime(temporary, (stamp, stamp))
    os.utime(stale, (stamp - 3601, stamp - 3601))
    monkeypatch.setattr(service.time, "time", lambda: stamp)
    assert world.library.sizes("built")["builtSize"] == freed

    freed += stale.stat().st_size
    assert world.library.clear_built() == freed
    assert list(directory.iterdir()) == [temporary]
    assert temporary.read_bytes() == b"copy in progress"
    assert world.folder()["built"] == {}
    assert world.library.sizes("built")["builtSize"] == 0


# --- the record lookup at build: the install's own record, a moved install's, or a migration ---

def as_alpha3(world: World) -> None:
    """The library as alpha.3 left it: records without the new keys, and no profiles.json."""
    path = world.root / "state.json"
    data = json.loads(path.read_text())
    data["applied"] = {name: {k: v for k, v in record.items() if k in ("source", "sha1", "size", "mtime")}
                       for name, record in data["applied"].items()}
    path.write_text(json.dumps(data))
    for name in ("profiles.json", "profiles.json.prev"):
        (world.root / name).unlink(missing_ok=True)


def test_the_first_build_migrates_what_the_library_wrote(world):
    mod = world.add(world.spr, fixed=True)  # cheaply told from official: an older record has no flag
    world.library.apply("test", f"mod:{mod.id}")
    other = game_bundle(world.game, "other_spr", payload=b"other!!!")
    world.library.apply("other", "official")  # recorded official: nothing to configure
    as_alpha3(world)
    world.reload()
    folder = world.folder()
    assert set(folder["configured"]) == {"test_spr"}
    assert folder["configured"]["test_spr"]["source"] == f"mod:{mod.id}"
    assert folder["configured"]["test_spr"]["variant"] == "test" and list(folder["named_by"]) == ["A"]
    assert other.exists()
    world.toggle(False)  # existing users keep their mods through the first Off
    world.toggle(True)
    assert world.spr.read_bytes() == mod.file.read_bytes()


def test_an_empty_migration_writes_nothing(world):
    world.library.apply("test", "official")
    as_alpha3(world)
    world.reload()
    assert not (world.root / "profiles.json").exists()
    world.reload()
    assert not (world.root / "profiles.json").exists()


def test_a_missing_profiles_file_with_its_prev_is_read_not_migrated(world):
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    since = world.folder()["configured"]["test_spr"]["since"]
    data = world.profiles()
    data["kept"] = "from prev"
    (world.root / "profiles.json.prev").write_text(json.dumps(data))
    (world.root / "profiles.json").unlink()
    world.reload()
    config = world.library.profiles.read()
    assert config["kept"] == "from prev" and config["enabled"] is False
    assert config["folders"][world.key()]["configured"]["test_spr"] == {
        "variant": "test", "kind": "spr", "source": f"mod:{mod.id}", "since": since}  # not migrated again


def test_unreadable_profiles_migrate_nothing_and_write_nothing(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    (world.root / "profiles.json").write_text("{broken")
    (world.root / "profiles.json.prev").write_text("{broken too")
    world.reload()
    assert world.library.status()["reason"] == "profiles_unreadable"
    expect_error("profiles_unreadable", lambda: world.toggle(False))
    expect_error("profiles_unreadable", lambda: world.library.apply("test", "official"))
    assert (world.root / "profiles.json").read_text() == "{broken"


def test_the_root_and_its_resource_folder_are_one_install(world):
    nested = world.tmp / "steam" / "BlueArchive_Data" / "StreamingAssets" / "PUB" / "Resource" / "GameData" / "Windows"
    nested.mkdir(parents=True)
    assert install_root(nested) == (world.tmp / "steam").resolve()
    assert install_key(install_root(nested)) == install_key(install_root(world.tmp / "steam"))
    game_bundle(nested, "other_spr")
    world.settings.set("game_resource_dir", str(nested))
    pin = world.library.current_pin()
    assert pin.key == install_key((world.tmp / "steam").resolve()) and nested.resolve() in pin.dirs
    world.settings.set("game_resource_dir", str(world.tmp / "steam"))
    assert world.library.current_pin().key == pin.key


def move_install(world: World, target: Path) -> None:
    """The install's folder moves; the old one is gone while its parent stays."""
    shutil.move(str(world.game), str(target))
    world.settings.set("game_resource_dir", str(target))


def test_a_moved_install_takes_its_record_and_its_files_records(world, monkeypatch):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    old_key = world.key()
    moved = world.tmp / "moved"
    move_install(world, moved)

    def no_hashing(self, path):
        raise AssertionError(f"hashed {path}")

    monkeypatch.setattr(storage.Fingerprints, "get", no_hashing)
    world.reload()
    folders = world.profiles()["folders"]
    assert old_key not in folders and world.key(moved) in folders
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    new_file = moved.resolve() / world.spr.name
    assert str(new_file) in applied and str(world.spr.resolve()) not in applied
    monkeypatch.undo()
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    world.toggle(False)
    assert new_file.read_bytes() == OFFICIAL


def test_a_moved_install_matches_by_last_bytes_only_with_scan_consent(world):
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    moved = world.tmp / "moved"
    move_install(world, moved)
    new_file = moved / world.spr.name
    os_time = new_file.stat().st_mtime_ns + 5_000_000_000
    os.utime(new_file, ns=(os_time, os_time))  # a copy that kept the bytes, not the date
    world.reload()
    assert str(new_file.resolve()) not in json.loads((world.root / "state.json").read_text())["applied"]
    world.consent = True
    entry = world.entries()[(world.key(moved), "test_spr")]
    assert entry.state == "changed"  # configured, the file not the library's any more: offered for adoption


def test_a_moved_install_with_consent_is_rekeyed_by_its_last_bytes(world):
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    moved = world.tmp / "moved"
    move_install(world, moved)
    new_file = moved / world.spr.name
    later = new_file.stat().st_mtime_ns + 5_000_000_000
    os.utime(new_file, ns=(later, later))
    world.consent = True
    world.reload()
    record = json.loads((world.root / "state.json").read_text())["applied"][str(new_file.resolve())]
    assert record["source"] == f"mod:{mod.id}" and record["mtime"] == later


def test_an_unmounted_old_folder_is_never_taken_for_a_move(world):
    drive = world.tmp / "drive"
    game = drive / "game"
    shutil.move(str(world.game), str(game))
    world.settings.set("game_resource_dir", str(game))
    world.library = world.reload()
    mod = world.add(game / world.spr.name)
    world.library.apply("test", f"mod:{mod.id}")
    old_key = world.key(game)
    shutil.move(str(drive), str(world.tmp / "elsewhere"))  # the drive is gone: no parent
    second = world.tmp / "second"
    game_bundle(second)
    world.settings.set("game_resource_dir", str(second))
    world.reload()
    folders = world.profiles()["folders"]
    assert old_key in folders and world.key(second) not in folders


# --- drift: Steam checks, the game's repair, game updates ---

def game_update(path: Path, date: str = "2026-02-01", payload: bytes = b"updated!") -> Path:
    """A game update: the part comes back official under a new date and CRC, the old file is gone."""
    path.unlink()
    parsed = parse_filename(path.name)
    return game_bundle(path.parent, parsed.core, part=parsed.res_type, date=date, payload=payload)


def test_a_steam_check_resets_a_configured_entry_and_apply_brings_it_back(world, monkeypatch):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    since = world.folder()["configured"]["test_spr"]["since"]
    world.spr.write_bytes(OFFICIAL)  # verified: the official bytes are back
    entry = world.entries()[(world.key(), "test_spr")]
    assert (entry.state, entry.source, entry.configured) == ("reset", "official", f"mod:{mod.id}")
    result = world.library.restore_drift([{"install": world.key(), "core": "test_spr", "state": "reset"}])
    assert [item["core"] for item in result.done] == ["test_spr"]
    assert world.spr.read_bytes() == mod.file.read_bytes()
    assert world.folder()["configured"]["test_spr"]["since"] == since
    assert world.entries()[(world.key(), "test_spr")].state == "ok"


def test_a_game_update_makes_a_configured_entry_updated(world, monkeypatch):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    successor = game_update(world.spr)
    # before the prune: the gone record and its later-dated successor
    assert world.entries()[(world.key(), "test_spr")].state == "updated"
    world.reload()  # the next start prunes: the outdated original goes, the marker stays
    world.library.prune()
    assert not world.original(world.spr).exists()
    assert world.folder()["updated"].get("test_spr")
    assert world.entries()[(world.key(), "test_spr")].state == "updated"
    rebuilding_installer(monkeypatch)
    monkeypatch.setattr(mod_install, "_asset_match", lambda sources, candidates, log: (candidates, ""))
    result = world.library.restore_drift([{"install": world.key(), "core": "test_spr", "state": "updated"}])
    assert [item["core"] for item in result.done] == ["test_spr"], result
    assert "test_spr" not in world.folder()["updated"]
    assert world.entries()[(world.key(), "test_spr")].state == "ok"
    assert successor.read_bytes() != header_bundle(b"updated!")


def test_one_repaired_part_of_two_is_a_reset_not_ok(world):
    world.consent = True
    parts = [game_bundle(world.game, "test_home", part=part, payload=part.encode() * 3) for part in ("002", "003")]
    official = {part: part.read_bytes() for part in parts}
    mod, = world.library.add([make_mod(part, world.tmp / "pack", payload=b"mod" + part.name[-30:].encode()[:3],
                                       fixed=True) for part in parts])
    world.library.apply("test", f"mod:{mod.id}", kind="lobby")
    parts[0].write_bytes(official[parts[0]])
    entry = world.entries()[(world.key(), "test_home")]
    assert (entry.state, entry.source) == ("reset", f"mod:{mod.id}")
    world.library.restore_drift([{"install": world.key(), "core": "test_home", "state": "reset"}])
    assert all(part.read_bytes() != official[part] for part in parts)  # the whole core again


def test_a_game_update_of_a_part_the_mod_left_official_keeps_it_ok(world):
    world.consent = True
    atlas = game_bundle(world.game, part="002", payload=b"skeleton")
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    game_update(atlas, payload=b"skeleton2")
    assert world.entries()[(world.key(), "test_spr")].state == "ok"
    world.reload()
    world.library.prune()
    assert world.folder()["updated"] == {}
    assert world.entries()[(world.key(), "test_spr")].state == "ok"


def test_an_older_record_whose_size_is_not_the_official_one_counts_as_drifted(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    as_alpha3(world)
    world.reload()  # migrated: configured with the mod
    world.spr.write_bytes(OFFICIAL)  # verified
    assert world.entries()[(world.key(), "test_spr")].state == "reset"


def test_an_on_cut_short_is_pending_never_drift(world, monkeypatch):
    world.consent = True
    cores = ["test_spr", "other_spr", "third_spr"]
    world.catalog.variants["third"] = FakeVariant("third", "third_spr", family="third")
    files = {core: world.spr if core == "test_spr" else game_bundle(world.game, core) for core in cores}
    mods = {core: world.add(files[core], fixed=True, where=core) for core in cores}
    for core in cores:
        world.library.apply(core.removesuffix("_spr"), f"mod:{mods[core].id}")
    world.toggle(False)
    calls = []
    real = service.ModLibrary._switch

    def cut(self, pin, core, source, *args, **kwargs):
        calls.append(core)
        if len(calls) > 1:
            raise KeyboardInterrupt  # the app quit while the On ran
        return real(self, pin, core, source, *args, **kwargs)

    monkeypatch.setattr(service.ModLibrary, "_switch", cut)
    with pytest.raises(KeyboardInterrupt):
        world.toggle(True)
    monkeypatch.undo()
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    states = {core: world.entries()[(world.key(), core)].state for core in cores}
    assert sorted(states.values()) == ["ok", "pending", "pending"]
    listed = {(item["core"], item["why"]) for item in world.unfinished()}
    assert {core for core, state in states.items() if state == "pending"} <= {core for core, _ in listed}
    assert world.library.intent()["enabled"] is True


# --- one switch for every game folder ---

def japan(world: World, *cores: str) -> Path:
    folder = world.tmp / "japan"
    for core in cores or ("test_spr",):
        game_bundle(folder, core)
    world.settings.set("game_resource_dir_japan", str(folder))
    return folder


def pin_of(world: World, folder: Path):
    return next(pin for pin in world.library.installs() if pin.key == world.key(folder))


def test_one_off_reverts_every_game_folder_and_one_on_applies_them(world):
    folder = japan(world)
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.apply("test", f"mod:{mod.id}", pin=pin_of(world, folder))
    other_file = folder / world.spr.name
    assert other_file.read_bytes() == mod.file.read_bytes()
    world.toggle(False)
    assert world.spr.read_bytes() == OFFICIAL and other_file.read_bytes() == OFFICIAL
    world.toggle(True)
    assert world.spr.read_bytes() == mod.file.read_bytes() == other_file.read_bytes()
    assert [pin.server for pin in world.library.installs()] == ["global", "japan"]


def test_a_core_only_another_install_has_is_adopted_reverted_and_brought_back(world):
    world.consent = True
    folder = japan(world, "ch9999_spr")
    newcomer = next(folder.glob("*ch9999_spr*"))
    keep_backup(newcomer)
    data = outside_mod(newcomer)
    assert world.library.catalog.variant_for_core("ch9999_spr") is None
    entry = world.entries()[(world.key(folder), "ch9999_spr")]
    assert (entry.state, entry.variant) == ("untracked", "ch9999")
    world.toggle(False)
    assert newcomer.read_bytes() == OFFICIAL
    mod, = world.library.mods()
    assert mod.target == "ch9999"
    world.toggle(True)
    assert newcomer.read_bytes() == data


def test_another_installs_variant_source_stays_configured_and_is_applied_from_there(world, monkeypatch):
    folder = japan(world, "test_spr", "ch9999_spr")
    pin = pin_of(world, folder)
    calls = []

    def update(sources, targets, output, *args, **kwargs):
        calls.append([source.name for source in sources])
        result = output / targets[0].name
        result.write_bytes(CRCUtils.apply_crc_fix(header_bundle(b"adapted!"), int(parse_filename(targets[0].name).crc)))
        return ModUpdateResult(True, "updated", [FilePair(result, targets[0])])

    monkeypatch.setattr("ba_modding_toolkit.library.service.adapt_variant_sources", lambda sources, *args: sources)
    monkeypatch.setattr(core, "process_mod_update", update)
    # configured there by an earlier build, with a variant the current catalog lacks
    world.library.profiles.update(lambda data: data["folders"].setdefault(pin.key, {"server": "japan"}).update(
        configured={"test_spr": {"variant": "test", "kind": "spr", "source": "variant:ch9999", "since": "2026-01-01"}}))
    world.toggle(False)
    world.toggle(True)
    assert calls and calls[-1] == [next(folder.glob("*ch9999_spr*")).name]
    assert world.library.profiles.read()["folders"][pin.key]["configured"]["test_spr"]["source"] == "variant:ch9999"


# --- the unfinished list: the red dot and Retry without a scan ---

def three_mods(world: World) -> dict:
    world.catalog.variants["third"] = FakeVariant("third", "third_spr", family="third")
    files = {"test_spr": world.spr, "other_spr": game_bundle(world.game, "other_spr"),
             "third_spr": game_bundle(world.game, "third_spr")}
    for core, path in files.items():
        mod = world.add(path, fixed=True, where=core)
        world.library.apply(core.removesuffix("_spr"), f"mod:{mod.id}")
    return files


def crash_after(monkeypatch, count: int) -> None:
    calls = []
    real = service.ModLibrary._switch

    def cut(self, *args, **kwargs):
        calls.append(args)
        if len(calls) > count:
            raise KeyboardInterrupt
        return real(self, *args, **kwargs)

    monkeypatch.setattr(service.ModLibrary, "_switch", cut)


def test_a_crash_without_consent_leaves_the_rest_listed(world, monkeypatch):
    files = three_mods(world)
    crash_after(monkeypatch, 1)
    with pytest.raises(KeyboardInterrupt):
        world.toggle(False)
    listed = {item["core"]: item["why"] for item in world.unfinished()}
    assert set(listed) == set(files) and set(listed.values()) == {"pending"}
    assert world.library.intent() == {"enabled": False, "toggled": world.profiles()["toggled"],
                                      "unfinished": {"pending": 3, "left": 0, "stuck": 0}}
    monkeypatch.undo()
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    world.reload()
    assert world.library.judge_unfinished() == 1  # the one switched before the crash holds the intent
    world.library.toggle(False, False)  # Retry
    assert world.unfinished() == [] and all(parse_filename(path.name).crc and path.read_bytes() == OFFICIAL
                                            for path in files.values())


def test_a_repaired_stuck_entry_leaves_the_list_without_reading_other_files(world, monkeypatch):
    world.consent = True
    other = game_bundle(world.game, "other_spr")
    keep_backup(other)
    outside_mod(world.spr)  # no official copy: stuck after the Off
    world.toggle(False)
    assert world.unfinished() == [{"install": world.key(), "core": "test_spr", "why": "stuck"}]
    world.consent = False
    outside_mod(other)  # never recorded
    world.spr.write_bytes(OFFICIAL)  # the user's repair
    read = []
    real = storage.trailing_bytes

    def record(path):
        read.append(Path(path).name)
        return real(path)

    monkeypatch.setattr(service, "trailing_bytes", record)
    world.reload()
    assert world.library.judge_unfinished() == 1
    assert world.unfinished() == [] and other.name not in read


def test_the_judging_drops_nothing_when_another_instance_switched_meanwhile(world, monkeypatch):
    files = three_mods(world)

    def crash(self, outcomes):
        raise KeyboardInterrupt

    monkeypatch.setattr(service.ModLibrary, "_save_outcomes", crash)
    with pytest.raises(KeyboardInterrupt):
        world.toggle(False)  # switched all three, the list not saved yet
    monkeypatch.undo()
    assert len(world.unfinished()) == len(files)
    real = Profiles.update

    def meanwhile(self, change, after=None):
        # another instance saves a new intent between the judging and its update
        real(Profiles(world.root), lambda data: data.update(enabled=True, toggled="later"))
        return real(self, change, after=after)

    monkeypatch.setattr(Profiles, "update", meanwhile)
    assert world.library.judge_unfinished() == 0
    monkeypatch.setattr(Profiles, "update", real)
    assert len(world.unfinished()) == len(files)


def test_a_left_entry_leaves_once_an_on_finds_it_changed(world, monkeypatch):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    outside_mod(world.spr)  # changed outside the library; no consent: found when the Off reaches it
    monkeypatch.setattr(service.shutil, "disk_usage", lambda path: SimpleNamespace(free=0))
    result = world.toggle(False)
    assert [item["core"] for item in result.left] == ["test_spr"]
    assert world.unfinished() == [{"install": world.key(), "core": "test_spr", "why": "left"}]
    assert world.library.intent()["unfinished"]["left"] == 1
    result = world.toggle(True)
    assert result.skipped == [{"install": world.key(), "core": "test_spr", "variant": "test", "kind": "spr",
                               "why": "changed"}]
    assert world.unfinished() == []


def test_a_stuck_item_stays_stuck_across_a_crash(world, monkeypatch):
    world.consent = True
    outside_mod(world.spr)
    world.toggle(False)
    assert world.unfinished() == [{"install": world.key(), "core": "test_spr", "why": "stuck"}]

    def crash(self, *args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(service.ModLibrary, "_reach", crash)
    with pytest.raises(KeyboardInterrupt):
        world.library.toggle(False, False)  # a Retry of the Off, cut short after its intent was saved
    assert world.unfinished() == [{"install": world.key(), "core": "test_spr", "why": "stuck"}]
    assert world.library.intent()["unfinished"] == {"pending": 0, "left": 0, "stuck": 1}


def test_a_toggle_never_replaces_the_list(world):
    world.library.profiles.update(lambda data: data["unfinished"].append(
        {"install": "/another/data/directory/game", "core": "test_spr", "why": "pending"}))
    world.toggle(False)
    world.toggle(True)
    assert world.unfinished() == [{"install": "/another/data/directory/game", "core": "test_spr", "why": "pending"}]
    assert world.library.intent()["unfinished"] == {"pending": 0, "left": 0, "stuck": 0}  # not a known install


def test_an_on_reaches_removed_parts(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.profiles.update(lambda data: data.update(enabled=False))  # an Off that never reached it
    world.library._write_check = lambda pin: (_ for _ in ()).throw(ServiceError("classic_open"))
    assert world.library.remove(mod.id).failed[0]["code"] == "classic_open"
    world.library._write_check = None
    assert world.folder()["configured"] == {} and world.spr.read_bytes() != OFFICIAL
    result = world.library.toggle(True, False)  # no configuration, a part carrying the removed mod
    assert [item["core"] for item in result.done] == ["test_spr"] and world.spr.read_bytes() == OFFICIAL


def second_directory(world: World, folder: Path | None = None) -> ModLibrary:
    """Another data directory sharing the library (data id B), its settings naming another game folder."""
    settings = Settings(world.tmp / "config-b.toml")
    settings.set("enable_crc_correction", "false")
    settings.set("compression_method", "none")
    other = folder or world.tmp / "b-game"
    if not other.exists():
        game_bundle(other, "other_spr")
    settings.set("game_resource_dir", str(other))
    return world.build("B", settings)


def test_another_data_directory_only_hides_an_install_it_does_not_name(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    b = second_directory(world)
    assert world.key() in [pin.key for pin in b.installs()]  # recorded, its folder there
    b.forget(world.key())
    assert world.folder()["hidden"] == ["B"] and world.folder()["configured"]["test_spr"]
    assert world.key() not in [pin.key for pin in b.installs()]
    world.toggle(False)  # A still switches it
    assert world.spr.read_bytes() == OFFICIAL
    expect_error("bad_params", lambda: world.library.forget(world.key()))  # A's settings name it


def test_a_forget_by_the_last_data_directory_naming_it_drops_the_record(world, original_cloning):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    b = second_directory(world)
    b.forget(world.key())
    elsewhere = world.tmp / "a-elsewhere"
    game_bundle(elsewhere, "other_spr")
    world.settings.set("game_resource_dir", str(elsewhere))
    old = world.key(world.game)
    world.reload()  # A no longer names it: its id leaves named_by
    assert "A" not in world.profiles()["folders"][old]["named_by"]
    assert world.folder(world.game)["built"]
    world.library.forget(old)
    assert old not in world.profiles()["folders"]
    assert json.loads((world.root / "state.json").read_text())["applied"]  # the history stays
    assert world.original(world.spr).exists() == original_cloning  # forget preserves any retained clone
    assert world.spr.read_bytes() == OFFICIAL


def test_naming_a_hidden_install_again_shows_it_again(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    b = second_directory(world)
    b.forget(world.key())
    b = second_directory(world, world.game)  # B's settings name it now
    assert world.folder()["hidden"] == [] and "B" in world.folder()["named_by"]
    assert world.key() in [pin.key for pin in b.installs()]


def test_a_toggle_where_an_install_is_hidden_lists_it_for_the_directory_naming_it(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.profiles.update(lambda data: data["unfinished"].append(
        {"install": world.key(), "core": "own_spr", "why": "stuck"}))
    b = second_directory(world)
    b.forget(world.key())
    b.toggle(False, True)  # no scan consent
    assert world.spr.read_bytes() == mod.file.read_bytes()  # B writes nothing there
    listed = {(item["core"], item["why"]) for item in world.unfinished() if item["install"] == world.key()}
    assert listed == {("test_spr", "pending"), ("own_spr", "stuck")}
    assert world.library.intent()["enabled"] is False
    assert world.library.intent()["unfinished"] == {"pending": 1, "left": 0, "stuck": 1}
    world.library.toggle(False, False)  # A's Retry
    assert world.spr.read_bytes() == OFFICIAL
    assert {item["core"] for item in world.unfinished()} == {"own_spr"}


def test_the_first_record_names_its_data_directory_before_any_rebuild(world):
    fresh = world.tmp / "fresh"
    game_bundle(fresh)
    world.settings.set("game_resource_dir", str(fresh))
    assert not (world.root / "profiles.json").exists()
    mod = world.add(fresh / world.spr.name)
    world.library.apply("test", f"mod:{mod.id}")
    assert list(world.folder(fresh)["named_by"]) == ["A"]
    b = second_directory(world)
    b.forget(world.key(fresh))
    assert world.folder(fresh)["configured"]["test_spr"] and world.folder(fresh)["hidden"] == ["B"]


def test_a_build_never_writes_a_record_holding_only_named_by(world):
    world.reload()
    world.reload()
    assert not (world.root / "profiles.json").exists()


# --- take-over ---

def test_a_newer_library_write_takes_over_an_older_one_does_not(world):
    world.consent = True
    first, second = world.add(world.spr, fixed=True), world.add(world.spr, b"second!!", fixed=True, where="b")
    world.library.apply("test", f"mod:{first.id}")
    # an alpha.3 instance switched it after (no configuration change in profiles.json)
    alpha3 = ModLibrary(world.root, world.catalog, None, world.settings)
    alpha3._switch(world.library.current_pin(), "test_spr", f"mod:{second.id}")
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "ok" and entry.configured == f"mod:{second.id}"
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{second.id}"
    # written before the configuration's since: pending, never taken over
    world.library.apply("test", f"mod:{first.id}")
    path = world.root / "state.json"
    data = json.loads(path.read_text())
    data["applied"][str(world.spr.resolve())]["at"] = "2000-01-01T00:00:00+00:00"
    data["applied"][str(world.spr.resolve())]["source"] = f"mod:{second.id}"
    data["applied"][str(world.spr.resolve())]["sha1"] = storage.Fingerprints().get(world.spr).sha1
    path.write_text(json.dumps(data))
    world.reload()
    assert world.entries()[(world.key(), "test_spr")].state == "pending"


def test_a_library_source_without_configuration_is_taken_over_once(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.profiles.update(lambda data: data["folders"][world.key()]["configured"].clear())
    assert world.entries()[(world.key(), "test_spr")].state == "ok"
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{mod.id}"
    since = world.folder()["configured"]["test_spr"]["since"]
    world.entries()
    assert world.folder()["configured"]["test_spr"]["since"] == since


def test_a_record_without_a_write_time_uses_its_date(world):
    from ba_modding_toolkit.library.judge import seconds
    assert seconds(1_700_000_000_000_000_000) == 1_700_000_000.0
    assert seconds("2026-01-01T00:00:00+00:00") == 1767225600.0 and seconds(None) is None


# --- removing mods, sources gone from the library ---

def test_removing_a_configured_mod_no_file_carries_drops_its_configuration_and_built_copies(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    assert world.folder()["built"]["test_spr"]
    world.library.remove(mod.id)
    assert world.folder()["configured"] == {} and world.folder()["built"] == {}
    assert world.library.mods() == []


def test_deleting_an_overwritten_mod_leaves_a_restore_pending(world):
    world.consent = True
    data = outside_mod(world.spr)  # no official copy anywhere: the Off leaves it stuck
    world.toggle(False)
    mod, = world.library.mods()
    result = world.library.remove(mod.id, confirm=True)
    assert result.failed[0]["code"] == "original_unavailable"
    assert world.library.mods() == [] and world.spr.read_bytes() == data  # the game file is never touched
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    assert applied[str(world.spr.resolve())]["removed"] is True
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.source == "removed" and entry.state == "pending"
    result = world.library.toggle(False, False)  # the next Off neither adopts nor prompts it
    assert result.adopted == [] and world.library.mods() == []


def test_deleting_a_mod_restores_a_previously_recorded_folder(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.profiles.update(lambda data: data["folders"].clear())
    elsewhere = world.tmp / "elsewhere"
    game_bundle(elsewhere, "other_spr")
    world.settings.set("game_resource_dir", str(elsewhere))
    result = world.library.remove(mod.id)
    assert result.failed == [] and world.spr.read_bytes() == OFFICIAL


def test_deleting_an_applied_mod_covers_every_install(world):
    folder = japan(world)
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}", pin=pin_of(world, folder))
    world.library.apply("test", f"mod:{mod.id}")
    result = world.library.remove(mod.id)
    assert len(result.done) == 2 and result.failed == []
    assert world.spr.read_bytes() == OFFICIAL


def test_a_mod_deleted_by_hand_is_offered_for_adoption_without_a_loop(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    data = json.loads((world.root / "state.json").read_text())
    data["mods"] = []
    (world.root / "state.json").write_text(json.dumps(data))
    shutil.rmtree(world.root / "mods" / mod.id)
    world.reload()
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "changed" and entry.source == "unknown"  # its bytes, not lost
    world.toggle(False)
    adopted, = world.library.mods()
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{adopted.id}"
    world.toggle(True)
    assert world.entries()[(world.key(), "test_spr")].state == "ok"


def test_a_source_gone_from_the_library_is_listed_once_then_dropped(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    data = json.loads((world.root / "state.json").read_text())
    data["mods"] = []
    (world.root / "state.json").write_text(json.dumps(data))
    world.reload()
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "source_missing"
    assert world.folder()["configured"] == {}
    assert (world.key(), "test_spr") not in world.entries()


def test_a_variant_record_without_its_core_there_is_unknown_and_adopted(world, monkeypatch):
    world.consent = True
    keep_backup(world.spr)
    other = game_bundle(world.game, "other_spr", payload=b"other!!!")
    swap = CRCUtils.apply_crc_fix(header_bundle(b"swapped!"), int(parse_filename(world.spr.name).crc))

    def update(sources, targets, output, *args, **kwargs):
        result = output / targets[0].name
        result.write_bytes(swap)
        return ModUpdateResult(True, "updated", [FilePair(result, targets[0])])

    monkeypatch.setattr("ba_modding_toolkit.library.service.adapt_variant_sources", lambda sources, *args: sources)
    monkeypatch.setattr(core, "process_mod_update", update)
    world.library.apply("test", "variant:other")
    other.unlink()  # that variant's portrait is gone from this install
    world.reload()
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "changed" and entry.source == "unknown"
    world.toggle(False)
    assert world.spr.read_bytes() == OFFICIAL
    assert any(m.file.read_bytes() == swap for m in world.library.mods())


def test_a_restore_while_off_writes_official_over_a_pending_entry(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.profiles.update(lambda data: data.update(enabled=False))  # an Off cut short
    assert world.library.would_write("test", "official")
    world.library.restore("test")
    assert world.spr.read_bytes() == OFFICIAL and world.folder()["configured"] == {}
    assert not world.library.would_write("test", "official")


def test_missing_entries_are_skipped_and_not_counted(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    world.spr.unlink()  # a renamed core: no game files any more
    result = world.toggle(True)
    assert result.skipped == [{"install": world.key(), "core": "test_spr", "variant": "test", "kind": "spr",
                               "why": "missing"}]
    assert world.unfinished() == []


def test_every_lobby_core_is_an_entry_of_its_own(world):
    world.consent = True
    world.catalog.variants["test"].lobby = "test_home"
    home, home_gl = game_bundle(world.game, "test_home", payload=b"home!!!!"), \
        game_bundle(world.game, "test_home_gl", payload=b"homegl!!")
    for path in (home, home_gl):
        keep_backup(path, path.read_bytes())
        outside_mod(path)
    entries = world.entries()
    assert {key[1] for key, entry in entries.items() if entry.state == "untracked"} == {"test_home", "test_home_gl"}
    assert entries[(world.key(), "test_home_gl")].variant == "test"
    world.toggle(False)
    assert home.read_bytes() == header_bundle(b"home!!!!") and home_gl.read_bytes() == header_bundle(b"homegl!!")
    mods = world.library.mods()
    assert sorted(m.core for m in mods) == ["test_home", "test_home_gl"]


def test_a_lobby_mod_previews_with_its_own_cores_official_parts(world):
    world.catalog.variants["test"].lobby = "test_home_gl"
    game_bundle(world.game, "test_home", part="002", payload=b"homeskel")
    gl_skeleton = game_bundle(world.game, "test_home_gl", part="002", payload=b"gl skel!")
    gl_texture = game_bundle(world.game, "test_home_gl", part="003", payload=b"gl tex!!")
    mod, = world.library.add([make_mod(gl_texture, world.tmp / "gl")])
    world.catalog.variants["test"].lobby = "test_home"  # the variant's primary lobby core is another one
    assert mod.core == "test_home_gl"
    assert world.library.preview_bundles(mod.id) == [gl_skeleton, mod.file]


# --- what reads game files ---

def forbid_full_reads(monkeypatch, *folders: Path) -> list[Path]:
    """Whole-file reads (hashing) of files under the given folders raise; returns the paths read in full."""
    real = storage.Fingerprints.get
    read: list[Path] = []

    def get(self, path):
        resolved = Path(path).resolve()
        if any(resolved.is_relative_to(folder.resolve()) for folder in folders):
            read.append(resolved)
            raise AssertionError(f"read in full: {resolved}")
        return real(self, path)

    monkeypatch.setattr(storage.Fingerprints, "get", get)
    return read


def record_headers(monkeypatch) -> list[str]:
    read: list[str] = []
    real = storage.trailing_bytes

    def trailing(path):
        read.append(Path(path).name)
        return real(path)

    monkeypatch.setattr(service, "trailing_bytes", trailing)
    return read


def test_the_scan_and_the_detail_screen_read_no_game_file_in_full(world, monkeypatch):
    world.consent = True
    atlas = game_bundle(world.game, part="002", payload=b"skeleton")
    keep_backup(atlas, atlas.read_bytes())
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    outside_mod(atlas)
    forbid_full_reads(monkeypatch, world.game)
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "changed"
    state = world.library.state("test")
    assert {file.file.name: file.applied for file in state.files} == {atlas.name: "unknown",
                                                                     world.spr.name: f"mod:{mod.id}"}
    assert world.library.modified() == {"test": "unknown"}
    world.library.prune()


def test_without_consent_modified_reads_no_header_of_a_file_the_library_did_not_write(world, monkeypatch):
    other = game_bundle(world.game, "other_spr", payload=b"other!!!")
    outside_mod(other)
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    read = record_headers(monkeypatch)
    assert world.library.modified() == {"test": f"mod:{mod.id}"}
    assert other.name not in read
    world.consent = True
    assert world.library.modified() == {"test": f"mod:{mod.id}", "other": "unknown"}
    world.consent = False
    expect_error("scan_off", world.library.scan)


def test_an_older_record_takes_its_official_flag_from_the_header(world):
    world.consent = True
    atlas = game_bundle(world.game, part="002", payload=b"skeleton")
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    as_alpha3(world)
    world.reload()
    assert world.library.modified() == {"test": f"mod:{mod.id}"}  # the skeleton part adds nothing
    state = {file.file.name: file for file in world.library.state("test").files}
    assert state[atlas.name].official and not state[world.spr.name].official


def test_needs_fix_comes_from_the_record_of_the_switch_that_wrote_the_file(world, monkeypatch):
    mod = world.add(world.spr, payload=b"needsfix", fixed=False)
    world.library.apply("test", f"mod:{mod.id}")
    forbid_full_reads(monkeypatch, world.game)
    library = world.reload()  # a restart
    assert library.state("test").crc == "needs_fix"
    # copied in by hand, no record: judged by its header only
    world.spr.write_bytes(header_bundle(b"by hand!"))
    assert library.state("test").crc == "ok"
    outside_mod(world.spr)
    assert library.state("test").crc == "fixed"


def test_a_record_without_trailing_bytes_matches_by_size_and_date_only(world):
    world.consent = True
    mod = world.add(world.spr, payload=b"longer unfixed mod")  # another size than the official file
    world.library.apply("test", f"mod:{mod.id}")
    later = world.spr.stat().st_mtime_ns + 5_000_000_000
    os.utime(world.spr, ns=(later, later))  # the same bytes, a new date
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "changed"  # rule 3: the official size of its name says unknown
    result = world.toggle(False)  # reached: the full judgement finds the record's sha1
    assert result.adopted == [] and [item["core"] for item in result.done] == ["test_spr"]
    assert len(world.library.mods()) == 1


def test_a_steam_check_over_an_unfixed_mod_of_the_official_size_is_a_reset(world):
    world.consent = True
    mod = world.add(world.spr)  # no trailing bytes, the official size
    world.library.apply("test", f"mod:{mod.id}")
    world.spr.write_bytes(OFFICIAL)
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "reset"
    world.library.remove(mod.id)  # the game no longer shows it


def test_a_file_of_another_size_without_trailing_bytes_is_unknown(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.spr.write_bytes(header_bundle(b"another size"))
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "changed"
    world.library.restore("test")
    other = game_bundle(world.game, "other_spr")
    other.write_bytes(header_bundle(b"not known"))  # no kept original, no record: official by the cheap rule
    assert (world.key(), "other_spr") not in world.entries()


def test_an_unfixed_outside_write_of_the_official_size_is_caught_when_reached(world, monkeypatch):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.spr.write_bytes(header_bundle(b"outside!"))  # no CRC fix, no trailing bytes, the official size
    entry = world.entries()[(world.key(), "test_spr")]
    assert entry.state == "reset"  # judged cheaply: official, changed since written
    result = world.library.toggle(True, True)  # a Retry of the On
    assert result.skipped and result.skipped[0]["why"] == "changed"  # an On never overwrites it
    assert world.spr.read_bytes() == header_bundle(b"outside!")
    result = world.toggle(False)
    assert [item["core"] for item in result.adopted] == ["test_spr"]
    assert world.spr.read_bytes() == OFFICIAL
    assert any(m.file.read_bytes() == header_bundle(b"outside!") for m in world.library.mods())


def test_an_entry_changed_after_the_scan_is_judged_again_when_reached(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    assert world.entries()[(world.key(), "test_spr")].state == "ok"
    data = outside_mod(world.spr)  # after the last scan
    result = world.toggle(True)
    assert result.skipped[0]["why"] == "changed" and world.spr.read_bytes() == data


def test_the_prune_reads_no_game_file_contents(world, monkeypatch):
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    successor = game_update(world.spr)
    outside_mod(successor)  # a modded successor counts by its name and date
    forbid_full_reads(monkeypatch, world.game)
    read = record_headers(monkeypatch)
    world.reload()
    assert world.library.prune() == [world.original(world.spr)]
    assert read == []


# --- official copies ---

def test_an_official_copy_from_a_backup_is_kept_without_its_suffix(world):
    keep_backup(world.spr)
    outside_mod(world.spr)
    mod = world.add(world.spr, payload=b"libmod!!", fixed=True, where="lib")
    world.library.apply("test", f"mod:{mod.id}")
    assert world.original(world.spr).read_bytes() == OFFICIAL
    assert world.spr.with_name(world.spr.name + ".backup").exists()  # never written or deleted


def test_a_modded_backup_is_never_an_official_copy(world):
    keep_backup(world.spr, header_bundle(b"modded backup"))
    outside_mod(world.spr)
    mod = world.add(world.spr, payload=b"libmod!!", fixed=True, where="lib")
    expect_error("original_unavailable", lambda: world.library.apply("test", f"mod:{mod.id}"))


def test_an_official_copy_from_another_folder(world):
    folder = japan(world)
    outside_mod(world.spr)
    mod = world.add(world.spr, payload=b"libmod!!", fixed=True, where="lib")
    world.library.apply("test", f"mod:{mod.id}")
    assert world.original(world.spr).read_bytes() == OFFICIAL == (folder / world.spr.name).read_bytes()


def test_the_official_flag_compares_the_written_bytes_with_the_official_copy(world, monkeypatch):
    atlas = game_bundle(world.game, part="002", payload=b"skeleton")
    pack, = world.library.add([make_mod(path, world.tmp / "pack", payload=b"pack " + path.name[-12:-7].encode())
                               for path in (atlas, world.spr)])

    def install(groups, output, *args, **kwargs):  # the installer changes the staged copies in place
        for group in groups:
            for file in group.files:
                if file.existing_path.name == atlas.name:
                    continue  # this part left official
                file.existing_path.write_bytes(header_bundle(b"in place"))
        return mod_install.InstallResult()

    monkeypatch.setattr(mod_install, "execute_mod_install", install)
    world.library.apply("test", f"mod:{pack.id}")
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    assert applied[str(atlas.resolve())]["official"] is True
    assert applied[str(world.spr.resolve())]["official"] is False


def test_an_overwritten_entry_switched_to_what_it_carries_records_it_as_not_official(world):
    world.consent = True
    outside_mod(world.spr)
    world.toggle(False)  # adopted, left stuck: no official copy anywhere
    mod, = world.library.mods()
    files = world.library._switch(world.library.current_pin(), "test_spr", f"mod:{mod.id}")  # from its built copy
    assert files == []
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    assert applied[str(world.spr.resolve())]["official"] is False


# --- kept originals after failures and releases ---

def lock_game_file(monkeypatch, path: Path) -> None:
    real = service.atomic_copy
    clone = service.atomic_clone
    move = service.verified_move

    def copy(source, target):
        if Path(target) == path:
            raise PermissionError(13, "Locked", str(target))
        return real(source, target)

    monkeypatch.setattr(service, "atomic_copy", copy)

    def clone_locked(source, target):
        if Path(target) == path:
            raise PermissionError(13, "Locked", str(target))
        return clone(source, target)

    def move_locked(source, target, sha1):
        if path in (Path(source), Path(target)):
            raise PermissionError(13, "Locked", str(target))
        return move(source, target, sha1)

    monkeypatch.setattr(service, "atomic_clone", clone_locked)
    monkeypatch.setattr(service, "verified_move", move_locked)


def test_a_failed_apply_releases_the_original_it_kept_with_no_read(world, monkeypatch, original_cloning):
    mod = world.add(world.spr, fixed=True)
    lock_game_file(monkeypatch, world.spr)
    expect_error("game_file_locked", lambda: world.library.apply("test", f"mod:{mod.id}"))
    assert not world.original(world.spr).exists()
    assert world.spr.read_bytes() == OFFICIAL
    assert world.library.configured("test")["spr"] is None


def test_a_failed_on_of_a_configured_entry_keeps_its_original(world, monkeypatch, original_cloning):
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    assert world.original(world.spr).exists() == original_cloning
    assert world.spr.read_bytes() == OFFICIAL
    lock_game_file(monkeypatch, world.spr)
    result = world.toggle(True)
    assert result.failed[0]["code"] == "game_file_locked"
    assert world.original(world.spr).exists() == original_cloning
    assert world.spr.read_bytes() == OFFICIAL
    assert world.unfinished() == [{"install": world.key(), "core": "test_spr", "why": "pending"}]


def test_configured_originals_stay_available_after_off_and_release_with_configuration(world, monkeypatch,
                                                                                     original_cloning):
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    world.reload()
    world.library.prune()
    assert world.original(world.spr).exists() == original_cloning
    assert world.spr.read_bytes() == OFFICIAL
    forbid_full_reads(monkeypatch, world.game)
    world.library.prune()  # judged by stat: no read
    monkeypatch.undo()
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    world.library.restore("test")
    assert not world.original(world.spr).exists()
    assert world.spr.read_bytes() == OFFICIAL


def test_a_part_the_configured_source_leaves_official_releases_its_original(world):
    atlas = game_bundle(world.game, part="002", payload=b"skeleton")
    pack, = world.library.add([make_mod(path, world.tmp / "pack", payload=b"pack" + path.name[-14:-10].encode(),
                                        fixed=True) for path in (atlas, world.spr)])
    texture = world.add(world.spr, payload=b"texture!", fixed=True, where="texture")
    world.library.apply("test", f"mod:{pack.id}")
    world.library.apply("test", f"mod:{texture.id}")
    assert not world.original(atlas).exists() and world.original(world.spr).exists()
    game_update(atlas, payload=b"skelnew!")
    world.reload()
    world.library.prune()
    assert world.folder()["updated"] == {}
    world.toggle(False)
    world.toggle(True)
    assert not world.original(atlas).exists()


# --- the table of entry states ---

STATES = [
    # enabled, configured, carried, extra, expected
    (True, "mod:a", "mod:a", {}, "ok"),
    (True, None, "official", {}, "ok"),
    (False, "mod:a", "official", {}, "ok"),
    (False, None, "official", {}, "ok"),
    (True, "mod:a", "official", {}, "pending"),
    (True, "mod:a", "official", {"drifted_present": True}, "reset"),
    (True, "mod:a", "mod:a", {"drifted_present": True}, "reset"),
    (True, "mod:a", "official", {"drifted_gone": True}, "updated"),
    (True, "mod:a", "mod:a", {"marker": True}, "updated"),
    (True, "mod:a", "mod:a", {"marker": True, "drifted_present": True}, "updated"),
    (False, "mod:a", "official", {"marker": True}, "ok"),
    (False, "mod:a", "mod:a", {}, "pending"),
    (False, None, "mod:a", {}, "takeover"),
    (True, None, "mod:a", {}, "takeover"),
    (True, "mod:a", "mod:b", {"written": 10.0, "since": 5.0, "toggled": 1.0}, "takeover"),
    (True, "mod:a", "mod:b", {"written": 4.0, "since": 5.0}, "pending"),
    (True, "mod:a", "mod:b", {"written": 6.0, "since": 5.0, "toggled": 7.0}, "pending"),
    (True, "mod:a", "removed", {}, "pending"),
    (True, None, "removed", {}, "pending"),
    (False, None, "removed", {}, "pending"),
    (True, None, "unknown", {}, "untracked"),
    (False, None, "unknown", {}, "untracked"),
    (True, "mod:a", "unknown", {}, "changed"),
    (False, "mod:a", "unknown", {}, "changed"),
    (True, "mod:a", "official", {"configured_exists": False}, "source_missing"),
    (True, "mod:a", "mod:a", {"files": False}, "missing"),
    (True, "mod:a", "unknown", {"damaged": True}, "damaged"),
    (True, None, "mod:b", {"carried_exists": False}, "pending"),
]


@pytest.mark.parametrize("enabled, configured, carried, extra, expected", STATES)
def test_every_combination_gets_one_state(enabled, configured, carried, extra, expected):
    state, takeover = classify(enabled, configured, carried, **extra)
    assert state == expected
    assert (takeover == carried) == (expected == "takeover")
    if expected == "takeover":
        again, _ = classify(enabled, takeover, carried)
        assert again in ("ok", "pending")


def test_the_leaving_rule():
    assert all(leaves(state, enabled) for state in ("ok", "missing", "damaged", "source_missing")
               for enabled in (True, False))
    assert leaves("untracked", True) and leaves("changed", True)
    assert not leaves("untracked", False) and not leaves("changed", False)
    assert not any(leaves(state, enabled) for state in ("pending", "reset", "updated") for enabled in (True, False))


def test_the_source_rule_follows_the_shared_cases():
    cases = json.loads((DATA / "source_rule_cases.json").read_text(encoding="utf-8"))["cases"]
    assert any(part["applied"] == "unknown" and part["crc"] == "ok" for case in cases for part in case["parts"])
    for case in cases:
        parts = [(part["applied"], part["official"]) for part in case["parts"]]
        assert carried_of(parts) == case["carried"], case["name"]


# --- several instances and threads ---

def test_two_instances_on_one_library_keep_both_sets_of_records(world):
    other = ModLibrary(world.root, world.catalog, None, world.settings, data_id="A")
    first = world.add(world.spr, where="first")
    second, = other.add([make_mod(world.spr, world.tmp / "second", b"second!!")])
    world.library.set_favorite("test", True)
    other.rename(second.id, "Second")
    assert {m.id for m in world.reload().mods()} == {first.id, second.id}
    assert world.library.favorites() == {"test"}
    assert next(m for m in world.library.mods() if m.id == second.id).label == "Second"


def test_a_slow_read_in_a_scan_does_not_hold_the_library(world, monkeypatch):
    world.consent = True
    keep_backup(world.spr)
    outside_mod(world.spr)
    started, release = threading.Event(), threading.Event()
    real = storage.trailing_bytes

    def slow(path):
        if Path(path) == world.spr:
            started.set()
            release.wait(5)
        return real(path)

    monkeypatch.setattr(service, "trailing_bytes", slow)
    thread = threading.Thread(target=world.library.scan)
    thread.start()
    assert started.wait(5)
    begin = time.monotonic()
    world.library.mods()  # takes the library lock meanwhile
    assert time.monotonic() - begin < 2
    release.set()
    thread.join(5)


def test_a_scan_that_meets_a_write_is_stale(world, monkeypatch):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    real = storage.trailing_bytes
    done = []

    def meanwhile(path):
        if not done:
            done.append(True)
            world.library.apply("test", f"mod:{mod.id}")
        return real(path)

    monkeypatch.setattr(service, "trailing_bytes", meanwhile)
    result = world.library.scan()
    assert result.stale and result.entries == []


# --- the scan consent as an input ---

def test_the_consent_is_asked_at_each_use(world):
    keep_backup(world.spr)
    outside_mod(world.spr)
    world.toggle(False)  # no consent: never-recorded mods are not looked for
    world.toggle(True)
    assert world.library.mods() == []
    world.consent = True
    world.toggle(False)  # now the Off runs its own pass
    assert len(world.library.mods()) == 1
    world.consent = False
    expect_error("scan_off", world.library.scan)


def test_in_dev_mode_a_game_folder_outside_the_dev_roots_is_no_known_install(world, monkeypatch):
    folder = japan(world)
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}", pin=pin_of(world, folder))  # recorded there too
    monkeypatch.setenv("BAMT_DEV_ROOTS", str(world.game))
    monkeypatch.setenv("BAMT_DEV_WRITABLE", str(world.game))
    assert [pin.key for pin in world.library.installs()] == [world.key()]
    monkeypatch.setenv("BAMT_DEV_ROOTS", str(world.tmp))
    assert {pin.key for pin in world.library.installs()} == {world.key(), world.key(folder)}


def test_without_a_current_install_the_switch_still_covers_the_known_ones(world):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    world.settings.set("file_source", "adb_global")
    assert world.library.current_pin() is None
    assert [pin.key for pin in world.library.installs()] == [world.key()]
    library = ModLibrary(world.root, world.catalog, None, world.settings, data_id="A")
    library.toggle(False, True)
    assert world.spr.read_bytes() == OFFICIAL
    expect_error("game_not_found", lambda: library.state("test"))


# --- a mod's variant follows the current catalog ---

def test_a_mod_retargeted_by_a_later_catalog_is_listed_and_installed_there_directly(world, monkeypatch):
    world.consent = True
    world.catalog.variants.pop("other")
    newcomer = game_bundle(world.game, "dev_alias_spr", payload=b"newcomer")
    keep_backup(newcomer, newcomer.read_bytes())
    data = outside_mod(newcomer)
    world.library.adopt([{"install": world.key(), "core": "dev_alias_spr"}])
    mod, = world.library.mods()
    assert mod.target == "dev_alias"  # its core's fallback key
    world.catalog.variants["ch0042"] = FakeVariant("ch0042", "dev_alias_spr", family="test")  # data names it later
    mod, = world.library.mods()
    assert mod.target == "ch0042"
    stored = json.loads((world.root / "state.json").read_text())["mods"][0]["target"]
    assert stored == "dev_alias"  # what an alpha.3 instance reads stays as it wrote it

    def fail(*args, **kwargs):
        raise AssertionError("adapted onto its own variant")

    monkeypatch.setattr(core, "process_mod_update", fail)
    world.library.restore("ch0042")
    world.library.apply("ch0042", f"mod:{mod.id}")
    assert newcomer.read_bytes() == data


def test_keeping_an_outside_change_of_a_core_only_another_install_has(world):
    folder = japan(world, "ch9999_spr")
    newcomer = next(folder.glob("*ch9999_spr*"))
    pin = pin_of(world, folder)
    data = outside_mod(newcomer)
    world.original(newcomer).parent.mkdir(parents=True, exist_ok=True)
    world.original(newcomer).write_bytes(OFFICIAL)  # an official copy is kept already
    world.library.profiles.update(lambda d: d["folders"].setdefault(pin.key, {"server": "japan"}).update(
        configured={"ch9999_spr": {"variant": "ch9999", "kind": "spr", "source": "official", "since": "x"}}))
    world.library._switch(pin, "ch9999_spr", "official")
    kept, = world.library.mods()
    assert kept.file.read_bytes() == data and kept.target == "ch9999"


def test_an_on_reaches_an_unconfigured_listed_entry(world):
    world.library.profiles.update(lambda data: data.update(
        enabled=False, unfinished=[{"install": world.key(), "core": "test_spr", "why": "pending"}]))
    world.library.toggle(True, False)
    assert world.unfinished() == []  # it holds the intent: official, nothing configured


# --- alpha.3 records, game updates and gone records ---

def test_alpha3_records_of_a_two_part_lobby_and_a_game_update_give_updated(world):
    world.consent = True
    parts = [game_bundle(world.game, "test_home", part=part, payload=part.encode() * 3) for part in ("002", "003")]
    mod, = world.library.add([make_mod(part, world.tmp / "pack", payload=b"lobbymod" + part.name[-30:-27].encode(),
                                       fixed=True) for part in parts])
    world.library.apply("test", f"mod:{mod.id}", kind="lobby")
    as_alpha3(world)
    game_update(parts[0], payload=b"updated lobby part")  # one modded part renamed by the update
    world.reload()  # the first alpha.4 start: the lookup migrates, then the start prunes
    assert world.folder()["configured"]["test_home"]["source"] == f"mod:{mod.id}"
    world.library.prune()
    assert not world.original(parts[0]).exists()
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    assert str(parts[0].resolve()) not in applied
    assert "test_home" in world.folder()["updated"]
    assert world.entries()[(world.key(), "test_home")].state == "updated"


def test_alpha3_records_of_a_one_part_portrait_renamed_by_an_update_give_updated(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    as_alpha3(world)
    game_update(world.spr)
    world.reload()
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{mod.id}"  # from its gone record
    world.library.prune()
    assert world.entries()[(world.key(), "test_spr")].state == "updated"


def test_gone_records_stay_while_another_install_keeps_the_original(world, monkeypatch):
    world.consent = True
    second = world.tmp / "second"
    second.mkdir()
    shutil.copyfile(world.spr, second / world.spr.name)
    world.settings.set("game_resource_dir_japan", str(second))  # two installs sharing file names
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.apply("test", f"mod:{mod.id}", pin=pin_of(world, second))
    old = world.spr
    game_update(old)  # the first install updates; the second still holds the old name
    world.reload()
    world.library.prune()
    assert world.original(old).exists()
    assert str(old.resolve()) in json.loads((world.root / "state.json").read_text())["applied"]
    assert world.folder()["updated"] == {}
    assert world.entries()[(world.key(), "test_spr")].state == "updated"  # by the gone rule
    rebuilding_installer(monkeypatch)
    monkeypatch.setattr(mod_install, "_asset_match", lambda sources, candidates, log: (candidates, ""))
    world.library.restore_drift([{"install": world.key(), "core": "test_spr", "state": "updated"}])
    assert world.entries()[(world.key(), "test_spr")].state == "ok"
    world.reload()
    world.library.prune()
    assert world.folder()["updated"] == {}
    game_update(second / old.name)  # now the second install updates too
    world.reload()
    world.library.prune()
    assert not world.original(old).exists()
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    assert str(old.resolve()) not in applied and str((second / old.name).resolve()) not in applied
    assert "test_spr" in world.folder(second)["updated"] and world.folder()["updated"] == {}


def test_an_install_the_library_never_wrote_keeps_the_original_until_it_updates_too(world):
    second = world.tmp / "second"
    second.mkdir()
    shutil.copyfile(world.spr, second / world.spr.name)
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.settings.set("game_resource_dir_japan", str(second))  # named now, never written
    old = world.spr
    game_update(old)
    world.reload()
    world.library.prune()
    assert world.original(old).exists()  # the second holds the old name without a record
    game_update(second / old.name)
    world.reload()
    world.library.prune()
    assert not world.original(old).exists()
    assert str(old.resolve()) not in json.loads((world.root / "state.json").read_text())["applied"]


def test_an_adopted_overwritten_part_renamed_by_an_update_is_updated_then_ok(world, monkeypatch):
    world.consent = True
    outside_mod(world.spr)
    world.toggle(False)  # adopted, stuck
    world.toggle(True)
    game_update(world.spr)
    assert world.entries()[(world.key(), "test_spr")].state == "updated"
    world.reload()
    world.library.prune()
    rebuilding_installer(monkeypatch)
    monkeypatch.setattr(mod_install, "_asset_match", lambda sources, candidates, log: (candidates, ""))
    world.library.restore_drift([{"install": world.key(), "core": "test_spr", "state": "updated"}])
    assert world.entries()[(world.key(), "test_spr")].state == "ok"


def test_a_written_successor_ends_the_gone_rule_before_the_prune(world, monkeypatch):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    successor = game_update(world.spr)
    rebuilding_installer(monkeypatch)
    monkeypatch.setattr(mod_install, "_asset_match", lambda sources, candidates, log: (candidates, ""))
    world.library._switch(world.library.current_pin(), "test_spr", f"mod:{mod.id}")  # a bulk write: no prune
    assert str(world.spr.resolve()) in json.loads((world.root / "state.json").read_text())["applied"]
    assert successor.exists() and world.entries()[(world.key(), "test_spr")].state == "ok"


# --- half drifted entries and whole built copies ---

def two_part_lobby(world: World):
    parts = [game_bundle(world.game, "test_home", part=part, payload=part.encode() * 3) for part in ("002", "003")]
    mod, = world.library.add([make_mod(part, world.tmp / "pack", payload=b"lobbymod" + part.name[-30:-27].encode(),
                                       fixed=True) for part in parts])
    return parts, mod


def test_a_half_reset_entry_turned_off_and_on_comes_back_whole(world):
    world.consent = True
    parts, mod = two_part_lobby(world)
    world.library.apply("test", f"mod:{mod.id}", kind="lobby")
    official = world.original(parts[0]).read_bytes()
    parts[0].write_bytes(official)  # a Steam check put one modded part back
    world.toggle(False)
    assert "test_home" not in world.folder()["built"]  # it did not carry its mod: no half copy
    world.toggle(True)  # rebuilt: both parts carry the mod again
    assert world.entries()[(world.key(), "test_home")].state == "ok"
    applied = json.loads((world.root / "state.json").read_text())["applied"]
    assert all(applied[str(part.resolve())]["official"] is False for part in parts)


def test_a_whole_built_copy_is_kept_through_a_reset_and_written_back_whole(world, monkeypatch):
    world.consent = True
    parts, mod = two_part_lobby(world)
    world.library.apply("test", f"mod:{mod.id}", kind="lobby")
    modded = {part: part.read_bytes() for part in parts}
    world.toggle(False)
    key = world.folder()["built"]["test_home"]
    assert set(key["parts"]) == {part.name for part in parts}
    world.toggle(True)
    parts[0].write_bytes(world.original(parts[0]).read_bytes())  # reset after the On
    world.toggle(False)
    assert world.folder()["built"]["test_home"] == key  # kept as it was
    no_installer(monkeypatch)
    world.toggle(True)
    assert {part: part.read_bytes() for part in parts} == modded


def test_an_off_of_an_entry_carrying_its_mod_replaces_the_whole_key(world, monkeypatch):
    lobby_parts, lobby_mod = two_part_lobby(world)
    texture = world.add(lobby_parts[1], payload=b"texonly!", fixed=True, where="texture")
    world.library.apply("test", f"mod:{lobby_mod.id}", kind="lobby")
    world.toggle(False)
    world.toggle(True)
    world.library.apply("test", f"mod:{texture.id}", kind="lobby")
    assert "test_home" not in world.folder()["built"]  # the configuration changed: its key went
    world.toggle(False)
    assert list(world.folder()["built"]["test_home"]["parts"]) == [lobby_parts[1].name]


def test_adopting_with_mods_on_keeps_the_mod_files_as_its_built_copy(world, monkeypatch):
    world.consent = True
    keep_backup(world.spr)
    data = outside_mod(world.spr)
    world.library.adopt([{"install": world.key(), "core": "test_spr"}])
    world.spr.write_bytes(OFFICIAL)  # a Steam check
    assert world.entries()[(world.key(), "test_spr")].state == "reset"
    no_installer(monkeypatch)
    world.library.restore_drift([{"install": world.key(), "core": "test_spr", "state": "reset"}])
    assert world.spr.read_bytes() == data


def test_two_installs_share_one_built_file_until_both_drop_it(world, monkeypatch):
    folder = japan(world)
    second = folder / world.spr.name
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.apply("test", f"mod:{mod.id}", pin=pin_of(world, folder))
    world.toggle(False)
    built = list((world.root / "built").iterdir())
    assert len(built) == 1
    world.toggle(True)
    world.library.restore("test")  # the first install's configuration goes
    assert built[0].exists()
    world.library.restore("test", pin=pin_of(world, folder))
    assert not built[0].exists()
    assert second.read_bytes() == OFFICIAL


@pytest.mark.parametrize("clear", [False, True])
@pytest.mark.parametrize("when", ["before_save", "after_unlock", "before_recovery"])
def test_a_built_key_keeps_its_file_when_another_instance_drops_the_last_reference(world, monkeypatch, clear, when):
    folder = japan(world)
    pin = pin_of(world, folder)
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    other = world.build("B")
    other.apply("test", f"mod:{mod.id}", pin=pin)
    first = world.library.current_pin()
    world.library._make_built(first, world.library._view([first], "full").entry(first, "test_spr"))
    part = world.folder()["built"]["test_spr"]["parts"][world.spr.name]
    built = world.root / "built" / f"{part['sha1']}.bundle"
    expected = built.read_bytes()
    entry = other._view([pin], "full").entry(pin, "test_spr")

    def drop():
        if clear:
            world.library.clear_built()
        else:
            world.library._drop_built(first)

    if when != "after_unlock":
        update = other._update_profiles
        lock = profiles_module.file_lock
        copy = service.atomic_copy
        held = False
        copied = []

        @contextmanager
        def tracked(path):
            nonlocal held
            with lock(path):
                held = True
                try:
                    yield
                finally:
                    held = False

        def recover(source, target):
            assert not held
            assert target == built and not built.exists()
            assert world.folder(folder)["built"]["test_spr"]["parts"][world.spr.name] == part
            if when == "before_recovery":
                world.library.clear_built()
                assert world.folder(folder)["built"] == {}
            copied.append(target)
            return copy(source, target)

        def meanwhile(change, after=None):
            monkeypatch.setattr(other, "_update_profiles", update)
            # B has reused the existing file, but has not saved its key yet.
            assert built.exists() and world.folder(folder)["built"] == {}
            drop()
            assert not built.exists()
            return update(change) if after is None else update(change, after=after)

        monkeypatch.setattr(profiles_module, "file_lock", tracked)
        monkeypatch.setattr(service, "atomic_copy", recover)
        monkeypatch.setattr(other, "_update_profiles", meanwhile)
        other._make_built(pin, entry)
        assert copied == [built]
    else:
        lock = profiles_module.file_lock

        @contextmanager
        def meanwhile(path):
            with lock(path):
                yield
            # B saves as soon as A releases the shared lock, before A returns from its update.
            monkeypatch.setattr(profiles_module, "file_lock", lock)
            other._make_built(pin, entry)

        monkeypatch.setattr(profiles_module, "file_lock", meanwhile)
        drop()

    assert world.folder()["built"] == {}
    if when == "before_recovery":
        assert world.folder(folder)["built"] == {}
        assert not list(built.parent.iterdir())
    else:
        assert world.folder(folder)["built"]["test_spr"]["parts"][world.spr.name] == part
        assert built.read_bytes() == expected


def test_a_game_update_drops_the_built_copy_and_on_rebuilds(world, monkeypatch):
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    copy, = (world.root / "built").iterdir()
    successor = game_update(world.spr)
    world.reload()
    world.library.prune()
    assert "test_spr" not in world.folder()["built"] and not copy.exists()
    monkeypatch.setattr(mod_install, "_asset_match", lambda sources, candidates, log: (candidates, ""))
    world.toggle(True)
    assert successor.read_bytes() != header_bundle(b"updated!")


def test_a_game_update_keeps_a_built_file_another_install_still_uses(world, monkeypatch):
    folder = japan(world)
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.apply("test", f"mod:{mod.id}", pin=pin_of(world, folder))
    world.toggle(False)
    copy, = (world.root / "built").iterdir()
    game_update(world.spr)
    world.reload()
    world.library.prune()
    assert "test_spr" not in world.folder()["built"] and world.folder(folder)["built"]["test_spr"]
    assert copy.exists()
    game_update(folder / world.spr.name)  # the last key that uses it goes, and the file with it
    world.reload()
    world.library.prune()
    assert world.folder(folder)["built"] == {} and not copy.exists()


def test_a_built_copy_goes_with_a_configuration_the_scan_drops(world, monkeypatch):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    copy, = (world.root / "built").iterdir()
    data = json.loads((world.root / "state.json").read_text())
    data["mods"] = []
    (world.root / "state.json").write_text(json.dumps(data))
    world.reload()
    assert world.entries()[(world.key(), "test_spr")].state == "source_missing"
    assert world.folder()["built"] == {} and not copy.exists()


def test_a_built_copy_goes_with_a_configuration_the_scan_takes_over(world, monkeypatch):
    world.consent = True
    first, second = world.add(world.spr, fixed=True), world.add(world.spr, b"second!!", fixed=True, where="b")
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{first.id}")
    world.toggle(False)
    world.toggle(True)  # written back from its built copy, which stays
    copy, = (world.root / "built").iterdir()
    # an alpha.3 instance, which keeps no built copies, wrote the other mod after
    world.spr.write_bytes(second.file.read_bytes())
    path, stat = world.root / "state.json", world.spr.stat()
    data = json.loads(path.read_text())
    data["applied"][str(world.spr.resolve())].update(
        source=f"mod:{second.id}", sha1=storage.Fingerprints().get(world.spr).sha1, size=stat.st_size,
        mtime=stat.st_mtime_ns, at="2100-01-01T00:00:00+00:00")
    path.write_text(json.dumps(data))
    world.reload()
    assert world.entries()[(world.key(), "test_spr")].configured == f"mod:{second.id}"
    assert "test_spr" not in world.folder()["built"] and not copy.exists()


def test_a_replaced_built_copy_leaves_no_file_behind(world, monkeypatch):
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    stale = world.root / "built" / f"{'0' * 40}.bundle"
    stale.parent.mkdir(parents=True)
    stale.write_bytes(b"an earlier build")
    world.library.profiles.update(lambda data: data["folders"][world.key()]["built"].update(
        test_spr={"source": f"mod:{mod.id}", "inputs": [], "parts": {world.spr.name: {"sha1": "0" * 40,
                                                                                      "mod_file": None}}}))
    world.toggle(False)  # the Off keeps the bytes it found, replacing the key
    assert world.folder()["built"]["test_spr"]["parts"][world.spr.name]["sha1"] != "0" * 40
    assert not stale.exists() and len(list((world.root / "built").iterdir())) == 1


def test_adopting_over_a_kept_built_copy_leaves_no_file_behind(world, monkeypatch):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    world.toggle(True)
    copy, = (world.root / "built").iterdir()
    outside_mod(world.spr)  # another tool's mod over it
    world.library.adopt([{"install": world.key(), "core": "test_spr"}])
    assert world.folder()["configured"]["test_spr"]["source"] != f"mod:{mod.id}"
    assert not copy.exists()


def test_a_key_kept_as_mod_files_never_holds_a_built_file(world, monkeypatch):
    """A part kept as a file of its mod reads mods/<id>/, never built/: the same bytes there are no reference."""
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    rebuilding_installer(monkeypatch)
    world.library.apply("test", f"mod:{mod.id}")
    world.toggle(False)
    copy, = (world.root / "built").iterdir()
    world.spr.write_bytes(copy.read_bytes())  # the same bytes written back from outside
    world.reload()
    world.library.adopt([{"install": world.key(), "core": "test_spr"}])
    assert world.folder()["built"]["test_spr"]["parts"][world.spr.name]["mod_file"]
    assert not copy.exists()


def test_a_variant_entry_whose_source_files_changed_is_rebuilt(world, monkeypatch):
    other = game_bundle(world.game, "other_spr", payload=b"other!!!")
    built = []

    def update(sources, targets, output, *args, **kwargs):
        built.append([source.name for source in sources])
        result = output / targets[0].name
        result.write_bytes(CRCUtils.apply_crc_fix(header_bundle(b"adapted!"), int(parse_filename(targets[0].name).crc)))
        return ModUpdateResult(True, "updated", [FilePair(result, targets[0])])

    monkeypatch.setattr("ba_modding_toolkit.library.service.adapt_variant_sources", lambda sources, *args: sources)
    monkeypatch.setattr(core, "process_mod_update", update)
    world.library.apply("test", "variant:other")
    world.toggle(False)
    assert world.folder()["built"]["test_spr"]["inputs"] == [other.name]
    renamed = game_update(other, payload=b"other v2")
    world.toggle(True)
    assert built[-1] == [renamed.name] and len(built) == 2  # rebuilt from the new file, not written back


# --- failures, Retry, rollbacks ---

def test_one_locked_file_fails_one_entry_and_the_rest_go_on(world, monkeypatch):
    files = three_mods(world)
    lock_game_file(monkeypatch, files["other_spr"])
    result = world.toggle(False)
    assert [item["entry"]["core"] for item in result.failed] == ["other_spr"]
    assert {item["core"] for item in result.done} == {"test_spr", "third_spr"}
    assert world.unfinished() == [{"install": world.key(), "core": "other_spr", "why": "pending"}]


def test_a_running_game_stops_the_toggle(world, monkeypatch):
    # outside dev mode (devmode): inside BAMT_DEV_WRITABLE a game folder is written without the game check
    monkeypatch.delenv("BAMT_DEV_ROOTS", raising=False)
    monkeypatch.delenv("BAMT_DEV_WRITABLE", raising=False)
    three_mods(world)
    calls = []

    def running():
        calls.append(1)
        if len(calls) > 1:
            raise ServiceError("game_running")

    monkeypatch.setattr(safety, "check_game_not_running", running)
    expect_error("game_running", lambda: world.toggle(False))
    assert world.library.intent()["enabled"] is False  # the intent was saved first
    assert len(world.unfinished()) == 3


def test_an_off_that_does_not_fit_writes_nothing(world, monkeypatch):
    world.consent = True
    keep_backup(world.spr)
    outside_mod(world.spr)
    monkeypatch.setattr(service.shutil, "disk_usage", lambda path: SimpleNamespace(free=10))
    error = expect_error("not_enough_space", lambda: world.toggle(False))
    assert error.params["free"] == 10
    assert world.library.intent()["enabled"] is True and world.library.mods() == []


def test_an_older_library_source_than_the_configured_one_is_pending_and_on_applies_it(world, monkeypatch):
    world.consent = True
    first = world.add(world.spr, fixed=True)
    second = world.add(world.spr, b"second!!", fixed=True, where="second")
    world.library.apply("test", f"mod:{first.id}")
    lock_game_file(monkeypatch, world.spr)
    world.toggle(False)  # failed on it: still carries the first mod
    monkeypatch.undo()
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    world.library.apply("test", f"mod:{second.id}")  # saved while off
    assert world.entries()[(world.key(), "test_spr")].state == "pending"
    world.toggle(True)
    assert world.spr.read_bytes() == second.file.read_bytes()


def test_retry_skips_stuck_entries(world):
    world.consent = True
    outside_mod(world.spr)
    world.toggle(False)
    result = world.library.toggle(False, False)
    assert [item["core"] for item in result.stuck] == ["test_spr"] and result.done == []


def test_a_configuration_changed_by_another_instance_is_read_when_reached(world):
    first = world.add(world.spr, fixed=True)
    second = world.add(world.spr, b"second!!", fixed=True, where="second")
    world.library.apply("test", f"mod:{first.id}")
    world.toggle(False)
    real = service.ModLibrary._reach

    def meanwhile(self, pin, core, *args, **kwargs):
        Profiles(world.root).update(lambda data: data["folders"][pin.key]["configured"][core].update(
            source=f"mod:{second.id}"))
        return real(self, pin, core, *args, **kwargs)

    service_reach = service.ModLibrary._reach
    service.ModLibrary._reach = meanwhile
    try:
        world.toggle(True)
    finally:
        service.ModLibrary._reach = service_reach
    assert world.spr.read_bytes() == second.file.read_bytes()


def test_an_existing_mod_survives_a_rolled_back_write_over_its_bytes(world, monkeypatch):
    keep = world.add(world.spr, b"keepme!!", fixed=True, where="keep")
    keep_original = world.original(world.spr)
    other = world.add(world.spr, b"other!!!", fixed=True, where="other")
    world.library.apply("test", f"mod:{other.id}")
    world.library.rename(keep.id, "Kept label")
    shutil.copyfile(keep.file, world.spr)  # the classic GUI installed a library mod
    lock_game_file(monkeypatch, world.spr)
    expect_error("game_file_locked", lambda: world.library.apply("test", f"mod:{other.id}"))
    entry = next(m for m in world.library.mods() if m.id == keep.id)
    assert entry.label == "Kept label" and entry.file.exists() and keep_original.exists()


def test_an_original_that_existed_before_a_failed_write_stays(world, monkeypatch):
    first = world.add(world.spr, fixed=True)
    second = world.add(world.spr, b"second!!", fixed=True, where="second")
    world.library.apply("test", f"mod:{first.id}")
    world.library.restore("test")
    world.library.apply("test", f"mod:{first.id}")
    lock_game_file(monkeypatch, world.spr)
    expect_error("game_file_locked", lambda: world.library.apply("test", f"mod:{second.id}"))
    assert world.original(world.spr).exists()


def test_a_bulk_toggle_prunes_once_at_its_end(world, monkeypatch):
    three_mods(world)
    calls = []
    real = service.ModLibrary._prune

    def count(self):
        calls.append(1)
        return real(self)

    monkeypatch.setattr(service.ModLibrary, "_prune", count)
    world.toggle(False)
    assert len(calls) == 1


def test_apply_mod_configuration_switches_a_changed_entry_only_when_listed_as_changed(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    data = outside_mod(world.spr)
    result = world.library.restore_drift([{"install": world.key(), "core": "test_spr", "state": "reset"}])
    assert result.skipped and world.spr.read_bytes() == data  # turned changed since it was listed
    world.library.restore_drift([{"install": world.key(), "core": "test_spr", "state": "changed"}])
    assert world.spr.read_bytes() == mod.file.read_bytes()
    assert any(m.file.read_bytes() == data for m in world.library.mods())  # the outside change kept first


def test_no_drift_is_applied_while_mods_are_off(world):
    world.toggle(False)
    expect_error("state_changed", lambda: world.library.restore_drift(
        [{"install": world.key(), "core": "test_spr", "state": "reset"}]))


def test_entries_of_cores_the_current_catalog_does_not_map_carry_shipped_names(world, monkeypatch):
    world.consent = True
    folder = japan(world, "ch0042_spr")
    newcomer = next(folder.glob("*ch0042_spr*"))
    keep_backup(newcomer)
    outside_mod(newcomer)
    names = {"en": {"full": "Shipped", "short": "Base"}}
    real = world.catalog.core_map

    def core_map(spr, lobby):
        mapped = real(spr, lobby)
        return type(mapped)(mapped.keys, mapped.spr, mapped.lobby, {"ch0042": names})

    monkeypatch.setattr(world.catalog, "core_map", core_map)
    world.reload()
    entry = world.entries()[(world.key(folder), "ch0042_spr")]
    assert entry.names == names and entry.variant == "ch0042"
    keep_backup(world.spr)
    outside_mod(world.spr)
    assert world.entries()[(world.key(), "test_spr")].names is None  # mapped by the current catalog


def test_the_lock_order_is_kept_across_threads(world, monkeypatch):
    """The library lock, transactions.lock, mods.lock, state.json.lock and profiles.json.lock stay in order;
    no thread holds profiles.json.lock while it asks the scan consent."""
    from ba_modding_toolkit import filelock
    from ba_modding_toolkit.library import profiles as profiles_module
    order = {"transactions.lock": 1.25, "mods.lock": 1.5, "state.json.lock": 2, "profiles.json.lock": 3}
    held = threading.local()
    violations: list[str] = []
    real_lock = filelock.file_lock

    def stack() -> list[int]:
        if not hasattr(held, "stack"):
            held.stack = []
        return held.stack

    import contextlib

    @contextlib.contextmanager
    def tracked(path, **kwargs):
        rank = order.get(Path(path).name, 9)
        if any(level > rank for level in stack()):
            violations.append(f"{Path(path).name} after {stack()}")
        stack().append(rank)
        try:
            with real_lock(path, **kwargs):
                yield
        finally:
            stack().pop()

    monkeypatch.setattr(service, "file_lock", tracked)
    monkeypatch.setattr(profiles_module, "file_lock", tracked)

    class Tracked:
        def __init__(self, lock):
            self.lock = lock

        def __enter__(self):
            if any(level > 1 for level in stack()):
                violations.append(f"library lock after {stack()}")
            self.lock.acquire()
            stack().append(1)

        def __exit__(self, *exc):
            stack().pop()
            self.lock.release()

        def acquire(self, *args, **kwargs):
            return self.lock.acquire(*args, **kwargs)

        def release(self):
            return self.lock.release()

    world.library._lock = Tracked(world.library._lock)

    def consent():
        if 3 in stack():
            violations.append("consent asked holding profiles.json.lock")
        return True

    world.library._scan_allowed_input = consent
    keep_backup(world.spr)
    outside_mod(world.spr)
    other = game_bundle(world.game, "other_spr")
    mod = world.add(other, fixed=True)
    world.library.apply("other", f"mod:{mod.id}")

    def work_a():
        world.library.scan()
        world.library.toggle(False, True)
        world.library.modified()

    def work_b():
        world.library.dismiss("untracked", [{"install": world.key(), "core": "test_spr"}])
        world.library.prune()
        world.library.judge_unfinished()

    threads = [threading.Thread(target=work) for work in (work_a, work_b)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    world.library.toggle(True, False)
    world.library.restore("other")
    world.library.remove(mod.id)
    assert violations == []


# --- what the switch's snapshot reads ---

def test_the_status_lists_installs_with_ids_and_distinct_folder_names(world):
    from ba_modding_toolkit.library.judge import distinguishing_folders
    assert distinguishing_folders({"a": Path("/x/Steam/BlueArchive"), "b": Path("/y/Other/BlueArchive")}) == {
        "a": "Steam/BlueArchive", "b": "Other/BlueArchive"}
    assert distinguishing_folders({"a": Path("/x/BlueArchive"), "b": Path("/y/Steam")}) == {
        "a": "BlueArchive", "b": "Steam"}
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    other = world.tmp / "global2"
    game_bundle(other)
    world.settings.set("game_resource_dir", str(other))  # the first stays known by its record
    status = world.library.status()
    installs = {item["key"]: item for item in status["installs"]}
    assert set(installs) == {world.key(), world.key(other)}
    assert installs[world.key()]["named"] is False and installs[world.key(other)]["named"] is True
    assert installs[world.key()]["distinct"] == "game" and installs[world.key(other)]["distinct"] == "global2"
    assert len(installs[world.key()]["id"]) == 12 and status["current"] == world.key(other)
    assert (status["enabled"], status["reason"], status["configured"]) == (True, None, 1)
    assert status["unfinished"] == {"pending": 0, "left": 0, "stuck": 0}
    (world.root / "profiles.json").write_text("{broken")
    (world.root / "profiles.json.prev").write_text("{broken")
    assert world.library.status()["reason"] == "profiles_unreadable"


# --- real bundles: copies of an official game folder named by BAMT_TEST_GAME_DIR, never the folder itself ---

GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")


def real_portrait(tmp_path: Path) -> tuple[Path, Path, str]:
    """A small official portrait core copied into a temporary game folder; returns (folder, texture bundle, core)."""
    from ba_modding_toolkit.models import AssetType
    from ba_modding_toolkit.searching import get_search_dirs
    resources = get_search_dirs(GAME_DIR)
    candidates = [path for directory in resources for path in directory.glob("assets-_mx-spinecharacters-*.bundle")
                  if parse_filename(path.name).core.endswith("_spr")
                  and parse_filename(path.name).res_type in ("003", "textures")]
    for path in sorted(candidates, key=lambda p: p.stat().st_size)[:12]:
        bundle = Bundle.load(path)
        if bundle and any(obj.type == AssetType.Texture2D for obj in bundle.env.objects):
            core_name = parse_filename(path.name).core
            game = tmp_path / "game"
            game.mkdir()
            for other in (p for directory in resources for p in directory.glob("*.bundle")
                          if parse_filename(p.name).core == core_name):
                shutil.copyfile(other, game / other.name)
            return game, game / path.name, core_name
    pytest.skip("No small portrait texture bundle available")


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="Blue Archive install unavailable")
def test_real_bundles_off_on_drift_and_adoption(tmp_path, monkeypatch):
    from PIL import Image
    from ba_modding_toolkit.models import AssetType
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    game, texture_file, core_name = real_portrait(tmp_path)
    official = {path.name: path.read_bytes() for path in game.iterdir()}
    settings = Settings(tmp_path / "config.toml")
    settings.set("game_resource_dir", str(game))
    settings.set("compression_method", "lz4")
    settings.set("enable_crc_correction", "true")
    key = core_name.lower().removesuffix("_spr")
    catalog = FakeCatalog(FakeVariant(key, core_name.lower()))
    consent = {"value": True}
    library = ModLibrary(tmp_path / "library", catalog, None, settings, scan_allowed=lambda: consent["value"],
                         data_id="A")
    texture = next(obj for obj in Bundle.load(texture_file).env.objects if obj.type == AssetType.Texture2D)
    image = tmp_path / "art" / f"{texture.peek_name()}.png"
    image.parent.mkdir()
    Image.new("RGBA", texture.read().image.size, (255, 0, 255, 255)).save(image)
    (tmp_path / "mod").mkdir()
    success, message, pairs = core.process_asset_packing([texture_file], [image], tmp_path / "mod",
                                                         settings.save_options(False))
    assert success, message
    mod, = library.add([pairs[0].output])
    library.apply(key, f"mod:{mod.id}")  # the installer adds the CRC fix
    applied = texture_file.read_bytes()
    assert library.state(key).crc == "fixed"
    pin = library.current_pin()

    library.toggle(False, True)
    assert {path.name: path.read_bytes() for path in game.iterdir()} == official
    built = library.profiles.read()["folders"][pin.key]["built"][core_name.lower()]
    assert list(built["parts"]) == [texture_file.name] and built["parts"][texture_file.name]["mod_file"] is None

    def fail(*args, **kwargs):
        raise AssertionError("the installer must not run")

    monkeypatch.setattr(mod_install, "execute_mod_install", fail)
    library.toggle(True, False)
    assert texture_file.read_bytes() == applied  # byte for byte, from the built copy

    texture_file.write_bytes(official[texture_file.name])  # a Steam check
    entry = {(e.install, e.core): e for e in library.entries()}[(pin.key, core_name.lower())]
    assert entry.state == "reset"
    library.restore_drift([{"install": pin.key, "core": core_name.lower(), "state": "reset"}])
    assert texture_file.read_bytes() == applied

    # a CRC-fixed mod installed by another tool in a second install, with the classic GUI's backup beside it
    other = tmp_path / "other"
    other.mkdir()
    for name, data in official.items():
        (other / name).write_bytes(data)
    (other / (texture_file.name + ".backup")).write_bytes(official[texture_file.name])
    (other / texture_file.name).write_bytes(applied)
    settings.set("game_resource_dir_japan", str(other))
    library = ModLibrary(tmp_path / "library", catalog, None, settings, scan_allowed=lambda: consent["value"],
                         data_id="A")
    library.toggle(False, True)  # adopted: it is the same part set as nothing in the library, so a new mod
    assert (other / texture_file.name).read_bytes() == official[texture_file.name]
    library.toggle(True, False)
    assert (other / texture_file.name).read_bytes() == applied
    assert texture_file.read_bytes() == applied


# --- what a write replaces, what a switch finds, and installs another data directory hides ---

def test_a_write_judges_what_it_replaces_by_its_sha1_not_its_size_and_date(world):
    mod = world.add(world.spr)  # no CRC fix: the official size
    world.library.apply("test", f"mod:{mod.id}")
    stat = world.spr.stat()
    world.spr.write_bytes(header_bundle(b"another!"))  # another tool: the same size...
    os.utime(world.spr, ns=(stat.st_atime_ns, stat.st_mtime_ns))  # ...and the date put back
    assert world.library.state("test").files[0].applied == f"mod:{mod.id}"  # judged cheaply, still the library's
    world.library.restore("test")
    assert world.spr.read_bytes() == OFFICIAL
    # the write compared the sha1 it computed anyway with the record: the outside bytes are kept as a mod
    assert any(m.file.read_bytes() == header_bundle(b"another!") for m in world.library.mods())
    assert len(world.library.mods()) == 2


def test_a_new_date_on_the_same_bytes_is_stamped_once_a_switch_reaches_them(world):
    world.consent = True
    mod = world.add(world.spr, payload=b"longer unfixed mod")  # another size than the official file, no tail
    world.library.apply("test", f"mod:{mod.id}")
    later = world.spr.stat().st_mtime_ns + 5_000_000_000
    os.utime(world.spr, ns=(later, later))  # the same bytes, a new date (a backup tool, touch)
    assert world.entries()[(world.key(), "test_spr")].state == "changed"
    result = world.library.toggle(True, True)  # a Retry of the On: the full judgement finds the record's sha1
    assert result.done == [] and result.skipped == [] and result.adopted == []
    record = json.loads((world.root / "state.json").read_text())["applied"][str(world.spr.resolve())]
    assert record["mtime"] == later
    assert world.entries()[(world.key(), "test_spr")].state == "ok"  # the prompt does not come back at every start
    world.reload()
    assert world.entries()[(world.key(), "test_spr")].state == "ok"


def test_an_outside_change_the_cheap_rule_takes_for_official_is_remembered_once_reached(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.spr.write_bytes(header_bundle(b"outside!"))  # no CRC fix, no trailing bytes, the official size
    assert world.entries()[(world.key(), "test_spr")].state == "reset"  # judged cheaply: official again
    result = world.library.restore_drift([{"install": world.key(), "core": "test_spr", "state": "reset"}])
    assert [item["why"] for item in result.skipped] == ["changed"]  # reached: changed outside, left as it is
    assert world.spr.read_bytes() == header_bundle(b"outside!")
    # from then on the cheap judgement agrees, with no read: an outside change (the untracked prompt), never again a
    # drift prompt that Apply Mod Configuration skips
    assert world.entries()[(world.key(), "test_spr")].state == "changed"
    world.reload()
    assert world.entries()[(world.key(), "test_spr")].state == "changed"
    assert world.library.state("test").files[0].applied == "unknown"
    result = world.toggle(False)  # the Off adopts it, then reverts the file; the next write drops the verdict
    assert [item["core"] for item in result.adopted] == ["test_spr"]
    record = json.loads((world.root / "state.json").read_text())["applied"][str(world.spr.resolve())]
    assert "outside" not in record and world.spr.read_bytes() == OFFICIAL


def test_an_install_hidden_here_keeps_the_originals_its_files_need(world):
    # X (world.game) is named by A; B names Y and removed X from its list. Both hold a file of one name, and only Y
    # was written by the library.
    other = world.tmp / "y-game"
    other.mkdir()
    shutil.copyfile(world.spr, other / world.spr.name)
    mod = world.add(world.spr, fixed=True)
    world.library.dismiss("untracked", [{"install": world.key(), "core": "test_spr"}])  # X's record, named by A
    b = second_directory(world, other)
    b.apply("test", f"mod:{mod.id}")  # the original is kept for Y
    b.forget(world.key())
    assert world.folder()["hidden"] == ["B"]
    assert world.key() not in [pin.key for pin in b.installs()]
    game_update(other / world.spr.name)  # Y updates: the name is gone from B's installs
    assert b.prune() == []
    assert world.original(world.spr).exists()  # X still holds the name without a record: maybe another tool's mod
    world.library.prune()
    assert world.original(world.spr).exists()  # the same answer where X is named
    game_update(world.spr)  # X updates too
    b.prune()
    assert not world.original(world.spr).exists()


def test_alpha3_records_of_a_lobby_whose_mod_left_a_part_official_and_a_game_update_give_updated(world):
    # a re-texture: the mod changed one part of the lobby; the library recorded the other part under it too
    world.consent = True
    parts = [game_bundle(world.game, "test_home", part=part, payload=part.encode() * 3) for part in ("002", "003")]
    mod, = world.library.add([make_mod(parts[0], world.tmp / "pack", payload=b"lobbymod", fixed=True)])
    world.library.apply("test", f"mod:{mod.id}", kind="lobby")
    as_alpha3(world)
    game_update(parts[0], payload=b"updated lobby part")  # the modded part renamed; the other part still official
    world.reload()  # the first alpha.4 start: the present part carries the mod's source with official bytes
    assert world.folder()["configured"]["test_home"]["source"] == f"mod:{mod.id}"  # from the gone record
    world.library.prune()
    assert "test_home" in world.folder()["updated"]
    assert world.entries()[(world.key(), "test_home")].state == "updated"


def test_with_scan_consent_an_off_still_reaches_the_entries_it_has_records_of(world):
    world.consent = True
    mod = world.add(world.spr, fixed=True)
    world.library.apply("test", f"mod:{mod.id}")
    world.library.restore("test")  # recorded official, nothing configured; the kept original is released
    keep_backup(world.spr)  # the other tool's backup of the official file
    world.spr.write_bytes(header_bundle(b"outside!"))  # another tool, unfixed, the official size
    assert (world.key(), "test_spr") not in world.entries()  # the pass calls it official: no entry of its own
    result = world.toggle(False)  # the plan holds every recorded entry too: reached, judged in full, adopted
    assert [item["core"] for item in result.adopted] == ["test_spr"]
    assert world.spr.read_bytes() == OFFICIAL
    assert any(m.file.read_bytes() == header_bundle(b"outside!") for m in world.library.mods())


def test_delete_clears_configured_sources_built_keys_and_dismissals(world):
    mod = world.add(world.spr)
    world.toggle(False)
    world.library.apply("test", f"mod:{mod.id}")
    second = game_bundle(world.game, part="002", payload=b"skeleton")
    shared, orphan = "a" * 40, "b" * 40
    built = world.root / "built"
    built.mkdir(exist_ok=True)
    for sha1 in (shared, orphan):
        (built / f"{sha1}.bundle").write_bytes(b"built copy")

    def configure(data):
        folder = data["folders"][world.key()]
        folder["built"] = {
            "test_spr": {"source": f"mod:{mod.id}", "parts": {
                world.spr.name: {"sha1": shared}, second.name: {"sha1": orphan}}},
            "other_spr": {"source": "variant:test", "parts": {world.spr.name: {"sha1": shared}}}}
        folder["dismissed"] = {"drift": {"test_spr": [], "other_spr": []}, "untracked": {"test_spr": []}}
    world.library.profiles.update(configure)
    result = world.library.remove(mod.id)
    folder = world.folder()
    assert result.failed == [] and folder["configured"] == {}
    assert set(folder["built"]) == {"other_spr"}
    assert folder["dismissed"] == {"drift": {"other_spr": []}, "untracked": {}}
    assert (built / f"{shared}.bundle").exists() and not (built / f"{orphan}.bundle").exists()
    assert not mod.file.parent.exists()


@pytest.mark.parametrize("code", ["game_running", "steam_busy", "classic_open", "game_file_locked"])
def test_delete_keeps_configuration_changes_when_restore_is_refused(world, monkeypatch, code):
    # outside dev mode (devmode): inside BAMT_DEV_WRITABLE a game folder is written without the game check
    monkeypatch.delenv("BAMT_DEV_ROOTS", raising=False)
    monkeypatch.delenv("BAMT_DEV_WRITABLE", raising=False)
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    installed = world.spr.read_bytes()
    def refuse(*args):
        raise ServiceError(code)
    if code == "game_running":
        monkeypatch.setattr(safety, "check_game_not_running", refuse)
    elif code == "steam_busy":
        monkeypatch.setattr(safety, "check_steam_idle", refuse)
    else:
        world.library._write_check = refuse
    result = world.library.remove(mod.id)
    assert result.failed[0]["code"] == code
    assert world.spr.read_bytes() == installed
    assert world.library.mods() == [] and world.folder()["configured"] == {}
    assert world.folder()["built"] == {}
    assert world.unfinished() == [{"install": world.key(), "core": "test_spr", "why": "pending"}]
    assert world.library._view(world.library.installs(), "full").entry(world.library.current_pin(), "test_spr").state == "pending"
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    monkeypatch.setattr(safety, "check_steam_idle", lambda *args: None)
    world.library._write_check = None
    assert world.library.toggle(True, True).done
    assert world.spr.read_bytes() == OFFICIAL


def test_delete_preserves_a_different_saved_source(world):
    first = world.add(world.spr)
    second = world.add(world.spr, payload=b"second mod", where="second")
    world.library.apply("test", f"mod:{first.id}")
    world.library._configure(world.library.current_pin(), "test", {"spr": "test_spr"}, f"mod:{second.id}")
    assert world.library.remove(first.id).failed == []
    assert world.spr.read_bytes() == second.file.read_bytes()
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{second.id}"


def test_delete_refuses_a_mod_directory_outside_the_library(world):
    mod = world.add(world.spr)
    outside = world.tmp / "outside"
    shutil.move(mod.file.parent, outside)
    mod.file.parent.symlink_to(outside, target_is_directory=True)
    expect_error("mod_unsupported", lambda: world.library.remove(mod.id))
    assert (outside / mod.file.name).exists()


def test_delete_reports_io_restore_failure_and_retains_retry(world, monkeypatch):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    def refuse(*args, **kwargs):
        raise PermissionError(13, "Refused", str(world.spr))
    monkeypatch.setattr(world.library, "_switch", refuse)
    result = world.library.remove(mod.id)
    assert result.failed[0]["code"] == "library_io_error"
    assert world.library.mods() == [] and world.folder()["configured"] == {}
    assert world.unfinished() == [{"install": world.key(), "core": "test_spr", "why": "pending"}]


@pytest.mark.parametrize("file", ["state", "profiles"])
def test_delete_metadata_write_failure_keeps_the_source_and_configuration(world, monkeypatch, file):
    mod = world.add(world.spr)
    world.library.apply("test", f"mod:{mod.id}")
    before = world.spr.read_bytes()
    def refuse(*args, **kwargs):
        raise PermissionError(13, "Refused", str(world.root / f"{file}.json"))
    if file == "state":
        monkeypatch.setattr(world.library, "_save", refuse)
    else:
        monkeypatch.setattr(world.library.profiles, "_write", refuse)
    expect_error("library_io_error", lambda: world.library.remove(mod.id))
    assert world.library.mods() == [mod] and mod.file.exists()
    assert world.folder()["configured"]["test_spr"]["source"] == f"mod:{mod.id}"
    assert world.spr.read_bytes() == before
    assert json.loads((world.root / "state.json").read_text())["mods"][0]["id"] == mod.id
