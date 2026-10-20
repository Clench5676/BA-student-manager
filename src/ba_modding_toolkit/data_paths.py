"""User folder names and the startup migration, independent of a compiled build."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Any

import toml

from . import devmode
from .filelock import file_lock

APP_DIR_NAME = "bluearchive-modding-patching-tool"
OLD_APP_DIR_NAME = "BA-Modding-Toolkit"
_PENDING = ".data-folder-migration.json"
_LOCK_TIMEOUT = 0.1
_reported_pairs: set[Path] = set()
logger = logging.getLogger(__name__)


def _standalone_classic_in_use() -> bool:
    """Older standalone classic windows have no classic.json; find the same app executable in the process table."""
    if sys.platform != "darwin":
        return False
    names = {path.name for path in (Path(sys.argv[0]), Path(sys.executable))
             if path.parent.name == "MacOS" and not path.name.lower().startswith("python")}
    if not names:
        return False
    try:
        result = subprocess.run(["ps", "-axww", "-o", "pid=,args="], capture_output=True, text=True, timeout=5)
    except subprocess.SubprocessError as error:
        raise OSError("cannot inspect classic app processes") from error
    if result.returncode:
        raise OSError("cannot inspect classic app processes")
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit() or int(parts[0]) in (os.getpid(), os.getppid()):
            continue
        command = parts[1]
        if any(f"/Contents/MacOS/{name} " in command + " " for name in names) and any(
                flag in command.split() for flag in ("--classic", "--tab", "--settings")):
            return True
    return False


@contextmanager
def _legacy_in_use(folder: Path) -> Iterator[bool]:
    """Hold the existing lock through the caller's work; also check classic processes without creating a lock file."""
    try:
        handle = (folder / "instance.lock").open("r+b")
    except FileNotFoundError:
        handle = None
    with handle if handle is not None else nullcontext():
        if handle is not None:
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                yield True
                return
        from .webui.classic import SYSTEM_PROCESSES, read_classic_json

        found = read_classic_json(folder)
        proc = found[1] if found else None
        yield bool(proc and SYSTEM_PROCESSES.alive(proc.pid)
                   and SYSTEM_PROCESSES.created(proc.pid) == proc.created) or _standalone_classic_in_use()


def _rebase(value: Any, old: Path, new: Path) -> Any:
    """Rewrite complete absolute paths, including dictionary keys; never substrings or relative paths."""
    if isinstance(value, str):
        path = Path(os.path.normpath(value))
        if path.is_absolute() and Path(os.path.normcase(str(path))).is_relative_to(
                Path(os.path.normcase(str(old)))):
            return str(new.joinpath(*path.parts[len(old.parts):]))
    elif isinstance(value, list):
        return [_rebase(item, old, new) for item in value]
    elif isinstance(value, dict):
        changed = {}
        for key, item in value.items():
            moved = _rebase(key, old, new)
            if moved in changed:
                raise ValueError(f"Migrating paths would overwrite the existing key {moved}")
            changed[moved] = _rebase(item, old, new)
        return changed
    return value


def _atomic_text(path: Path, text: str) -> None:
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _rewrite_file(path: Path, old: Path, new: Path) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        data = toml.loads(text) if path.suffix == ".toml" else json.loads(text)
    except (ValueError, toml.TomlDecodeError):
        logger.warning("Leaving unreadable migration input unchanged: %s", path)
        return None
    changed = _rebase(data, old, new)
    if changed != data:
        _atomic_text(path, toml.dumps(changed) if path.suffix == ".toml" else json.dumps(changed, indent=2) + "\n")
    return changed


def _rewrite_paths(old: Path, new: Path) -> bool:
    _rewrite_file(new / "config.toml", old, new)
    state = _rewrite_file(new / "webui.json", old, new)
    _rewrite_file(new / "classic.json", old, new)
    # instance.json contains only pid, port and raise_token; lock files contain no paths. Logs and exports are
    # historical output, never loaded as settings. ADB manifests contain remote paths and relative local paths.
    prefs = state.get("prefs") if isinstance(state, dict) else None
    chosen = prefs.get("library_dir") if isinstance(prefs, dict) else None
    configured = Path(chosen) if isinstance(chosen, str) and chosen else None
    libraries = {new / "library"}
    if configured is not None:
        libraries.add(configured)
    complete = True
    for library in libraries:
        devmode.check_read(library)
        try:
            if not library.is_dir():
                if library == configured:
                    raise FileNotFoundError(f"Configured library is unavailable: {library}")
                continue
            with file_lock(library / "state.json.lock", timeout=_LOCK_TIMEOUT), \
                    file_lock(library / "profiles.json.lock", timeout=_LOCK_TIMEOUT):
                _rewrite_file(library / "state.json", old, new)
                for name in ("profiles.json", "profiles.json.prev", "profiles.json.bad"):
                    _rewrite_file(library / name, old, new)
        except (OSError, ValueError) as error:
            complete = False
            logger.warning("Could not migrate library paths in %s; will retry at next start: %s", library, error)
    return complete


def migrate_data_dir(parent: Path, override: Path | None = None) -> Path:
    """Select the data folder before config, logging, the normal instance lock or bundled Addons are opened.

    An override bypasses all migration. An old folder still in use (an older version running) or a failed same-volume
    rename keeps the old folder for this run. The journal moves with the folder, so an interrupted path rewrite is
    retried at every start until it is done.
    """
    if override is not None:
        return override
    parent = Path(parent)
    old, new = parent / OLD_APP_DIR_NAME, parent / APP_DIR_NAME
    devmode.check_read(old)
    devmode.check_read(new)
    if not old.exists() and not (new / _PENDING).exists():
        return new
    # nothing here stops the start (a GUI app has nowhere to show why): every refusal keeps a folder for this run
    try:
        parent.mkdir(parents=True, exist_ok=True)
        with file_lock(parent / f".{APP_DIR_NAME}.migration.lock", timeout=_LOCK_TIMEOUT):
            if old.exists() and new.exists():
                if new not in _reported_pairs:
                    logger.warning("Both data folders exist; using %s and leaving %s untouched", new, old)
                    _reported_pairs.add(new)
            elif old.exists():
                # an older version still running keeps its folder, and this run uses it too: the two never split, the
                # single-instance lock there hands over to the running app, and the next start migrates
                _atomic_text(old / _PENDING, json.dumps({"old": str(old), "new": str(new)}))
                try:
                    with _legacy_in_use(old) as busy:
                        if busy:
                            logger.warning("The old data folder is in use; using it for this run: %s", old)
                            return old
                        try:
                            migrate_cache_dir(old / "cache", new / "cache")
                            old.rename(new)
                        except OSError as error:
                            logger.warning("Could not rename %s to %s; using the old folder for this run: %s",
                                           old, new, error)
                            return old
                except OSError as error:
                    logger.warning("Cannot check whether the old data folder is in use; using it for this run: %s",
                                   error)
                    return old
            if (new / _PENDING).exists():
                try:
                    with _legacy_in_use(new) as busy:
                        if busy:
                            raise OSError("the migrated folder is in use")
                        if _rewrite_paths(old, new):
                            (new / _PENDING).unlink()
                except (OSError, ValueError) as error:
                    # the journal stays, so the next start tries again
                    logger.warning("Could not finish migrating paths in %s; will retry at next start: %s", new, error)
    except OSError as error:
        folder = old if old.exists() and not new.exists() else new
        logger.warning("Could not migrate the data folder; using %s for this run: %s", folder, error)
        return folder
    return new


def migrate_cache_dir(old: Path, new: Path, override: Path | None = None) -> Path:
    """Discard only the obsolete cache itself; game files rebuild it on demand. Never remove its parent."""
    if override is not None:
        return override / "cache"
    if not devmode.allows_read(old) or not devmode.allows_read(new):
        return new  # path calculation is allowed; the cache checks access before using this folder
    if old.is_dir():
        try:
            shutil.rmtree(old)
        except OSError as error:
            logger.warning("Could not remove the old cache %s: %s", old, error)
    return new


def default_cache_dir(override: Path | None = None, data_dir: Path | None = None) -> Path:
    if override is not None:
        return override / "cache"
    if sys.platform == "win32":
        parent = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        parent = Path.home() / "Library" / "Application Support"
        if data_dir in (parent / APP_DIR_NAME, parent / OLD_APP_DIR_NAME):
            return data_dir / "cache"  # the data migration already selected this folder, including a rename failure
    else:
        parent = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    tail = Path("cache") if sys.platform in ("win32", "darwin") else Path()
    return migrate_cache_dir(parent / OLD_APP_DIR_NAME / tail, parent / APP_DIR_NAME / tail)
