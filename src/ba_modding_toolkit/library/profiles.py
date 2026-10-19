"""The mod configuration kept beside the library's state: ``profiles.json``.

``state.json`` stays as older builds write it (they load only its version 1 and rewrite it with their own keys), so the
configuration lives in a file of its own that older builds never open::

    {"version": 1,
     "enabled": true,                       # the Enable Mods switch, one intent for every game folder; missing: on
     "toggled": "<ISO>",                    # the last change of enabled
     "unfinished": [{"install", "core", "why"}],   # entries the toggles have not switched yet (pending, left, stuck)
     "folders": {"<install key>": {
         "server": "global",
         "named_by": {"<data directory id>": "<ISO>"}, "hidden": ["<data directory id>"],
         "configured": {"<core>": {"variant", "kind", "source", "since"}},
         "updated": {"<core>": "<ISO>"},
         "built": {"<core>": {"source", "inputs": [...], "parts": {"<file name>": {"sha1", "mod_file"}}}},
         "dismissed": {"drift": {"<core>": [[name, size, mtime_ns]]}, "untracked": {...}},
         "scanned": "<ISO>"}}}

Several instances may share one library: every change is applied to the file as it is at that moment, read again under
a lock file the instances share (``profiles.json.lock``), and unknown keys are kept. The last good file is kept as
``profiles.json.prev`` before every write; an unreadable file is read from it instead and kept as
``profiles.json.bad`` at the next write. With neither readable, the configuration is unavailable
(``profiles_unreadable``) and nothing is written until the user fixes or removes the file.
"""

from __future__ import annotations

import contextlib
import copy
import json
import logging
import os
import shutil
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..errors import ServiceError
from ..filelock import file_lock, replace

logger = logging.getLogger(__name__)

FILE = "profiles.json"
WHY = ("pending", "left", "stuck")


def _parse(path: Path) -> dict[str, Any]:
    """A profiles file's contents; ValueError when it is not a configuration of this version."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("version") != 1:
        raise ValueError("not a version 1 configuration")
    if not isinstance(data.get("folders", {}), dict) or not isinstance(data.get("unfinished", []), list):
        raise ValueError("invalid configuration")
    return data


def normalized(data: dict[str, Any] | None) -> dict[str, Any]:
    """A configuration with every key the library reads present and of its type; unknown keys are kept."""
    data = copy.deepcopy(data) if data else {}
    data["version"] = 1
    if not isinstance(data.get("enabled", True), bool):
        data["enabled"] = True
    if not isinstance(data.get("folders"), dict):
        data["folders"] = {}
    data["unfinished"] = [item for item in data.get("unfinished", []) if isinstance(item, dict)
                          and isinstance(item.get("install"), str) and isinstance(item.get("core"), str)
                          and item.get("why") in WHY] if isinstance(data.get("unfinished"), list) else []
    for key, folder in list(data["folders"].items()):
        if not isinstance(folder, dict):
            del data["folders"][key]
            continue
        for name in ("named_by", "configured", "updated", "built", "dismissed"):
            if not isinstance(folder.get(name), dict):
                folder[name] = {}
        if not isinstance(folder.get("hidden"), list):
            folder["hidden"] = []
        folder["configured"] = {core: entry for core, entry in folder["configured"].items()
                                if isinstance(entry, dict) and isinstance(entry.get("source"), str)}
    return data


def enabled(data: dict[str, Any] | None) -> bool:
    """The switch's intent: a configuration without it (or no configuration) means on, so existing users keep their
    mods."""
    return not data or data.get("enabled", True) is not False


class Profiles:
    """``profiles.json`` of one library folder. Reads are cached by the file's size and modification time."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.path = self.root / FILE
        self.prev = self.root / f"{FILE}.prev"
        self.bad = self.root / f"{FILE}.bad"
        self.lock_path = self.root / f"{FILE}.lock"
        self._lock = threading.RLock()
        self._seen: tuple[tuple[int, int] | None, tuple[int, int] | None] | None = None
        self._data: dict[str, Any] | None = None

    def signature(self) -> tuple[int, int] | None:
        """The file's (modification time in ns, size), None while it is missing."""
        try:
            stat = self.path.stat()
        except OSError:
            return None
        return stat.st_mtime_ns, stat.st_size

    def _signatures(self) -> tuple[tuple[int, int] | None, tuple[int, int] | None]:
        try:
            stat = self.prev.stat()
            prev = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            prev = None
        return self.signature(), prev

    def _load(self) -> tuple[dict[str, Any] | None, bool]:
        """(the configuration now, whether profiles.json itself is unreadable) with the file lock held: profiles.json,
        else profiles.json.prev (logged), else None when neither exists. ServiceError profiles_unreadable when neither
        can be read."""
        bad = False
        if self.path.exists():
            try:
                return _parse(self.path), False
            except (OSError, ValueError) as error:
                logger.warning("Cannot read %s (%s), reading %s instead", self.path, error, self.prev.name)
                bad = True
        if self.prev.exists():
            try:
                data = _parse(self.prev)
            except (OSError, ValueError) as error:
                logger.error("Cannot read %s either (%s)", self.prev, error)
                raise ServiceError("profiles_unreadable", file=str(self.path if bad else self.prev)) from error
            if not bad:
                logger.warning("%s is missing, reading %s", self.path.name, self.prev.name)
            return data, bad
        if bad:
            raise ServiceError("profiles_unreadable", file=str(self.path))
        return None, False

    def read(self) -> dict[str, Any] | None:
        """The configuration as the file holds it now (another instance may have written it), normalized; None while
        there is none yet. Read under the lock the instances share; ServiceError profiles_unreadable when neither
        profiles.json nor its .prev can be read."""
        with self._lock:
            signatures = self._signatures()
            if signatures == self._seen:
                return copy.deepcopy(self._data)
            with file_lock(self.lock_path):
                signatures = self._signatures()
                data, _bad = self._load()
            self._data = normalized(data) if data is not None else None
            self._seen = signatures
            return copy.deepcopy(self._data)

    def exists(self) -> bool:
        """Whether a configuration exists (profiles.json or its .prev)."""
        return self.path.exists() or self.prev.exists()

    def update(self, change: Callable[[dict[str, Any]], Any]) -> dict[str, Any]:
        """Apply one change to the file's current contents, read again under the shared lock, and write it back
        (unknown keys and folders kept, the last good file kept as .prev first). ``change`` gets the normalized
        configuration to change in place, and returns False to write nothing. It never calls into the library, and
        update is never nested. Returns the configuration as written (or as read, when nothing was written)."""
        with self._lock, file_lock(self.lock_path):
            current, bad = self._load()
            data = normalized(current)
            if change(data) is False:
                self._data, self._seen = (normalized(current) if current is not None else None), self._signatures()
                return data
            self.root.mkdir(parents=True, exist_ok=True)
            if bad:
                # keep what could not be read for the user; .prev is the last good file already
                with contextlib.suppress(OSError):
                    replace(self.path, self.bad)
            elif self.path.exists():
                self._copy(self.path, self.prev)
            self._write(data)
            self._data, self._seen = copy.deepcopy(data), self._signatures()
            return data

    def _copy(self, source: Path, target: Path) -> None:
        fd, name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as output, source.open("rb") as stream:
                shutil.copyfileobj(stream, output)
                output.flush()
                os.fsync(output.fileno())
            replace(name, target)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(name)
            raise

    def _write(self, data: dict[str, Any]) -> None:
        fd, name = tempfile.mkstemp(prefix=f".{FILE}.", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                output.write(json.dumps(data, ensure_ascii=False, indent=1))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            replace(name, self.path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(name)
            raise
