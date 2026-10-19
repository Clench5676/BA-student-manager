"""The mod configuration (profiles.json), the Enable Mods switch, adoption, drift and built copies, with synthetic
header-only bundles in temporary game folders (never a real install, library or settings)."""

from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import core, mod_install
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import ModLibrary, safety, service, storage
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
    profiles.update(lambda data: False)
    assert not (tmp_path / "profiles.json").exists()


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
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    monkeypatch.setattr(Bundle, "check_need_crc", lambda *args, **kwargs: False)
    return World(tmp_path)


OFFICIAL = header_bundle(b"official")


# --- switching and the configuration ---

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


def test_untracked_mods_are_adopted_before_an_off_and_come_back_on(world):
    world.consent = True
    keep_backup(world.spr)
    data = outside_mod(world.spr)
    entry = world.entries()[(world.key(), "test_spr")]
    assert (entry.state, entry.fixed, entry.overwritten, entry.size) == ("untracked", True, False, len(data))
    assert entry.files[0].copy == "backup"
    result = world.toggle(False)
    assert [item["core"] for item in result.adopted] == ["test_spr"]
    assert world.spr.read_bytes() == OFFICIAL and world.original(world.spr).read_bytes() == OFFICIAL
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
    expect_error("mod_in_use", lambda: world.library.remove(mod.id))  # now in use, as any applied mod


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

    def fail(self, change):
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
            for file in group.files:
                file.existing_path.write_bytes(CRCUtils.apply_crc_fix(
                    header_bundle(payload), int(parse_filename(file.mod_path.name).crc)))
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
    assert world.library.status()["builtSize"] == len(rebuilt)
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
    assert freed > 0 and not (world.root / "built").exists()
    assert set(world.folder()["built"]) == {"test_home"}  # all its parts are files of its mod
    no_installer(monkeypatch)
    rebuilding_installer(monkeypatch, only=world.spr.name)
    world.toggle(True)
    assert lobby.read_bytes() == home.file.read_bytes()
    status = world.library.status()
    assert status["builtSize"] == 0 and status["originalsSize"] > 0
