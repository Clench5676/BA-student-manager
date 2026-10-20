"""User folder migration without a compiled build, always confined to temporary folders."""

import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
import toml

from ba_modding_toolkit import config, data_paths, devmode, filelock, utils
from ba_modding_toolkit.data_paths import APP_DIR_NAME, OLD_APP_DIR_NAME, migrate_data_dir
from ba_modding_toolkit.webui.instance import InstanceLock


@pytest.fixture
def folders(tmp_path):
    old, new = tmp_path / OLD_APP_DIR_NAME, tmp_path / APP_DIR_NAME
    old.mkdir()
    (old / "user-file").write_bytes(b"keep")
    return old, new


def test_old_only_is_renamed_once(folders):
    old, new = folders
    inode = (old / "user-file").stat().st_ino
    assert migrate_data_dir(old.parent) == new
    assert not old.exists()
    assert (new / "user-file").read_bytes() == b"keep"
    assert (new / "user-file").stat().st_ino == inode
    assert migrate_data_dir(old.parent) == new


def test_both_exist_uses_new_and_leaves_old_untouched(folders, caplog):
    old, new = folders
    new.mkdir()
    original = b'{"prefs":{"output":"leave alone"}}'
    (old / "webui.json").write_bytes(original)
    (old / "cache").mkdir()
    (old / "cache" / "entry").write_bytes(b"cached")
    for _ in range(2):
        assert migrate_data_dir(old.parent) == new
    assert (old / "webui.json").read_bytes() == original
    assert (old / "cache" / "entry").read_bytes() == b"cached"
    assert sorted(p.name for p in old.iterdir()) == ["cache", "user-file", "webui.json"]
    assert list(new.iterdir()) == []
    assert caplog.text.count("Both data folders exist") == 1


def test_rename_failure_uses_old_then_retries(folders, monkeypatch, caplog):
    old, new = folders
    rename = Path.rename

    def denied(path, target):
        if path == old:
            raise PermissionError("file in use")
        return rename(path, target)

    monkeypatch.setattr(Path, "rename", denied)
    assert migrate_data_dir(old.parent) == old
    assert (old / "user-file").read_bytes() == b"keep" and not new.exists()
    assert "using the old folder for this run" in caplog.text
    monkeypatch.setattr(Path, "rename", rename)
    assert migrate_data_dir(old.parent) == new


def test_legacy_lock_is_held_during_process_checks_and_rename(folders, monkeypatch):
    old, new = folders
    (old / "instance.lock").touch()
    rename = Path.rename
    checked = []

    def check_processes():
        folder = old if old.exists() else new
        contender = InstanceLock(folder)
        try:
            assert not contender.acquire()
        finally:
            contender.release()
        checked.append(folder)
        return False

    def guarded_rename(path, target):
        if path == old:
            contender = InstanceLock(old)
            try:
                assert not contender.acquire()
            finally:
                contender.release()
        return rename(path, target)

    monkeypatch.setattr(data_paths, "_standalone_classic_in_use", check_processes)
    monkeypatch.setattr(Path, "rename", guarded_rename)
    selected = migrate_data_dir(old.parent)
    # Windows may refuse to rename a folder with an open lock file; either result must release the probe.
    assert selected in (old, new) if os.name == "nt" else selected == new
    assert checked == ([old] if selected == old else [old, new])
    assert (selected / data_paths._PENDING).exists() is (selected == old)
    instance, contender = InstanceLock(selected), InstanceLock(selected)
    try:
        assert instance.acquire() and instance.held
        assert not contender.acquire()
    finally:
        instance.release()
        contender.release()


@pytest.mark.skipif(os.name == "nt", reason="Uses POSIX locks to exercise the Windows API branches")
def test_windows_rename_failure_releases_probe_for_normal_instance_lock(folders, monkeypatch):
    import fcntl
    from ba_modding_toolkit.webui import instance as instance_module

    old, new = folders
    (old / "instance.lock").touch()
    calls = []

    def locking(fd, mode, size):
        assert size == 1 and os.lseek(fd, 0, os.SEEK_CUR) == 0
        calls.append(mode)
        assert mode in (1, 2)  # only non-blocking acquisition and unlock are allowed
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB if mode == 1 else fcntl.LOCK_UN)

    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2, locking=locking))
    windows_os = SimpleNamespace(**(vars(os) | {"name": "nt"}))
    for module in (data_paths, filelock, instance_module):
        monkeypatch.setattr(module, "os", windows_os)
    rename = Path.rename

    def denied(path, target):
        if path == old:
            contender = InstanceLock(old)
            try:
                assert not contender.acquire()
            finally:
                contender.release()
            raise PermissionError("open lock file prevents folder rename")
        return rename(path, target)

    monkeypatch.setattr(Path, "rename", denied)
    assert migrate_data_dir(old.parent) == old
    assert old.exists() and not new.exists() and (old / data_paths._PENDING).exists()
    instance, contender = InstanceLock(old), InstanceLock(old)
    try:
        assert instance.acquire() and instance.held
        assert not contender.acquire()
    finally:
        instance.release()
        contender.release()
    assert 2 in calls
    # Also cover a Windows file system that permits the rename: the normal lock must use the moved file.
    monkeypatch.setattr(Path, "rename", rename)
    assert migrate_data_dir(old.parent) == new
    assert not (new / data_paths._PENDING).exists()
    instance, contender = InstanceLock(new), InstanceLock(new)
    try:
        assert instance.acquire() and instance.held
        assert not contender.acquire()
    finally:
        instance.release()
        contender.release()


def test_override_never_inspects_default_folders(folders, tmp_path, monkeypatch):
    old, new = folders
    override = tmp_path / "isolated"
    monkeypatch.setenv("BAMT_DATA_DIR", str(override))
    monkeypatch.setattr(utils, "DATA_DIR_OVERRIDE", devmode.data_dir())
    monkeypatch.setattr(utils, "__compiled__", SimpleNamespace(containing_dir=str(tmp_path), macos_bundle_mode=True),
                        raising=False)

    def forbidden(*args, **kwargs):
        pytest.fail("default folders were inspected with an override")

    with monkeypatch.context() as m:
        m.setattr(Path, "home", forbidden)
        m.setattr(data_paths, "_legacy_in_use", forbidden)
        assert migrate_data_dir(old.parent, devmode.data_dir()) == override
        assert utils._get_exe_dir(devmode.data_dir()) == override
        assert config.user_cache_dir() == override / "cache"
        assert data_paths.migrate_cache_dir(old / "cache", new / "cache", override) == override / "cache"
    assert (old / "user-file").read_bytes() == b"keep" and not new.exists()


@pytest.mark.parametrize("external_library", [False, True])
def test_persisted_paths_rewritten_in_values_and_keys(folders, tmp_path, external_library):
    old, new = folders
    outside = tmp_path / "elsewhere" / OLD_APP_DIR_NAME
    library = tmp_path / "library" if external_library else old / "custom-library"
    library.mkdir()
    settings = {
        "AppSettings": {"output_dir": str(old / "output"), "outside": str(outside)},
        "Directories": {"mod_backup_path": str(old / "output" / "backup")},
        "BACIIMap": {"bacii_map_path": str(old / "Addons" / "map.csv")},
        "ADB": {"adb_cache_dir": str(old / "Addons" / "adb_cache")},
        "Unknown": {"paths": [str(old), str(old) + "-other/output", "relative/BA-Modding-Toolkit"]},
    }
    (old / "config.toml").write_text(toml.dumps(settings))
    state = {"prefs": {"library_dir": str(library), "cache_parent": str(old / "custom-cache"),
                       "data_id": "a" * 32, "data_path": str(old)}, "aliases": {"x": ["keep"]}}
    (old / "webui.json").write_text(json.dumps(state))
    profiles = {"version": 1, "folders": {str(old / "game"): {"configured": {}, "named_by": {"a" * 32: "date"}}},
                "unfinished": [{"install": str(old / "game"), "core": "x", "why": "pending"}]}
    for name in ("profiles.json", "profiles.json.prev", "profiles.json.bad"):
        (library / name).write_text(json.dumps(profiles))
    if external_library:
        (old / "library").mkdir()
        (old / "library/profiles.json").write_text(json.dumps(profiles))
    (library / "state.json").write_text(json.dumps({"version": 1, "applied": {str(old / "game/a.bundle"): {}},
                                                  "outside": str(outside)}))
    (old / "classic.json").write_text(json.dumps({"exe": str(old / "tool"), "pid": -1}))
    info = b'{"pid": -1, "port": 9000, "raise_token": "keep"}'
    (old / "instance.json").write_bytes(info)
    log = str(old / "output")
    (old / "classic.log").write_text(log)
    (old / "input-trace.log").write_text(log)
    assert migrate_data_dir(old.parent) == new
    actual = toml.loads((new / "config.toml").read_text())
    assert actual["AppSettings"] == {"output_dir": str(new / "output"), "outside": str(outside)}
    assert actual["Directories"]["mod_backup_path"] == str(new / "output/backup")
    assert actual["BACIIMap"]["bacii_map_path"] == str(new / "Addons/map.csv")
    assert actual["ADB"]["adb_cache_dir"] == str(new / "Addons/adb_cache")
    assert actual["Unknown"]["paths"] == [str(new), str(old) + "-other/output", "relative/BA-Modding-Toolkit"]
    state = json.loads((new / "webui.json").read_text())
    assert state["prefs"]["data_id"] == "a" * 32 and state["prefs"]["data_path"] == str(new)
    assert state["prefs"]["cache_parent"] == str(new / "custom-cache")
    library = library if external_library else new / "custom-library"
    assert state["prefs"]["library_dir"] == str(library)
    for name in ("profiles.json", "profiles.json.prev", "profiles.json.bad"):
        actual = json.loads((library / name).read_text())
        assert list(actual["folders"]) == [str(new / "game")]
        assert actual["unfinished"][0]["install"] == str(new / "game")
    if external_library:
        assert list(json.loads((new / "library/profiles.json").read_text())["folders"]) == [str(new / "game")]
    actual = json.loads((library / "state.json").read_text())
    assert actual["applied"] == {str(new / "game/a.bundle"): {}} and actual["outside"] == str(outside)
    assert json.loads((new / "classic.json").read_text())["exe"] == str(new / "tool")
    assert (new / "instance.json").read_bytes() == info
    assert (new / "classic.log").read_text() == (new / "input-trace.log").read_text() == log


def test_interrupted_rewrite_never_stops_the_start_and_is_retried(folders, monkeypatch):
    old, new = folders
    (old / "config.toml").write_text(toml.dumps({"AppSettings": {"output_dir": str(old / "output")}}))
    def denied(*args):
        raise PermissionError("busy")

    with monkeypatch.context() as m:
        m.setattr(data_paths, "_rewrite_paths", denied)
        assert migrate_data_dir(old.parent) == new
    assert not old.exists() and (new / data_paths._PENDING).exists()
    assert migrate_data_dir(old.parent) == new
    assert not (new / data_paths._PENDING).exists()
    assert toml.loads((new / "config.toml").read_text())["AppSettings"]["output_dir"] == str(new / "output")


@pytest.mark.parametrize("lock_name", ["state.json.lock", "profiles.json.lock"])
def test_busy_external_library_does_not_block_start_and_is_retried(folders, tmp_path, monkeypatch, lock_name):
    old, new = folders
    library = tmp_path / "external-library"
    library.mkdir()
    (old / "webui.json").write_text(json.dumps({"prefs": {"library_dir": str(library)}}))
    (old / "config.toml").write_text(toml.dumps({"AppSettings": {"output_dir": str(old / "output")}}))
    content = json.dumps({"path": str(old / "game")})
    for name in ("state.json", "profiles.json", "profiles.json.prev", "profiles.json.bad"):
        (library / name).write_text(content)
    (old / "library").mkdir()
    (old / "library/state.json").write_text(content)
    attempted = []

    @contextmanager
    def bounded_lock(path, *, timeout=None):
        # Reject an unbounded call before it can hang this regression test.
        assert timeout is not None and 0 <= timeout <= 0.5
        attempted.append(path)
        with filelock.file_lock(path, timeout=timeout):
            yield

    with filelock.file_lock(library / lock_name):
        monkeypatch.setattr(data_paths, "file_lock", bounded_lock)
        started = time.monotonic()
        assert migrate_data_dir(old.parent) == new
        assert time.monotonic() - started < 2
    assert library / lock_name in attempted
    assert (new / data_paths._PENDING).exists()
    assert toml.loads((new / "config.toml").read_text())["AppSettings"]["output_dir"] == str(new / "output")
    assert json.loads((new / "library/state.json").read_text()) == {"path": str(new / "game")}
    for name in ("state.json", "profiles.json", "profiles.json.prev", "profiles.json.bad"):
        assert (library / name).read_text() == content
    assert migrate_data_dir(old.parent) == new
    assert not (new / data_paths._PENDING).exists()
    for name in ("state.json", "profiles.json", "profiles.json.prev", "profiles.json.bad"):
        assert json.loads((library / name).read_text()) == {"path": str(new / "game")}


@pytest.mark.parametrize("unavailable", ["missing", "unreadable"])
def test_unavailable_configured_library_keeps_journal_until_it_returns(folders, tmp_path, monkeypatch, unavailable):
    old, new = folders
    library, disconnected = tmp_path / "external-library", tmp_path / "disconnected"
    library.mkdir()
    content = json.dumps({"path": str(old / "game")})
    for name in ("state.json", "profiles.json", "profiles.json.prev", "profiles.json.bad"):
        (library / name).write_text(content)
    (old / "webui.json").write_text(json.dumps({"prefs": {"library_dir": str(library)}}))
    is_dir = Path.is_dir

    def unreadable(path):
        if path == library:
            raise PermissionError("drive is unreadable")
        return is_dir(path)

    with monkeypatch.context() as m:
        if unavailable == "missing":
            library.rename(disconnected)
        else:
            m.setattr(Path, "is_dir", unreadable)
        assert migrate_data_dir(old.parent) == new
    assert (new / data_paths._PENDING).exists()
    if unavailable == "missing":
        assert not library.exists()  # migration must not recreate a disconnected library
        disconnected.rename(library)
    for name in ("state.json", "profiles.json", "profiles.json.prev", "profiles.json.bad"):
        assert (library / name).read_text() == content
    assert migrate_data_dir(old.parent) == new
    assert not (new / data_paths._PENDING).exists()
    for name in ("state.json", "profiles.json", "profiles.json.prev", "profiles.json.bad"):
        assert json.loads((library / name).read_text()) == {"path": str(new / "game")}


def test_unwritable_library_lock_keeps_journal_and_is_retried(folders):
    old, new = folders
    library = old / "library"
    library.mkdir()
    content = json.dumps({"path": str(old / "game")})
    (library / "state.json").write_text(content)
    # A directory at the lock path makes opening it fail on every platform, including elevated test runs.
    (library / "state.json.lock").mkdir()
    assert migrate_data_dir(old.parent) == new
    assert (new / data_paths._PENDING).exists()
    assert (new / "library/state.json").read_text() == content
    (new / "library/state.json.lock").rmdir()
    assert migrate_data_dir(old.parent) == new
    assert not (new / data_paths._PENDING).exists()
    assert json.loads((new / "library/state.json").read_text()) == {"path": str(new / "game")}


def test_busy_migration_lock_does_not_block_start(folders, monkeypatch):
    old, new = folders
    lock = old.parent / f".{APP_DIR_NAME}.migration.lock"

    @contextmanager
    def bounded_lock(path, *, timeout=None):
        assert timeout is not None and 0 <= timeout <= 0.5
        with filelock.file_lock(path, timeout=timeout):
            yield

    with filelock.file_lock(lock):
        monkeypatch.setattr(data_paths, "file_lock", bounded_lock)
        started = time.monotonic()
        assert migrate_data_dir(old.parent) == old
        assert time.monotonic() - started < 2
    assert old.exists() and not new.exists()
    assert migrate_data_dir(old.parent) == new


def test_path_key_conflict_preserves_both_records(folders):
    old, new = folders
    library = old / "library"
    library.mkdir()
    content = json.dumps({"version": 1, "applied": {str(old / "game/a.bundle"): {"source": "old"},
                                                    str(new / "game/a.bundle"): {"source": "new"}}})
    (library / "state.json").write_text(content)
    assert migrate_data_dir(old.parent) == new
    assert (new / "library/state.json").read_text() == content
    assert (new / data_paths._PENDING).exists()


@pytest.mark.parametrize("both", [False, True])
def test_live_older_instance_keeps_its_folder_for_this_run(folders, both):
    old, new = folders
    if both:
        new.mkdir()
    instance = InstanceLock(old)
    assert instance.acquire()
    try:
        # only the old folder: used by both apps for now; both folders: the new one, the old left untouched
        assert migrate_data_dir(old.parent) == (new if both else old)
        assert (old / "user-file").read_bytes() == b"keep"
        assert new.exists() is both
    finally:
        instance.release()
    assert migrate_data_dir(old.parent) == new


def test_live_classic_child_prevents_migration(folders):
    from ba_modding_toolkit.webui.classic import SYSTEM_PROCESSES

    old, new = folders
    (old / "classic.json").write_text(json.dumps({"pid": os.getpid(), "exe": sys.executable, "hwnd": 0,
                                                  "created": SYSTEM_PROCESSES.created(os.getpid())}))
    assert migrate_data_dir(old.parent) == old
    assert old.exists() and not new.exists()


def test_older_standalone_classic_without_record_prevents_migration(folders, monkeypatch):
    old, new = folders
    executable = "/Applications/Tool.app/Contents/MacOS/Tool"
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(sys, "argv", [executable])
    monkeypatch.setattr(sys, "executable", executable)
    process = f"987654 /Applications/Old Tool.app/Contents/MacOS/Tool --classic\n"
    monkeypatch.setattr(data_paths.subprocess, "run", lambda *args, **kwargs:
                        SimpleNamespace(returncode=0, stdout=process))
    assert migrate_data_dir(old.parent) == old
    assert old.exists() and not new.exists()
    process = "987654 /Applications/Other.app/Contents/MacOS/Other --classic\n"
    assert migrate_data_dir(old.parent) == new


def test_migration_precedes_addons_copy(folders, tmp_path, monkeypatch):
    old, new = folders
    (old / "Addons").mkdir()
    (old / "Addons/map.csv").write_text("user map")
    bundled = tmp_path / "bundle/Addons"
    bundled.mkdir(parents=True)
    (bundled / "map.csv").write_text("bundled map")
    monkeypatch.setattr(utils, "__compiled__", SimpleNamespace(containing_dir=str(tmp_path), macos_bundle_mode=True),
                        raising=False)
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    monkeypatch.setattr(sys, "executable", str(bundled.parent / "tool"))
    monkeypatch.setattr(utils, "migrate_data_dir", lambda parent: migrate_data_dir(old.parent))
    assert utils._get_exe_dir() == new
    assert (new / "Addons/map.csv").read_text() == "user map"


@pytest.mark.parametrize("system", ["win32", "darwin", "linux"])
@pytest.mark.parametrize("both", [False, True])
def test_default_cache_removes_only_old_cache(tmp_path, monkeypatch, system, both):
    monkeypatch.setattr(sys, "platform", system)
    monkeypatch.setattr(utils, "DATA_DIR_OVERRIDE", None)
    monkeypatch.setattr(utils, "EXE_DIR", tmp_path / "portable")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    parent = {"win32": tmp_path / "local", "darwin": tmp_path / "Library/Application Support",
              "linux": tmp_path / "xdg"}[system]
    tail = Path() if system == "linux" else Path("cache")
    old, new = parent / OLD_APP_DIR_NAME / tail, parent / APP_DIR_NAME / tail
    old.mkdir(parents=True)
    (old / "asset").write_bytes(b"old")
    sibling = old.parent / "keep"
    sibling.write_bytes(b"keep")
    if both:
        new.mkdir(parents=True)
        (new / "asset").write_bytes(b"new")
    assert config.user_cache_dir() == new
    assert not old.exists() and sibling.read_bytes() == b"keep"
    if both:
        assert (new / "asset").read_bytes() == b"new"


def test_cache_stays_with_macos_data_after_failed_rename(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    parent = tmp_path / "Library/Application Support"
    assert data_paths.default_cache_dir(data_dir=parent / OLD_APP_DIR_NAME) == parent / OLD_APP_DIR_NAME / "cache"


def test_cache_cleanup_failure_keeps_old_cache_and_warns(tmp_path, monkeypatch, caplog):
    old, new = tmp_path / OLD_APP_DIR_NAME / "cache", tmp_path / APP_DIR_NAME / "cache"
    old.mkdir(parents=True)
    (old / "asset").write_bytes(b"keep")

    def denied(path):
        assert path == old
        raise PermissionError("busy")

    monkeypatch.setattr(data_paths.shutil, "rmtree", denied)
    assert data_paths.migrate_cache_dir(old, new) == new
    assert (old / "asset").read_bytes() == b"keep"
    assert "Could not remove the old cache" in caplog.text


@pytest.mark.parametrize("both", [False, True])
def test_custom_cache_and_override(tmp_path, monkeypatch, both):
    from ba_modding_toolkit.errors import ServiceError
    from ba_modding_toolkit.webui.services import Services
    from ba_modding_toolkit.webui.state import UiState

    monkeypatch.setattr(utils, "DATA_DIR_OVERRIDE", None)
    data = tmp_path / "data"
    state = UiState(data / "webui.json")
    state.set("cache_parent", str(tmp_path))
    old, new = tmp_path / OLD_APP_DIR_NAME / "cache", tmp_path / APP_DIR_NAME / "cache"
    old.mkdir(parents=True)
    (old.parent / "keep").write_text("keep")
    if both:
        new.mkdir(parents=True)
        (new / "asset").write_bytes(b"new")
    s = Services(config.Settings(data / "config.toml"), data, state=state)
    try:
        assert s.cache_dir() == new
        assert not old.exists() and (old.parent / "keep").read_text() == "keep"
        if both:
            assert (new / "asset").read_bytes() == b"new"
        # an override moves only the default cache: a chosen folder stays the user's choice, and is still checked
        monkeypatch.setattr(utils, "DATA_DIR_OVERRIDE", data)
        assert s.cache_dir() == new
        with pytest.raises(ServiceError, match="path_not_found"):
            s.set_cache_parent(tmp_path / "not-created")
        assert not (tmp_path / "not-created").exists()
        plain = Services(config.Settings(data / "config.toml"), data, state=UiState(tmp_path / "plain.json"))
        try:
            assert plain.cache_dir() == data / "cache"
        finally:
            plain.close()
    finally:
        s.close()


def test_changing_cache_parent_recognizes_legacy_name(tmp_path, monkeypatch):
    from ba_modding_toolkit.errors import ServiceError
    from ba_modding_toolkit.webui.services import Services
    from ba_modding_toolkit.webui.state import UiState

    monkeypatch.setattr(utils, "DATA_DIR_OVERRIDE", None)
    state = UiState(tmp_path / "data/webui.json")
    old = tmp_path / OLD_APP_DIR_NAME / "cache"
    old.mkdir(parents=True)
    (old.parent / "keep").write_text("keep")
    target = tmp_path / "target"
    target.mkdir()
    new = target / APP_DIR_NAME / "cache"
    s = Services(config.Settings(tmp_path / "data/config.toml"), tmp_path / "data", state=state)
    monkeypatch.setattr(s, "cache_dir", lambda: new if state.get("cache_parent") else old)
    try:
        assert s.set_cache_parent(target) == new
        assert not old.exists() and (old.parent / "keep").read_text() == "keep"
    finally:
        s.close()


def test_migrations_refuse_paths_outside_isolated_roots(folders, tmp_path, monkeypatch):
    from ba_modding_toolkit.errors import ServiceError

    old, new = folders
    # both lists, so a session that already runs isolated (writable roots set) gives the same answer
    monkeypatch.setenv("BAMT_DEV_ROOTS", str(tmp_path / "isolated"))
    monkeypatch.setenv("BAMT_DEV_WRITABLE", str(tmp_path / "isolated"))
    with pytest.raises(ServiceError, match="dev_path_outside"):
        migrate_data_dir(old.parent)
    assert data_paths.migrate_cache_dir(old / "cache", new / "cache") == new / "cache"
    assert (old / "user-file").read_bytes() == b"keep" and not new.exists()


def test_an_unreadable_process_list_keeps_the_old_folder_for_this_run(folders, monkeypatch):
    old, new = folders

    def unknown(folder):
        raise OSError("cannot inspect classic app processes")

    monkeypatch.setattr(data_paths, "_legacy_in_use", unknown)
    assert migrate_data_dir(old.parent) == old
    assert old.exists() and not new.exists()


@pytest.mark.parametrize("scan_error", [False, True])
def test_legacy_probe_is_released_when_process_checks_refuse_migration(folders, monkeypatch, scan_error):
    old, new = folders
    (old / "instance.lock").touch()

    def check_processes():
        if scan_error:
            raise OSError("cannot inspect classic app processes")
        return True

    monkeypatch.setattr(data_paths, "_standalone_classic_in_use", check_processes)
    assert migrate_data_dir(old.parent) == old
    assert old.exists() and not new.exists() and (old / data_paths._PENDING).exists()
    instance = InstanceLock(old)
    try:
        assert instance.acquire() and instance.held
    finally:
        instance.release()
