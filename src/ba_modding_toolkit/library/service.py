"""Thread-safe library operations built on the classic mod installer."""

from __future__ import annotations

import base64
import contextlib
import copy
import functools
import hashlib
import io
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterator

from UnityPy.helpers.ResourceReader import get_resource_data

from .. import atlas_remap, core, devmode, mod_install, mod_origin
from ..bundle import Bundle
from ..catalog.models import CoreMap
from ..errors import ServiceError
from ..filelock import file_lock
from ..i18n import t
from ..logging_utils import log_failure
from ..models import AssetType, LogFunc, ProgressCallback
from ..naming import parse_filename
from ..searching import SEARCH_DIR_SUFFIXES, get_search_dirs
from ..utils import no_log
from . import profiles as profiles_mod
from . import integrity, safety, staging
from .identity import identify
from .judge import (
    CRC_STATES, KINDS, LIBRARY_SOURCES, carried_of, classify, core_of, crc_state, date_of, distinguishing_folders,
    install_key, install_root, kind_of, kind_of_file, leaves, now, other_target, part_of, says_official, seconds, supports_kind,
)
from .migrations import LEGACY_REMAP, legacy_remapped
from .models import (
    AddResult, AdoptResult, ApplyResult, AssetDifference, CompareResult, DeleteResult, EntryState, GameFileState, Kind,
    ModEntry, Pin, RemapResult, ScanResult, ToggleResult, UpdateResult, VariantState,
)
from .profiles import Profiles
from .safety import check_resource_path
from .storage import (
    Fingerprints, atomic_clone, atomic_copy, atomic_json, read_tail, sync_directory, trailing_bytes,
    verified_move, verify_file,
)
from .variants import adapt_variant_sources

if TYPE_CHECKING:
    from ..catalog import Catalog
    from ..config import Settings
    from ..gameassets import GameAssets

logger = logging.getLogger(__name__)

SPACE_MARGIN = 512 * 1024 * 1024  # left free on the library's volume by an Off and an adoption
SAVE_EVERY = (10, 2.0)  # a toggle saves its unfinished list every 10 entries or 2 s
BUILT_TEMP_MAX_AGE = 60 * 60  # seconds before an abandoned built copy can be cleared
# a toggle's refusals that stop it: every later write would fail the same way
STOPPING = ("game_running", "game_status_unavailable", "steam_busy", "folder_changed", "classic_open")


def _game_folder(game_file: Path) -> Path:
    """The game folder a game file is in, as the settings name it: its resource folder less the subfolder the search
    looks in (searching.SEARCH_DIR_SUFFIXES)."""
    folder = game_file.parent
    for suffix in sorted(filter(None, SEARCH_DIR_SUFFIXES), key=len, reverse=True):
        parts = tuple(part.lower() for part in Path(suffix).parts)
        if len(folder.parts) > len(parts) and tuple(part.lower() for part in folder.parts[-len(parts):]) == parts:
            return Path(*folder.parts[:-len(parts)])
    return folder


def _serialized(method: Callable) -> Callable:
    @wraps(method)
    def call(self: ModLibrary, *args: Any, **kwargs: Any) -> Any:
        with self._lock, _errors(method.__name__):
            self._refresh_state()
            return method(self, *args, **kwargs)
    return call


def _mod_writer(method: Callable) -> Callable:
    """Serialize source additions and deletions across instances, before state and profiles locks."""
    @wraps(method)
    def call(self: ModLibrary, *args: Any, **kwargs: Any) -> Any:
        if self._writing_mods:
            return method(self, *args, **kwargs)
        with self._transaction_lock(), file_lock(self.root / "mods.lock"):
            self._writing_mods = True
            try:
                self._refresh_state()
                return method(self, *args, **kwargs)
            finally:
                self._writing_mods = False
    return call


@contextlib.contextmanager
def _errors(operation: str) -> Iterator[None]:
    """Library failures as the user sees them: a file the library could not read or write, else the operation."""
    try:
        yield
    except OSError as error:
        log_failure(logger, logging.ERROR, "Library file operation failed", error, code="library_io_error")
        raise ServiceError("library_io_error", file=error.filename) from error
    except ServiceError:
        raise
    except Exception as error:
        log_failure(logger, logging.ERROR, f"Library operation failed ({operation})", error,
                    code="library_operation_failed")
        raise ServiceError("library_operation_failed", operation=operation) from error


class _Unread(Exception):
    """A file the judgement may not read: one the library did not write, without scan consent."""


@dataclass
class _Part:
    """One game file as the judgement found it."""

    path: Path
    size: int
    mtime: int
    carried: str  # "official", "unknown", "damaged", "removed", "mod:<id>", "variant:<key>"
    official: bool  # the file holds official bytes
    matched: bool  # unchanged since the library's record of it
    changed: bool  # a record exists and the file changed since
    trailing: int | None  # bytes after the bundle data, when the header was read
    crc: str
    record: dict | None
    restamp: int | None = None  # the record's new modification time: same bytes, new date


@dataclass
class _Entry:
    """One entry as the judgement found it (EntryState before it is reported)."""

    pin: Pin
    core: str
    kind: str
    variant: str
    parts: list[_Part]
    carried: str
    configured: str | None
    state: str
    takeover: str | None = None
    drifted: bool = False
    overwritten: bool = False
    copies: dict[str, str | None] = field(default_factory=dict)
    dismissed: bool = False

    @property
    def key(self) -> tuple[str, str]:
        return self.pin.key, self.core

    def item(self) -> dict[str, str]:
        return {"install": self.pin.key, "core": self.core, "variant": self.variant, "kind": self.kind}


class _View:
    """A consistent copy of what the judgement reads besides the game files: the library's records, its mods, the
    configuration, the indexes and the kept originals. ``allow`` says which game files it may read:

    - ``scan``: headers and tails of any file (the scan consent is given);
    - ``family``: the same, for the files the detail screen shows (decision 27, no consent needed);
    - ``recorded``: only the files the library wrote to (no consent); another file raises _Unread;
    - ``full``: write strength, every file the library cannot show unchanged is hashed in full (switching).
    """

    def __init__(self, library: ModLibrary, pins: list[Pin], config: dict | None, allow: str,
                 snapshot: bool = False) -> None:
        """``snapshot``: copy the records, for a view read outside the library lock (the scan). A view used under
        the lock shares the library's records and the maps built from them."""
        self.library = library
        self.pins = {pin.key: pin for pin in pins}
        self.mods = set(library._records)
        self.config = config
        self.enabled = profiles_mod.enabled(config)
        self.allow = allow
        self.indexes = {pin.key: library._index(pin) for pin in pins}
        self.maps = {pin.key: library._core_map(pin) for pin in pins}
        self.names = {pin.key: library._names(pin) for pin in pins}
        self.originals: dict[str, int] = dict(library._originals())
        if snapshot:
            self.applied = {path: dict(record) for path, record in library._applied.items()}
            self.by_name, self.by_folder = _record_maps(self.applied)
        else:
            self.applied = library._applied
            self.by_name, self.by_folder = library._record_maps()
        self._sizes: dict[str, int | None] = {}

    # --- what the library knows ---

    def folder(self, key: str) -> dict:
        return ((self.config or {}).get("folders") or {}).get(key) or {}

    def configured(self, key: str, core: str) -> dict | None:
        return (self.folder(key).get("configured") or {}).get(core)

    def official_size(self, name: str) -> int | None:
        """The size of the official file of a name, where the library knows it by stat alone: a kept original of
        that name, else a record of that name, in any folder, that says official bytes. The CRC is in the name, so
        every official file of that name has those bytes."""
        if name not in self._sizes:
            size = self.originals.get(name)
            if size is None:
                size = next((record.get("size") for _path, record in self.by_name.get(name, [])
                             if says_official(record) and isinstance(record.get("size"), int)), None)
            self._sizes[name] = size
        return self._sizes[name]

    def source_exists(self, source: str, key: str, kind: str) -> bool:
        if source == "official":
            return True
        if source.startswith("mod:"):
            return source[4:] in self.mods
        if source.startswith("variant:"):
            cores = self.maps.get(key)
            return bool(cores and cores.core(source[8:], kind))
        return False

    def records_of(self, pin: Pin, core: str) -> list[tuple[Path, dict]]:
        """The library's records of a core's files in an install, gone files included."""
        out = []
        for folder in pin.dirs:
            for path, record in self.by_folder.get(folder, []):
                if core_of(path.name) == core:
                    out.append((path, record))
        return out

    # --- one file ---

    def _header(self, path: Path, recorded: bool) -> int | None:
        if self.allow == "recorded" and not recorded:
            raise _Unread(path)
        return trailing_bytes(path)

    def official_now(self, path: Path, size: int, trailing: int | None, name: str | None = None) -> bool:
        """Whether a file holds official bytes: at write strength by the CRC32 of its whole content; else by the
        cheap rule, no trailing bytes and the official size of its name where the library knows it."""
        name = name or path.name
        if self.allow == "full":
            return self.library._is_official_as(path, name)
        expected = self.official_size(name)
        return trailing == 0 and (expected is None or size == expected)

    def part(self, path: Path, pin: Pin, kind: str) -> _Part:
        """One file judged as ``allow`` permits. A file whose size or date changed while it was read is read again."""
        part = self._part(path, pin, kind)
        if self.allow != "full" and not part.matched:
            stat = path.stat()
            if (stat.st_size, stat.st_mtime_ns) != (part.size, part.mtime):
                part = self._part(path, pin, kind)
        return part

    def _part(self, path: Path, pin: Pin, kind: str) -> _Part:
        record = self.applied.get(str(path.resolve()))
        stat = path.stat()
        size, mtime = stat.st_size, stat.st_mtime_ns
        matched = bool(record) and record.get("size") == size and record.get("mtime") == mtime
        trailing: Any = ...
        restamp = None
        if not matched or self.allow == "full":
            if self.allow == "full":
                matched = False
                fingerprint = self.library._hashes.get(path)
                trailing = fingerprint.trailing
                if trailing is not None and record and fingerprint.sha1 == record.get("sha1"):
                    matched, restamp = True, mtime
            else:
                trailing = self._header(path, record is not None)
                if trailing is not None and record and record.get("tail") and record.get("size") == size:
                    if read_tail(path) == record["tail"]:
                        matched, restamp = True, mtime
            if trailing is None:
                return _Part(path, size, mtime, "damaged", False, False, record is not None, None, "needs_fix",
                             record)
        if matched:
            flag = record.get("official")
            if not isinstance(flag, bool):
                if trailing is ...:
                    trailing = self._header(path, True)
                flag = self.official_now(path, size, trailing if trailing is not None else -1)
            source = record.get("source", "")
            if record.get("removed"):
                carried = "removed"
            elif not self.source_exists(source, pin.key, kind):
                # the bytes of a source the library no longer has: offered for adoption, never lost
                carried = "official" if flag else "unknown"
            else:
                carried = source
            crc = record.get("crc")
            if crc not in CRC_STATES:
                if trailing is ...:
                    trailing = self._header(path, True)
                crc = "fixed" if trailing else "ok"
            return _Part(path, size, mtime, carried, flag, True, False, None if trailing is ... else trailing,
                         crc, record, restamp)
        official = self.official_now(path, size, trailing)
        if official and self.allow != "full" and _outside(record, size, mtime):
            # a full judgement found these very bytes changed outside the library: the cheap rule cannot tell
            official = False
        return _Part(path, size, mtime, "official" if official else "unknown", official, False, record is not None,
                     trailing, "fixed" if trailing else "ok", record)

    def says_nonofficial(self, path: Path, record: dict, present: bool) -> bool:
        """Whether a record says the library wrote non-official bytes there. A record of an older build without the
        flag: its size is not the official size of its name, or (its file gone) an original of that name is kept."""
        flag = record.get("official")
        if isinstance(flag, bool):
            return not flag
        if record.get("source") == "official":
            return False
        expected = self.official_size(path.name)
        if expected is not None and record.get("size") != expected:
            return True
        return not present and path.name in self.originals

    def successor(self, pin: Pin, path: Path) -> bool:
        """Whether a present file of the same part, dated after it, is in the same folder (a game update)."""
        part, date = part_of(path.name), date_of(path.name)
        return bool(date) and any(
            other.parent == path.parent and part_of(other.name) == part and date_of(other.name) > date
            for other in self.indexes[pin.key].get(core_of(path.name), []))

    def later_record(self, path: Path) -> bool:
        """Whether the library recorded a later file of the same part in the same folder (it wrote the successor)."""
        part, date = part_of(path.name), date_of(path.name)
        return any(part_of(other.name) == part and date_of(other.name) > date
                   for other, _record in self.by_folder.get(path.parent, []))

    def copy_of(self, part: _Part, pin: Pin) -> str | None:
        """Where an official copy of a game file is, judged cheaply: the library's kept original, the file itself,
        its .backup, a file of its name in another game folder; None when there is none (or it may not be looked
        for). Candidates beyond the file are looked at only for a file that is not official and has no original."""
        name = part.path.name
        if name in self.originals:
            return "kept"
        if part.official:
            return "game"
        if self.allow == "recorded":
            return None
        backup = part.path.with_name(name + ".backup")
        if self._candidate(backup, name):
            return "backup"
        if any(self._candidate(other, name) for other in self.elsewhere(name, part.path)):
            return "elsewhere"
        return None

    def _candidate(self, path: Path, name: str) -> bool:
        try:
            if not path.is_file():
                return False
            size = path.stat().st_size
            if self.allow == "full":
                return self.library._is_official_as(path, name)
            return self.official_now(path, size, trailing_bytes(path), name)
        except OSError:
            return False

    def elsewhere(self, name: str, exclude: Path) -> list[Path]:
        """Files of a name in the other known installs and in the folders of the library's records."""
        exclude = exclude.resolve()
        out: list[Path] = []
        for key, names in self.names.items():
            other = names.get(name)
            if other is not None and other.resolve() != exclude:
                out.append(other)
        for path, _record in self.by_name.get(name, []):
            if path != exclude and path not in out and devmode.allows_read(path) and path.exists():
                out.append(path)
        return out

    # --- one entry ---

    def entry(self, pin: Pin, core: str) -> _Entry:
        kind = self.library._kind(core, pin) or "spr"
        files = self.indexes[pin.key].get(core, [])
        parts = [self.part(path, pin, kind) for path in files]
        folder = self.folder(pin.key)
        config = self.configured(pin.key, core)
        configured = config["source"] if config else None
        damaged = any(part.carried == "damaged" for part in parts)
        carried = "damaged" if damaged else carried_of((part.carried, part.official) for part in parts)
        drifted_present = drifted_gone = False
        if configured:
            present = {str(part.path.resolve()): part for part in parts}
            for path, record in self.records_of(pin, core):
                is_present = str(path) in present
                if not self.says_nonofficial(path, record, is_present):
                    continue
                if is_present:
                    part = present[str(path)]
                    if not part.matched and part.official:
                        drifted_present = True
                elif path.parent.is_dir() and self.successor(pin, path) and not self.later_record(path):
                    drifted_gone = True
        written = max((seconds(part.record.get("at")) or seconds(part.record.get("mtime")) or 0.0
                       for part in parts if part.carried == carried and part.record), default=None)
        toggled = seconds((self.config or {}).get("toggled"))
        marker = core in (folder.get("updated") or {})

        def judged(source: str | None) -> tuple[str, str | None]:
            return classify(
                self.enabled, source, carried, files=bool(files), damaged=damaged,
                configured_exists=self.source_exists(source, pin.key, kind) if source else True,
                carried_exists=self.source_exists(carried, pin.key, kind) if carried.startswith(LIBRARY_SOURCES)
                else True, drifted_present=drifted_present, drifted_gone=drifted_gone, marker=marker,
                written=written, since=seconds((config or {}).get("since")), toggled=toggled)

        state, takeover = judged(configured)
        if state == "takeover":
            configured = takeover
            state, _ = classify(self.enabled, takeover, carried, files=bool(files),
                                drifted_present=drifted_present, drifted_gone=drifted_gone, marker=marker)
        copies = {str(part.path): self.copy_of(part, pin) for part in parts}
        overwritten = any(not part.official and part.carried != "damaged" and copies[str(part.path)] is None
                          for part in parts) and self.allow != "recorded"
        variant = self.maps[pin.key].key(core) or (config or {}).get("variant") or core
        if kind == "other" and files:
            variant = parse_filename(files[0].name).core
        entry = _Entry(pin, core, kind, variant, parts, carried, configured, state, takeover,
                       drifted_present or drifted_gone or marker, overwritten, copies)
        entry.dismissed = self.dismissed(entry)
        return entry

    def dismissed(self, entry: _Entry) -> bool:
        kind = "drift" if entry.state in ("reset", "updated") else "untracked"
        stored = ((self.folder(entry.pin.key).get("dismissed") or {}).get(kind) or {}).get(entry.core)
        return bool(stored) and sorted(map(tuple, stored)) == signature(entry.parts)

    def cores(self, pin: Pin) -> set[str]:
        """Every core of an install the judgement covers: the portrait and lobby cores of its index, the configured
        ones and the ones the library recorded files of."""
        cores = {core for core in self.indexes[pin.key] if self.library._kind(core, pin)}
        cores.update(self.folder(pin.key).get("configured") or {})
        for folder in pin.dirs:
            cores.update(core_of(path.name) for path, _record in self.by_folder.get(folder, [])
                         if kind_of_file(path.name))
        return cores

    def entries(self, pins: list[Pin], cancel: Callable[[], bool] | None = None,
                cores: set[str] | None = None) -> list[_Entry]:
        """Every entry that is configured, not in its intended state, or overwritten."""
        out = []
        for pin in pins:
            for core in sorted(self.cores(pin) if cores is None else self.cores(pin) & cores):
                if cancel and cancel():
                    return out
                try:
                    entry = self.entry(pin, core)
                except (OSError, _Unread):
                    continue
                if entry.configured or entry.state != "ok" or entry.overwritten:
                    out.append(entry)
        return out


def _outside(record: dict | None, size: int, mtime: int) -> bool:
    """Whether a record remembers the full judgement's verdict on the file as it is now (``outside``: its size and
    modification time when a switch found it changed outside the library, though the cheap rule calls it official)."""
    mark = (record or {}).get("outside")
    return isinstance(mark, list) and len(mark) == 2 and mark[0] == size and mark[1] == mtime


def signature(parts: list[_Part]) -> list[tuple[str, int, int]]:
    """An entry's files by name, size and modification time (ns): what a dismissal remembers."""
    return sorted((part.path.name, part.size, part.mtime) for part in parts)


def _record_maps(applied: dict[str, dict]) -> tuple[dict[str, list[tuple[Path, dict]]], dict[Path, list]]:
    """The library's game file records by file name and by folder."""
    by_name: dict[str, list[tuple[Path, dict]]] = {}
    by_folder: dict[Path, list[tuple[Path, dict]]] = {}
    for name, record in applied.items():
        path = Path(name)
        by_name.setdefault(path.name, []).append((path, record))
        by_folder.setdefault(path.parent, []).append((path, record))
    return by_name, by_folder


class ModLibrary:
    """Store mods, retain verified official originals, track installed sources, and keep the mod configuration and
    the Enable Mods switch (profiles.json).

    One reentrant lock serializes state changes and UnityPy work in this service; the jobs over every game folder
    (toggle, adopt, Apply Mod Configuration) take it for one entry at a time. Call long operations on the caller's
    worker thread. Every method that reads or writes game files takes an optional pin (a game folder fixed for the
    call); without one it takes the current game folder, or every known one, from the settings at the call.
    """

    def __init__(self, root: Path, catalog: Catalog, game: GameAssets | None = None, settings: Settings | None = None,
                 *, scan_allowed: Callable[[], bool] = lambda: False, data_id: str = "local",
                 write_check: Callable[[Pin], None] | None = None) -> None:
        """``write_check(pin)`` runs right before game files of an install are written, with the other checks of a
        write, and refuses by raising ServiceError (the web UI: ``classic_open`` while a classic window is open)."""
        self.root = Path(root).resolve()
        self.catalog = catalog
        self.game = game  # unused: the library reads game files through its pins
        self.settings = settings
        self.data_id = data_id
        self._scan_allowed_input = scan_allowed
        self._write_check = write_check
        self._lock = threading.RLock()
        self._hashes = Fingerprints()
        self._legacy_import_matches: dict[str, str | None] = {}
        self._writing_mods = False
        self._transacting = False
        self._deferred_prunes = 0
        self._prune_pending = False
        self._records: dict[str, dict[str, Any]] = {}
        self._remap_previews: dict[str, dict] = {}
        self._favorites: set[str] = set()
        self._applied: dict[str, dict[str, Any]] = {}
        self._migrations: set[str] = set()
        self._migration_pending = False
        self._base: tuple[dict, set, dict, set] = ({}, set(), {}, set())  # the state as last read or written, for merges
        self._version = 0  # bumped by every change of _applied, so a scan can tell it is stale
        self._pruned_cores: set[str] = set()
        # per install key: (folders' signature, index, its files, generation); file name -> lower-case core
        self._indexes: dict[str, tuple[tuple, dict[str, list[Path]], frozenset, int]] = {}
        self._cores: dict[str, str] = {}
        self._generation = 0
        self._maps: dict[str, tuple[int, CoreMap]] = {}
        self._names_cache: dict[str, tuple[int, dict[str, Path]]] = {}
        self._originals_cache: tuple[Any, dict[str, int]] | None = None
        self._maps_cache: tuple[tuple, Any] | None = None
        self.profiles = Profiles(self.root)
        staging.cleanup(self.root)
        self._load()
        with self._lock:
            try:
                self._recover_pending()
                self._lookup_records()
                self._migrate_collection_slots()
                self._known()
            except ServiceError as error:
                log_failure(logger, logging.WARNING, "Mod configuration not looked up", error)
            except Exception as error:  # the library still works without it; the next build tries again
                log_failure(logger, logging.ERROR, "Mod configuration lookup failed", error)

    # --- state.json ---

    def _parse_state(self, data: Any) -> tuple[dict, set, dict, set]:
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("not a version 1 library state")
        records = {}
        for record in data.get("mods", []):
            mod_id = record["id"]
            if not isinstance(mod_id, str) or len(mod_id) != 32 or any(c not in "0123456789abcdef" for c in mod_id):
                continue
            files = record["files"]
            if not files or not all(isinstance(f, str) and Path(f).name == f and f.endswith(".bundle") for f in files):
                continue
            if not all(isinstance(record[key], str) for key in ("label", "target", "added")):
                continue
            if not supports_kind(record["kind"]) or not isinstance(record["seen"], bool):
                continue
            if "assignment" in record and (not isinstance(record["assignment"], str) or not record["assignment"]):
                continue
            if all((self.root / "mods" / mod_id / f).is_file() for f in files):
                records[mod_id] = record
        favorites = {key for key in data.get("favorites", []) if isinstance(key, str)}
        applied = {
            path: record for path, record in data.get("applied", {}).items()
            if isinstance(path, str) and isinstance(record, dict)
            and isinstance(record.get("source"), str) and isinstance(record.get("sha1"), str)
        }
        migrations = {key for key in data.get("migrations", []) if isinstance(key, str)}
        return records, favorites, applied, migrations

    def _load(self) -> None:
        self._seen = self._state_signature()
        try:
            state = self._parse_state(json.loads((self.root / "state.json").read_text(encoding="utf-8")))
        except FileNotFoundError:
            return
        except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            log_failure(logger, logging.WARNING, "Ignoring unreadable library state", error)
            return
        self._records, self._favorites, self._applied, self._migrations = state
        self._base = copy.deepcopy(state)
        self._migration_pending = LEGACY_REMAP not in self._migrations
        if self._migration_pending:
            try:
                self._save()
            except OSError as error:
                log_failure(logger, logging.WARNING, "Could not migrate legacy remapped mods", error)

    def _state_signature(self) -> tuple[int, int] | None:
        try:
            stat = (self.root / "state.json").stat()
        except OSError:
            return None
        return stat.st_mtime_ns, stat.st_size

    def _refresh_state(self) -> None:
        """Take in what another instance sharing the library wrote to state.json since this one last read or wrote
        it (its size or date changed), keeping this instance's own changes not saved yet."""
        self._recover_pending()
        if self._state_signature() == self._seen:
            if self._migration_pending:
                self._save()
            return
        with file_lock(self.root / "state.json.lock"):
            signature_ = self._state_signature()
            try:
                disk = self._parse_state(json.loads((self.root / "state.json").read_text(encoding="utf-8")))
            except FileNotFoundError:
                disk = ({}, set(), {}, set())
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                self._seen = signature_
                return
        base, mine = self._base, (self._records, self._favorites, self._applied, self._migrations)
        self._records = _merge(base[0], mine[0], disk[0])
        self._favorites = (set(disk[1]) | (mine[1] - base[1])) - (base[1] - mine[1])
        self._applied = _merge(base[2], mine[2], disk[2])
        self._migrations = mine[3] | disk[3]
        self._base, self._seen = copy.deepcopy(disk), signature_
        self._version += 1
        self._migration_pending = LEGACY_REMAP not in self._migrations
        if self._migration_pending:
            self._save()

    def _save(self) -> None:
        """Write state.json, merged with what another instance sharing the library wrote since this one last read
        it: this instance's own changes since then (records added, changed or removed by id, game file records
        written or dropped, favourites toggled) applied to the file as it is now, under a lock both share. The
        merged state becomes this instance's only once it is written."""
        path = self.root / "state.json"
        mine = (self._records, self._favorites, self._applied, self._migrations)
        with file_lock(self.root / "state.json.lock"):
            try:
                disk = self._parse_state(json.loads(path.read_text(encoding="utf-8")))
            except FileNotFoundError:
                disk = ({}, set(), {}, set())
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                disk = None
            if disk is None:
                merged = mine
            else:
                base = self._base
                records = _merge(base[0], mine[0], disk[0])
                applied = _merge(base[2], mine[2], disk[2])
                favorites = (set(disk[1]) | (mine[1] - base[1])) - (base[1] - mine[1])
                merged = (records, favorites, applied, mine[3] | disk[3])
            if LEGACY_REMAP not in merged[3]:
                merged = (legacy_remapped(merged[0]), merged[1], merged[2], merged[3] | {LEGACY_REMAP})
            atomic_json(path, {"version": 1, "mods": list(merged[0].values()),
                               "favorites": sorted(merged[1]), "applied": merged[2], "migrations": sorted(merged[3])})
            self._seen = self._state_signature()
        self._records, self._favorites, self._applied, self._migrations = merged
        self._migration_pending = False
        self._base = copy.deepcopy(merged)
        self._version += 1

    # --- mods ---

    @_serialized
    def assigned_targets(self) -> set[str]:
        """Explicit ownership targets represented by stored Mods, including absent local students."""
        return {record["assignment"] for record in self._records.values() if record.get("assignment")}

    @_serialized
    def variant_metadata(self, key: str) -> Any:
        """Resolve stored ownership under the library lock for read-only consumers."""
        return self._variant(key)

    def _variant(self, key: str) -> Any:
        try:
            return self.catalog.variant(key)
        except (KeyError, ServiceError) as error:
            if isinstance(error, ServiceError) and error.code != "catalog_variant_not_found":
                raise
            if callable(getattr(self.catalog, "assignment_variant", None)) and any(
                    (record.get("assignment") or record.get("target")) == key for record in self._records.values()):
                try:
                    return self.catalog.assignment_variant(key)
                except (KeyError, ServiceError) as lookup:
                    if isinstance(lookup, ServiceError) and lookup.code != "catalog_variant_not_found":
                        raise
            # Current NPC bundles may have no roster entry. Their stored filename owns the model slot.
            record = next((record for record in self._records.values() if record["kind"] == "model"
                           and record["target"] == key and core_of(record["files"][0]) == key), None)
            if record:
                from ..catalog.models import Variant
                from ..catalog._names import LANGUAGES, BASE_SHORT
                return Variant(key, key, key, {lang: {"full": key, "short": BASE_SHORT[lang]}
                                               for lang in LANGUAGES}, False, 0, None, None, None, None, None,
                               model=key)
            if isinstance(error, KeyError):
                raise ServiceError("variant_not_found", variant=key) from error
            raise

    def _record(self, mod_id: str) -> dict[str, Any]:
        try:
            return self._records[mod_id]
        except KeyError as error:
            raise ServiceError("mod_not_found", id=mod_id) from error

    def _paths(self, record: dict[str, Any]) -> list[Path]:
        directory = self.root / "mods" / record["id"]
        paths = [directory / name for name in record["files"]]
        if not directory.resolve().is_relative_to(self.root) or any(
                not path.resolve().is_relative_to(directory.resolve()) for path in paths):
            raise ServiceError("mod_unsupported", file=paths[0])
        return paths

    def _target_of(self, record: dict[str, Any]) -> str:
        """The variant a mod belongs to: the one the current catalog gives its core, else its stored target (fixed
        when it was added; a later catalog may name that core by an alias)."""
        if record.get("assignment"):
            return record["assignment"]
        if record["kind"] == "other":
            return record["target"]
        variant = self.catalog.variant_for_core(core_of(record["files"][0]))
        return variant.key if variant is not None else record["target"]

    def _entry(self, record: dict[str, Any]) -> ModEntry:
        paths = self._paths(record)
        parsed = parse_filename(paths[0].name)
        return ModEntry(record["id"], paths[0], self._label(record), self._target_of(record), record["kind"],
                        record["added"], not record["seen"], sum(p.stat().st_size for p in paths),
                        parsed.date, parsed.crc, core_of(paths[0].name),
                        repaired_from=record.get("repaired_from", ""), repaired_id=record.get("repaired_id", ""),
                        user_added=record.get("user_added") is True, alias=record.get("alias", ""),
                        label_base=record["label"])

    def _label(self, record: dict[str, Any], seen: frozenset[str] = frozenset()) -> str:
        """Resolve internal aliases and repaired names without touching bundle names or bytes."""
        alias = record.get("alias")
        if isinstance(alias, str) and alias:
            return alias
        if record.get("roster_photography"):
            return t("webui.photo.modName")
        source = record.get("repaired_from")
        if isinstance(source, str) and source and source not in seen:
            parent = self._records.get(source)
            name = self._label(parent, seen | {record["id"]}) if parent else record["label"]
            return t("webui.remap.name", name=name)
        return record["label"]

    @_serialized
    def mods(self) -> list[ModEntry]:
        """Return the mod entries in insertion order."""
        return [self._entry(record) for record in self._records.values()]

    @property
    def photographs(self):
        from .photographs import Photographs, student_family

        if not hasattr(self, "_photographs"):
            self._photographs = Photographs(self.root, lambda key, catalog=self.catalog: student_family(catalog, key))
        return self._photographs

    def _migrate_collection_slots(self) -> None:
        """Partition legacy shared Collection slots by batch without changing any game bytes."""
        if not any(name.lower().startswith("uis-01_common-14_charactercollect-")
                   for record in self._records.values() for name in record["files"]):
            return
        def update(data):
            changed = False
            for install, folder in data.get("folders", {}).items():
                configured = folder.get("configured", {})
                for old, entry in list(configured.items()):
                    source = entry.get("source", "")
                    record = self._records.get(source[4:], {}) if source.startswith("mod:") else {}
                    names = [name for name in record.get("files", [])
                             if name.lower().startswith("uis-01_common-14_charactercollect-")]
                    targets = {core_of(name) for name in names if "other:" + hashlib.sha256(
                        repr((parse_filename(name).prefix, parse_filename(name).res_type)).encode()).hexdigest() == old}
                    if len(targets) != 1:
                        continue
                    new = targets.pop()
                    if new == old or new in configured:
                        continue
                    configured[new] = configured.pop(old)
                    for field in ("built", "updated"):
                        if old in folder.get(field, {}):
                            folder[field][new] = folder[field].pop(old)
                    for marker in folder.get("dismissed", {}).values():
                        if isinstance(marker, dict) and old in marker:
                            marker[new] = marker.pop(old)
                    for item in data.get("unfinished", []):
                        if item.get("install") == install and item.get("core") == old:
                            item["core"] = new
                    changed = True
            return changed
        self.profiles.update(update)

    @_serialized
    def photograph_choice(self, descriptor: dict, pin: Pin | None = None) -> dict:
        from . import portrait_edit

        return portrait_edit.choice(self, descriptor, self._current(pin))

    @_serialized
    def photograph_removal_info(self, variant: str, key: str) -> dict:
        from .portrait_edit import in_use
        if key == 'official':
            return {'official': True, 'used': False}
        self.photographs._entry(variant, key)
        return {'official': False, 'used': key in in_use(self)}

    @_serialized
    @_mod_writer
    def delete_photograph(self, variant: str, key: str, confirm: bool = False, log: LogFunc = no_log) -> dict:
        from . import portrait_edit

        if key in ("official", None):
            raise ServiceError("asset_official")
        self.photographs._entry(variant, key)
        if key in portrait_edit.in_use(self) and not confirm:
            raise ServiceError("asset_delete_confirm")
        from .asset_delete import transaction
        with transaction(self) as deletion:
            if key in portrait_edit.in_use(self):
                portrait_edit.remove_photo(self, key, log)
            portrait_edit._prune_composites(self)
            deletion.remember_photo(variant, key)
            result = self.photographs.delete(variant, key, portrait_edit.in_use(self))
        return result

    @_serialized
    @_mod_writer
    def apply_photograph(self, variant: str, key: str | None, descriptor: dict, pin: Pin | None = None,
                         log: LogFunc = no_log, progress: ProgressCallback | None = None) -> ApplyResult:
        from . import portrait_edit

        target = self._variant(variant)
        if not getattr(target, "portrait", None) or target.portrait != descriptor.get("name"):
            raise ServiceError("photo_target_unavailable")
        png = self.photographs.image(variant, key) if key is not None else None
        return portrait_edit.apply(self, variant, key, png, descriptor, self._current(pin), log, progress)

    supports_kind = staticmethod(supports_kind)

    def add_files(self, kind: Kind, paths: list[Path], progress: ProgressCallback | None = None,
                  pin: Pin | None = None, *, apply: bool = False, log: LogFunc = no_log,
                  direct: bool = False) -> AddResult:
        """Import a batch of one supported kind, optionally applying through the master switch."""
        if not supports_kind(kind):
            raise ServiceError("mod_unsupported", kind=kind)
        if apply:
            return self.add_and_apply(paths, progress, pin, log, kind=kind)
        return self.add(paths, progress, pin, kind=kind, direct=direct)

    @_serialized
    @_mod_writer
    def add(self, paths: list[Path], progress: ProgressCallback | None = None, pin: Pin | None = None,
            *, kind: Kind | None = None, direct: bool = False) -> AddResult:
        """Store one mod per core and date, deduplicating complete bundle sets. In dev mode (devmode) only files
        inside the dev roots are taken."""
        for path in paths:
            devmode.check_read(path)
        return self._add(paths, progress, pin, kind, direct=direct)

    def _identity(self, files: dict[str, Path]) -> frozenset:
        return frozenset((core_of(name), part_of(name), self._hashes.get(path).sha1) for name, path in files.items())

    @_serialized
    def import_source_identity(self, files: dict[str, Path], target: dict, originals: list[Path]) -> dict:
        """Content identities survive moves; official bytes scope conversions to their target release."""
        return {"files": sorted(([list(part_of(name)), self._hashes.get(path).sha1] for name, path in files.items()),
                                key=lambda item: json.dumps(item)),
                "target": dict(target),
                "originals": sorted([path.name, self._hashes.get(path).sha1] for path in originals)}

    def _output_identity(self, paths: list[Path]) -> list:
        """Bind every stored output hash to its complete part filename."""
        return sorted([path.name, self._hashes.get(path).sha1] for path in paths)

    @_serialized
    def find_import_source(self, source: dict) -> str | None:
        for record in self._records.values():
            matches = [item for item in record.get("import_sources", []) if item.get("source") == source]
            if matches:
                output = self._output_identity(self._paths(record))
                if any(item.get("output") == output for item in matches):
                    return record["id"]
        return None

    @_serialized
    def find_legacy_import_source(self, source: dict, kind: str) -> str | None:
        """Recognize only recorded source hashes, scoped to their target and official release.

        Entries without these records cannot be identified without a rebuild, so skip them.
        Cache both hits and misses until the source, records or stored file revisions change.
        """
        records, revisions = [], []
        for record in self._records.values():
            if record["kind"] != kind or record.get("import_sources") or not record.get("source_hashes"):
                continue
            records.append(record)
            stamps = []
            for path in self._paths(record):
                stat = path.stat()
                stamps.append((path.name, stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
            revisions.append((record["id"], record["source_hashes"], stamps))
        key = json.dumps([source, kind, revisions], sort_keys=True)
        if key not in self._legacy_import_matches:
            match = next((record["id"] for record in records if record["source_hashes"] == source), None)
            if len(self._legacy_import_matches) >= 128:
                self._legacy_import_matches.clear()
            self._legacy_import_matches[key] = match
        return self._legacy_import_matches[key]

    @_serialized
    def legacy_import_snapshot(self, kind: str, target: str) -> list:
        """Limit legacy comparison to this asset's unlinked records and their current bytes."""
        return sorted([record["id"], self._output_identity(self._paths(record))]
                      for record in self._records.values()
                      if record["kind"] == kind and record["target"] == target
                      and not record.get("import_sources") and not record.get("source_hashes"))

    @_serialized
    def find_import_output(self, paths: list[Path], candidates: set[str] | None = None) -> str | None:
        output = self._output_identity(paths)
        records = [record for record in self._records.values()
                   if candidates is None or record["id"] in candidates]
        exact = next((record["id"] for record in records
                      if self._output_identity(self._paths(record)) == output), None)
        if exact or candidates is None:
            return exact
        # Normalize only the container packing and CRC tail. Serialized objects,
        # external references, streams and complete part filenames must still agree.
        def contents(files):
            result = []
            for path in files:
                bundle = Bundle.load(path)
                if bundle is None:
                    raise ServiceError("bundle_invalid", file=path)
                result.append([path.name, hashlib.sha256(bundle.compress("none")).hexdigest()])
            return sorted(result)
        wanted = contents(paths)
        names = {path.name for path in paths}
        for record in records:
            files = self._paths(record)
            if {path.name for path in files} == names and contents(files) == wanted:
                return record["id"]
        return None

    @_serialized
    @_mod_writer
    def remember_import_source(self, mod_id: str, source: dict) -> None:
        record = self._record(mod_id)
        item = {"source": copy.deepcopy(source),
                "output": self._output_identity(self._paths(record))}
        previous = copy.deepcopy(record)
        imports = record.setdefault("import_sources", [])
        if item in imports:
            return
        imports.append(item)
        try:
            self._save()
        except Exception:
            self._records[mod_id] = previous
            raise

    def _known(self) -> dict[frozenset, str]:
        known = {}
        for record in self._records.values():
            identity = self._identity({path.name: path for path in self._paths(record)})
            if identity in known:
                logger.warning("Duplicate library mods: %s (%s), %s (%s)", known[identity],
                               self._records[known[identity]]["label"], record["id"], record["label"])
            else:
                known[identity] = record["id"]
        return known

    def _add(self, paths: list[Path], progress: ProgressCallback | None = None, pin: Pin | None = None,
             expected_kind: Kind | None = None, *, direct: bool = False) -> AddResult:
        known = self._known()
        groups: dict[tuple[str, str], dict[str, Path]] = {}
        targets = {}
        for i, source in enumerate(map(Path, paths)):
            if progress:
                progress(i, len(paths), t("webui.progress.add", name=source.name))
            name = source.name.removesuffix(".backup") if source.name.endswith(".bundle.backup") else source.name
            parsed = parse_filename(name)
            kind = kind_of_file(name)
            if not name.endswith(".bundle"):
                raise ServiceError("mod_unsupported", file=source)
            if not parsed.prefix or not parsed.crc or kind is None:
                fingerprint = self._hashes.get(source).sha1
                matches = [path.name for record in self._records.values() for path in self._paths(record)
                           if self._hashes.get(path).sha1 == fingerprint]
                if len({core_of(name) for name in matches}) != 1:
                    raise ServiceError("mod_unsupported", file=source)
                name = matches[0]
            name, target, kind = (self.identify_import(source, name, pin) if direct else
                                  identify(source, name, self.catalog))
            if expected_kind is not None and kind != expected_kind:
                raise ServiceError("mod_unsupported", file=source)
            parsed = parse_filename(name)
            key = (str(source.parent), "other") if kind == "other" else (parsed.core.lower(), parsed.date)
            targets[key] = (target, kind)
            group = groups.setdefault(key, {})
            if kind == "other":
                previous = next((old for old in group if part_of(old) == part_of(name)), None)
                if previous:
                    if self._hashes.get(group[previous]).sha1 != self._hashes.get(source).sha1:
                        raise ServiceError("mod_target_ambiguous", file=source)
                    if date_of(previous) >= date_of(name):
                        continue
                    del group[previous]
            if name in group and self._hashes.get(group[name]).sha1 != self._hashes.get(source).sha1:
                raise ServiceError("mod_unsupported", file=source)
            group[name] = source

        # Validate every group before storing any part of this upload.
        pin = pin or self.current_pin()
        for group in groups.values():
            if not direct or not self.direct_import(group, pin):
                self._check_group(group, pin, compatibility=False)
        added = AddResult()
        for key, group in groups.items():
            signature_ = self._identity(group)
            if signature_ in known:
                entry = self._entry(self._records[known[signature_]])
                if entry not in added and entry not in added.duplicates:
                    added.duplicates.append(entry)
                if self._recognize_installed(entry.id, signature_):
                    added.installed.append(entry)
                continue
            names = sorted(group)
            parsed = parse_filename(names[0])
            target, kind = targets[key]
            if kind == "other":
                target = other_target(group)
            record = self._store(group, parsed.core, target, kind, user_added=True)
            known[signature_] = record["id"]
            entry = self._entry(record)
            added.append(entry)
            if self._recognize_installed(entry.id, signature_):
                added.installed.append(entry)
        if progress:
            progress(len(paths), len(paths), t("webui.progress.add",
                                              name=paths[-1].name if paths else t("webui.progress.mods")))
        return added

    def _check_group(self, files: dict[str, Path], pin: Pin | None, *, compatibility: bool = True,
                     dependencies: bool = True, conversion: bool = False, variant_key: str | None = None,
                     inspection: integrity.Inspection | None = None) -> dict:
        inspect = inspection.inspect if inspection else integrity.inspect
        selected, official, effective = integrity.Contents(), integrity.Contents(), integrity.Contents()
        sources = {name: inspect(path, allow_unknown=True) if conversion else inspect(path)
                   for name, path in files.items()}
        core = core_of(next(iter(files)))
        kind = kind_of_file(next(iter(files)))
        target_core = core
        targets = (self._other_targets(files, pin) if kind == "other" else self._spine_parts(core, pin)) if pin else []
        if pin and not targets and variant_key and kind != "other":
            target_core = self._core_map(pin).core(variant_key, kind) or core
            targets = self._spine_parts(target_core, pin)
        if targets and kind != "other":
            target_core = parse_filename(targets[0].name).core
        originals, original_paths = {}, []
        unavailable = not targets
        for target in targets:
            try:
                original = self._official_for(target, pin, game_first=True)
                originals[target] = inspect(original)
                original_paths.append(original)
            except ServiceError as error:
                if error.code not in ("original_unavailable", "original_invalid"):
                    raise
                unavailable = True
        for contents in originals.values():
            official.merge(contents)
        expected = official.platforms or {"StandaloneWindows64"}
        for name, contents in sources.items():
            if not conversion:
                integrity.check_platform(contents, files[name], expected)
            selected.merge(contents)
        parts = set()
        for name in files:
            prefix, res_type = part_of(name)
            if kind != "other":
                prefix = prefix.replace(f"-{parse_filename(name).core}-", f"-{target_core}-", 1)
            parts.add((prefix, res_type))
        for target, contents in originals.items():
            if part_of(target.name) not in parts:
                effective.merge(contents)
        if not compatibility:
            # Import validates dependencies only; absent text parts use the current official assets.
            paired = atlas_remap.pair_atlases(selected.atlases, official.atlases)
            selected.atlases = {**{name: data for name, data in official.atlases.items() if name not in paired},
                               **selected.atlases}
        effective.merge(selected)
        missing = (integrity.missing_parts(effective, official)
                   if dependencies and (not compatibility or kind in ("model", "other")) else set())
        if missing:
            # Name omitted files from the selected folders, without importing them.
            names = dict(effective.reference_names)
            for folder in {path.parent for path in files.values()}:
                for path in sorted([*folder.glob("*.bundle"), *folder.glob("*.bundle.backup")]):
                    if path not in files.values() and core_of(path.name) == core:
                        try:
                            contents = inspect(path)
                        except ServiceError:
                            continue
                        names.update({name: path.name for name in contents.files})
                        names.update({name + ".png": path.name for name in contents.textures})
            raise ServiceError("mod_parts_missing", files=", ".join(sorted({names.get(name, name) for name in missing})))
        if not compatibility:
            return {}
        report = {"kind": kind, "official": official.spine(), "mod": effective.spine(), "unavailable": unavailable,
                "outdated": bool(targets) and set(files) != {path.name for path in targets
                    if part_of(path.name) in parts}}
        if conversion:
            # Internal preflight metadata; ordinary compatibility RPCs remain JSON-only.
            report["sourceContents"], report["officialContents"] = selected, official
            report["originalPaths"] = original_paths
        try:
            mixed = {name: data for name, data in effective.atlases.items() if name not in selected.atlases
                     and any(integrity.texture_key(page) in selected.textures
                             for page in atlas_remap.parse_atlas(data, name).pages)}
            report["remappable"] = not unavailable and bool(mixed) and atlas_remap.page_size_mismatch(mixed, effective.textures)
        except (ValueError, UnicodeError):
            report["remappable"] = False
        return report

    @_serialized
    def compatibility_stamp(self, mod_id: str, pin: Pin | None = None) -> str:
        """Read-only identity of the Mod and every candidate official source used by compatibility checks."""
        record = self._record(mod_id)
        pin = pin or self.current_pin()
        files = {path.name: path for path in self._paths(record)}
        core = core_of(next(iter(files)))
        kind = kind_of_file(next(iter(files)))
        targets = (self._other_targets(files, pin) if kind == "other" else self._spine_parts(core, pin)) if pin else []
        if pin and not targets and kind != "other":
            target_core = self._core_map(pin).core(self._target_of(record), kind) or core
            targets = self._spine_parts(target_core, pin)
        paths = set(files.values()) | set(targets)
        for target in targets:
            paths.update([self._original_path(target), target.with_name(target.name + ".backup"), *self._elsewhere(target)])
        stamps = []
        for path in sorted(paths):
            try:
                stat = path.stat()
                stamp = [stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
            except FileNotFoundError:
                stamp = None
            stamps.append([str(path.resolve()), stamp])
        identity = [pin.key if pin else None, self._target_of(record), record.get("repaired_from"), record.get("repaired_id"), stamps]
        return hashlib.sha256(json.dumps(identity).encode()).hexdigest()

    @_serialized
    def compatibility(self, mod_id: str, pin: Pin | None = None,
                      progress: Callable[[dict], None] | None = None) -> dict:
        """Fresh official and effective Spine data, without building or rewriting a mod."""
        record = self._record(mod_id)
        if progress:
            progress({"current": 1, "total": 1, "step": "import.step.check"})
        report = self._check_group({path.name: path for path in self._paths(record)}, pin or self.current_pin(),
                                   variant_key=self._target_of(record))
        report["repaired_from"], report["repaired_id"] = record.get("repaired_from", ""), record.get("repaired_id", "")
        report["remappable"] = report["remappable"] and not (report["repaired_from"] or report["repaired_id"])
        return report

    @_serialized
    def identify_import(self, path: Path, name: str, pin: Pin | None = None) -> tuple[str, str, str]:
        """Current official slots own their identity even when a Mod renames its assets."""
        pin = pin or self.current_pin()
        targets = (self._other_targets({name: path}, pin) if kind_of_file(name) == "other"
                   else self._spine_parts(core_of(name), pin)) if pin else []
        return identify(path, name, self.catalog, filename_only=bool(integrity.replacements({name: path}, targets)))

    @_serialized
    def direct_import(self, files: dict[str, Path], pin: Pin | None = None, *,
                      inspection: integrity.Inspection | None = None) -> dict | None:
        """Validate current parts and the resulting set before admitting a whole-file copy."""
        pin = pin or self.current_pin()
        if not pin:
            return None
        name = next(iter(files))
        targets = (self._other_targets(files, pin) if kind_of_file(name) == "other"
                   else self._spine_parts(core_of(name), pin))
        replacements = integrity.replacements(files, targets)
        if not replacements:
            return None
        inspection = inspection or integrity.Inspection()
        selected, official, originals = integrity.Contents(), integrity.Contents(), []
        identities = []
        for target, source in replacements.items():
            original = self._official_for(target, pin, game_first=True)
            incoming, baseline = inspection.metadata(source), inspection.metadata(original)
            integrity.check_format(incoming, source, baseline)
            identities.append((source, incoming, baseline))
            selected.merge(inspection.inspect(source))
            official.merge(inspection.inspect(original))
            originals.append(original)
        target_origin = mod_origin.target_of(self.settings, pin, official)
        evidence, error = mod_origin.constraints(set(files), selected, official, target_origin)
        if error or (evidence.get("server") and evidence["server"] != target_origin["server"]):
            raise ServiceError(error or "source_conflict")
        # Retained official prefabs must still resolve into the replacement CABs.
        compatibility = self._check_group(files, pin, conversion=True, inspection=inspection)
        self._check_group(files, pin, compatibility=False, inspection=inspection)
        if compatibility["unavailable"]:
            raise ServiceError("original_unavailable")
        for source, incoming, baseline in identities:
            if not incoming.files:
                raise ServiceError("mod_release_mismatch", file=source.name)
            if kind_of_file(name) == "model":
                self._check_model_references(source, incoming, baseline, replacements, targets, pin, inspection)
            elif incoming.files != baseline.files or incoming.layout != baseline.layout:
                raise ServiceError("mod_release_mismatch", file=source.name)
        inspection.validate()
        source_origin, error = mod_origin.source_of(set(files), selected, official, target_origin)
        if error:
            raise ServiceError(error)
        return {"direct": replacements, "targets": list(replacements), "originals": originals,
                "sourceContents": selected, "officialContents": official, "source": source_origin,
                "compatibility": compatibility}

    def _check_model_references(self, source: Path, incoming: integrity.Contents, baseline: integrity.Contents,
                                replacements: dict[Path, Path], targets: list[Path], pin: Pin,
                                inspection: integrity.Inspection) -> None:
        """Only changes to objects consumed outside a replaced part can break its public interface."""
        changed = {}
        for cab, layout in baseline.layout.items():
            replacement = dict(incoming.layout.get(cab, ()))
            ids = {path_id for path_id, kind in layout if replacement.get(path_id) != kind}
            if ids:
                changed[cab] = ids
        removed_cabs = baseline.files - incoming.files
        if not changed and not removed_cabs:
            return  # Preserving every original object is safe without scanning other bundles.
        consumers = {path: path for paths in self._index(pin).values() for path in paths}
        for target in targets:
            consumers[target] = (replacements[target] if target in replacements else
                                 self._official_for(target, pin, game_first=True))
        for path in consumers.values():
            if path != source and integrity.references_changed_objects(path, changed, removed_cabs, inspection):
                raise ServiceError("mod_release_mismatch", file=source.name)

    @_serialized
    def inspect_import(self, files: dict[str, Path], pin: Pin | None = None, *, conversion: bool = False,
                       inspection: integrity.Inspection | None = None) -> dict:
        """Preflight canonical upload names without storing or adopting anything.

        Use the same identities, dependency checks and installed-content judgement as add().
        Original recovery is deliberately separate: an already installed upload can be recognized
        even when an outside installer left no official copy behind.
        """
        for path in files.values():
            devmode.check_read(path)
            if inspection:
                inspection.check(path)
        identity = self._identity(files)
        if inspection:
            inspection.validate()
        duplicate = self._known().get(identity)
        core_name = core_of(next(iter(files)))
        pin = pin or self.current_pin()
        generic = kind_of_file(next(iter(files))) == "other"
        targets = []
        if pin:
            try:
                targets = self._other_targets(files, pin) if generic else self._spine_parts(core_name, pin)
            except ServiceError:
                if not duplicate:
                    raise
        installed = False
        if pin:
            view = self._view([pin], "full")
            entry = view.entry(pin, core_name)
            if generic:
                entry.parts = [view.part(path, pin, "other") for path in targets]
            installed = self._matches_installed(identity, entry)
        if (duplicate or installed) and not conversion:
            return {"identity": identity, "libraryId": duplicate, "installed": installed, "targets": targets}
        rebuild = False
        try:
            direct = self.direct_import(files, pin, inspection=inspection) if conversion else None
        except ServiceError as error:
            if (duplicate or installed) and error.code in ("original_unavailable", "original_invalid"):
                return {"identity": identity, "libraryId": duplicate, "installed": installed,
                        "targets": targets, "recognized": True}
            if kind_of_file(next(iter(files))) not in ("spr", "lobby") or error.code not in (
                    "mod_platform_mismatch", "mod_platform_unknown", "mod_unity_version_mismatch",
                    "mod_release_mismatch", "source_conflict"):
                raise
            # Current Spine filenames identify slots, not a compatible whole-file format.
            # Preserve this verdict even on the same platform: extraction and target
            # rebuilding must succeed before add() validates and stores the output.
            direct, rebuild = None, True
        if direct:
            return {"identity": identity, "libraryId": duplicate, "installed": installed, **direct}
        report = self._check_group(files, pin, dependencies=False, conversion=conversion, inspection=inspection)
        # Old CAB references are replaced by the rebuild. Its output goes through add()'s full preflight.
        if not report["outdated"] and not conversion:
            self._check_group(files, pin, compatibility=False, inspection=inspection)
        originals = report.pop("originalPaths", []) if conversion else (
            [self._official_for(path, pin) for path in targets] if generic else [])
        return {"identity": identity, "libraryId": duplicate, "installed": installed, "compatibility": report,
                "targets": targets, "originals": originals if generic else [], "rebuild": rebuild}

    @_serialized
    def apply_import(self, variant_key: str, source: str, *, kind: Kind, pin: Pin,
                     settings: Settings, backup: bool, log: LogFunc = no_log,
                     progress: ProgressCallback | None = None) -> ApplyResult:
        """Apply with one import's save settings, retaining the normal switch and transaction checks.

        The settings adapter is local to this serialized operation; neither config.toml nor
        the shared Settings object changes. Deferred configurations use the usual switch flow.
        """
        previous = self.settings
        self.settings = settings
        try:
            return self.apply(variant_key, source, kind=kind, pin=pin, log=log,
                              progress=progress, create_backup=backup)
        finally:
            self.settings = previous

    def add_and_apply(self, paths: list[Path], progress: ProgressCallback | None = None,
                      pin: Pin | None = None, log: LogFunc = no_log, *, kind: Kind | None = None) -> AddResult:
        """The web add action: store, check, then use the same switch as a source selection."""
        pin = pin or self.current_pin()
        added = self.add(paths, progress, pin=pin, kind=kind)
        for entry in added:
            try:
                result = self.apply(entry.target, f"mod:{entry.id}", kind=entry.kind, pin=pin, log=log,
                                    progress=progress)
            except ServiceError as error:
                added.failed.append({"id": entry.id, **error.to_json()})
                if (pin is not None and entry.kind != "other"
                        and self.configured(entry.target, pin).get(entry.kind) == f"mod:{entry.id}"):
                    added.configured.append(entry)
            else:
                (added.configured if result.deferred else added.applied).append(entry)
        return added

    @_serialized
    @_mod_writer
    def add_assigned_files(self, files: dict[str, Path], variant: str, kind: str,
                           pin: Pin | None = None) -> AddResult:
        """Store an explicitly attributed, self-contained Mod without claiming an install target."""
        from .manual_identity import validate

        self.catalog.assignment_variant(variant)
        validate(files, kind)
        signature = self._identity(files)
        known = self._known().get(signature)
        result = AddResult()
        if known:
            record = self._record(known)
            if self._target_of(record) != variant or record["kind"] != kind:
                raise ServiceError("mod_target_mismatch", id=known, variant=variant)
            result.duplicates.append(self._entry(record))
            return result
        record = self._store(files, variant, variant, kind, user_added=True, assignment=variant)
        result.append(self._entry(record))
        return result

    def _store(self, files: dict[str, Path], label: str, target: str, kind: str,
               *, repaired_from: str = "", user_added: bool = False, assignment: str = "",
               metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        """Publish a complete directory before its metadata, with durable recovery of either outcome."""
        names = sorted(files)
        if not names or any(Path(name).name != name or not name.endswith(".bundle") for name in names):
            raise ServiceError("mod_unsupported")
        mod_id = uuid.uuid4().hex
        directory = self.root / "mods" / mod_id
        transaction = self.root / "import-transactions" / mod_id
        journal = transaction / "journal.json"
        staged = transaction / "files"
        if directory.parent.is_symlink() or transaction.parent.is_symlink() or directory.exists() or transaction.exists():
            raise ServiceError("library_io_error", file=transaction)
        record = {"id": mod_id, "files": names, "label": label, "target": target,
                  "kind": kind, "added": datetime.now(timezone.utc).isoformat(), "seen": False,
                  "user_added": user_added}
        if metadata:
            if set(metadata) & set(record):
                raise ValueError("Generated Mod metadata overrides a reserved field")
            record.update(copy.deepcopy(metadata))
        if repaired_from:
            record["repaired_from"] = repaired_from
        if assignment:
            record["assignment"] = assignment
        hashes = {name: self._hashes.get(files[name]).sha1 for name in names}
        data = {"version": 1, "id": mod_id, "phase": "preparing", "record": record, "hashes": hashes,
                "repaired_from": repaired_from,
                "old_repaired_id": self._record(repaired_from).get("repaired_id") if repaired_from else None}
        atomic_json(journal, data)
        try:
            for name in names:
                atomic_copy(files[name], staged / name)
                verify_file(staged / name, hashes[name])
                if self._hashes.get(files[name]).sha1 != hashes[name]:
                    raise ServiceError("entry_changed", core=core_of(name))
            data["phase"] = "publishing"
            atomic_json(journal, data)
            directory.parent.mkdir(parents=True, exist_ok=True)
            sync_directory(self.root)
            os.replace(staged, directory)
            sync_directory(directory.parent)
            sync_directory(transaction)
            self._records[mod_id] = record
            if repaired_from:
                self._record(repaired_from)["repaired_id"] = mod_id
            self._save()
        except Exception as error:
            try:
                data["phase"] = "rollback"
                atomic_json(journal, data)
                self._rollback_import(journal, data)
            except Exception as recovery_error:
                log_failure(logger, logging.ERROR, "Mod import rollback pending", recovery_error)
                raise ServiceError("library_recovery_pending", file=journal) from error
            raise
        # Metadata publication is the commit point. A leftover journal is safe:
        # recovery verifies the complete committed group before removing it.
        try:
            shutil.rmtree(transaction)
            sync_directory(transaction.parent)
        except OSError as error:
            log_failure(logger, logging.WARNING, "Committed import journal retained", error)
        return record

    def _rollback_import(self, journal: Path, data: dict) -> None:
        mod_id = data["id"]
        directory = self.root / "mods" / mod_id
        if (re.fullmatch(r"[0-9a-f]{32}", mod_id) is None or directory.parent.is_symlink()
                or directory.is_symlink() or not directory.resolve().is_relative_to(self.root)
                or journal.is_symlink() or journal.parent.is_symlink()
                or not journal.resolve().is_relative_to(self.root / "import-transactions")):
            raise ServiceError("library_io_error", file=journal)
        self._records.pop(mod_id, None)
        repaired = self._records.get(data["repaired_from"])
        if repaired and repaired.get("repaired_id") == mod_id:
            if data["old_repaired_id"] is None:
                repaired.pop("repaired_id", None)
            else:
                repaired["repaired_id"] = data["old_repaired_id"]
        path = self.root / "state.json"
        with file_lock(self.root / "state.json.lock"):
            try:
                state = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                state = None
            if state is not None:
                if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("mods"), list):
                    raise ServiceError("library_io_error", file=path)
                before = copy.deepcopy(state)
                state["mods"] = [record for record in state["mods"] if record.get("id") != mod_id]
                for record in state["mods"]:
                    if record.get("id") == data["repaired_from"] and record.get("repaired_id") == mod_id:
                        if data["old_repaired_id"] is None:
                            record.pop("repaired_id", None)
                        else:
                            record["repaired_id"] = data["old_repaired_id"]
                if state != before:
                    atomic_json(path, state)
            # A prior replace may have succeeded before its directory flush failed.
            # Prove the metadata removal durable even when this retry changes no JSON.
            sync_directory(self.root)
        self._seen = None
        self._refresh_state()
        if directory.exists():
            shutil.rmtree(directory)
            sync_directory(directory.parent)
        shutil.rmtree(journal.parent)
        sync_directory(journal.parent.parent)

    def _recover_imports(self) -> None:
        root = self.root / "import-transactions"
        if root.is_symlink():
            raise ServiceError("library_io_error", file=root)
        journals = sorted(root.glob("*/journal.json"))
        if not journals:
            return
        with file_lock(self.root / "mods.lock"):
            for journal in journals:
                try:
                    if (journal.is_symlink() or journal.parent.is_symlink()
                            or not journal.resolve().is_relative_to(root.resolve())):
                        raise ValueError("Invalid import journal path")
                    data = json.loads(journal.read_text(encoding="utf-8"))
                    mod_id, record, hashes = data["id"], data["record"], data["hashes"]
                    if (not isinstance(mod_id, str) or re.fullmatch(r"[0-9a-f]{32}", mod_id) is None
                            or journal != root / mod_id / "journal.json" or journal.is_symlink()
                            or journal.parent.is_symlink() or not isinstance(record, dict)
                            or record.get("id") != mod_id or not isinstance(hashes, dict)
                            or data["version"] != 1 or data["phase"] not in ("preparing", "publishing", "rollback")
                            or not record.get("files") or set(record["files"]) != set(hashes)
                            or any(not isinstance(name, str) or Path(name).name != name or not name.endswith(".bundle")
                                   or not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{40}", value) is None
                                   for name, value in hashes.items())):
                        raise ValueError("Invalid import journal")
                    directory = self.root / "mods" / mod_id
                    if (directory.parent.is_symlink() or directory.is_symlink()
                            or not directory.resolve().is_relative_to(self.root)):
                        raise ValueError("Invalid import directory")
                    committed = self._records.get(mod_id)
                    if data["phase"] == "publishing" and committed and committed.get("files") == record["files"]:
                        for name, digest in hashes.items():
                            if (directory / name).is_symlink():
                                raise ValueError("Invalid imported file")
                            verify_file(directory / name, digest)
                        sync_directory(directory)
                        sync_directory(directory.parent)
                        sync_directory(self.root)
                        shutil.rmtree(journal.parent)
                        sync_directory(root)
                    else:
                        self._rollback_import(journal, data)
                except Exception as error:
                    raise ServiceError("library_recovery_pending", file=journal) from error

    @_mod_writer
    def _add_group(self, paths: list[Path], label: str, pin: Pin) -> tuple[str, bool]:
        """Store the parts of one core as one mod, whatever their dates, keyed by the variant key the install's own
        core map gives the core (a core the current catalog does not map is stored too). Returns the id of the mod
        and whether it was created: a part set already in the library is not stored twice."""
        files = {path.name: path for path in paths}
        signature_ = self._identity(files)
        existing = self._known().get(signature_)
        if existing is not None:
            return existing, False
        core_name = core_of(paths[0].name)
        kind = kind_of_file(paths[0].name)
        if kind is None:
            raise ServiceError("mod_unsupported", file=paths[0])
        key = other_target(files) if kind == "other" else self._core_map(pin).key(core_name) or core_name.lower()
        return self._store(files, label if kind == "other" else core_name, key, kind)["id"], True

    def _recognize_installed(self, mod_id: str, identity: frozenset) -> bool:
        """Adopt exact outside content without writing any game files."""
        record = self._records[mod_id]
        cores = {core_of(name) for name in record["files"]}
        matched = False
        for pin in self.installs():
            view = self._view(self._view_pins(pin), "full")
            entries = [view.entry(pin, core) for core in cores]
            parts = [part for entry in entries for part in entry.parts]
            if not parts or not self._identity({p.path.name: p.path for p in parts if not p.official}) <= identity:
                continue
            for entry in entries:
                local = frozenset(item for item in identity if item[0] == entry.core)
                if entry.state not in ("untracked", "changed") or not self._matches_installed(local, entry):
                    continue
                try:
                    self._adopt_one(pin, entry.core, mod_id=mod_id)
                except ServiceError as error:
                    if error.code != "entry_changed":
                        raise
                else:
                    matched = True
        return matched

    def _matches_installed(self, identity: frozenset, entry: _Entry) -> bool:
        files = {part.path.name: part.path for part in entry.parts}
        modified = {part.path.name: part.path for part in entry.parts if not part.official}
        if entry.kind == "other":
            slots = {core_of(name) for name in files}
            identity = frozenset(item for item in identity if item[0] in slots)
        return bool(modified) and self._identity(modified) <= identity <= self._identity(files)

    @_serialized
    def other_mods(self, pin: Pin | None = None) -> list[dict]:
        """Settings' generic sources, with their target files and current install's configuration."""
        pin = pin or self.current_pin()
        view = self._view([pin], "full") if pin else None
        rows = []
        for record in self._records.values():
            if record["kind"] != "other" or record.get("roster_photography"):
                continue
            source = f"mod:{record['id']}"
            try:
                targets = self._game_files(record["target"], "other", pin) if pin else []
            except ServiceError:
                targets = []
            entries = [view.entry(pin, core_of(path.name)) for path in targets]
            selected = sum(entry.configured == source for entry in entries)
            active = sum(entry.carried == source for entry in entries)
            state = "official" if all(not entry.configured and entry.carried == "official" for entry in entries) else "inactive"
            if not entries:
                state = "missing"
            elif selected == len(entries):
                state = "active" if active == len(entries) and profiles_mod.enabled(self.profiles.read()) else "set"
            elif any(entry.state not in ("ok", "pending") for entry in entries):
                state = "changed"
            elif selected or active:
                state = "mixed"
            rows.append({"id": record["id"], "label": self._label(record), "target": record["target"],
                         "files": [path.name for path in targets] or list(record["files"]),
                         "selected": bool(entries) and selected == len(entries), "state": state})
        return rows

    @_serialized
    def removal_info(self, mod_id: str) -> dict:
        """The confirmation's name and whether any configuration or applied record uses this source."""
        return self._removal_info(mod_id)

    def _removal_info(self, mod_id: str) -> dict:
        source = f"mod:{mod_id}"
        used = any(entry.get("source") == source
                   for folder in ((self.profiles.read() or {}).get("folders") or {}).values()
                   for entry in folder["configured"].values()) or bool(self._in_use(mod_id))
        return {"name": self._label(self._record(mod_id)), "used": used}

    @_serialized
    @_mod_writer
    def remove(self, mod_id: str, confirm: bool = False, log: LogFunc = no_log,
               reconcile: Callable[[], None] | None = None) -> DeleteResult:
        """Reconcile every use through the protected writer before deleting its managed source."""
        if mod_id == 'official':
            raise ServiceError('asset_official')
        record = self._record(mod_id)
        directory = self.root / "mods" / mod_id
        self._paths(record)  # refuse a stored directory or file that resolves outside the library
        source = f"mod:{mod_id}"
        pins = self._all_pins()
        for name, applied in self._applied.items():
            if applied.get("source") == source and not any(Path(name).parent in pin.dirs for pin in pins):
                folder = _game_folder(Path(name))
                if devmode.allows_read(folder):
                    pin = self._pin(folder, self.settings.server_region() if self.settings else "global")
                    if pin is not None:
                        pins.append(pin)
        by_key = {pin.key: pin for pin in pins}
        affected = set()
        for name, applied in self._applied.items():
            if applied.get("source") == source:
                path = Path(name)
                affected.update((pin.key, core_of(path.name)) for pin in pins if path.parent in pin.dirs)
        keys: list[dict] = []

        def change(data: dict) -> None:
            affected.update(_drop_source(data, source, keys))
            for folder in data["folders"].values():
                for entries in folder["dismissed"].values():
                    if isinstance(entries, dict):
                        entries.pop(core_of(record["files"][0]), None)
            for key, core in affected:
                folder = data["folders"].get(key)
                if folder:
                    folder["updated"].pop(core, None)
                    for entries in folder["dismissed"].values():
                        if isinstance(entries, dict):
                            entries.pop(core, None)
            data["unfinished"] = [item for item in data["unfinished"]
                                  if (item["install"], item["core"]) not in affected]

        if self._removal_info(mod_id)["used"] and not confirm:
            raise ServiceError("asset_delete_confirm")
        from .asset_delete import transaction
        done = []
        try:
            with transaction(self) as deletion:
                deletion.remember_mods([mod_id])
                self._update_profiles(change)
                if profiles_mod.enabled(self.profiles.read()):
                    for key, core in sorted(affected):
                        pin = by_key.get(key)
                        if pin is None:
                            raise ServiceError('game_not_found')
                        config = (self.profiles.read() or {}).get('folders', {}).get(key, {})
                        target = config.get('configured', {}).get(core, {}).get('source', 'official')
                        with _errors('restore'):
                            self._switch(pin, core, target, log)
                        done.append({'install': key, 'core': core})
                for applied in self._applied.values():
                    if applied.get('source') == source:
                        applied.update(source='removed', removed=True)
                        applied.pop('build', None)
                del self._records[mod_id]
                self._save()
                shutil.rmtree(directory)
                self._delete_built_files(keys, self.profiles.read())
                if reconcile:
                    reconcile()
        except ServiceError as error:
            return DeleteResult([], [{'entry': {'id': mod_id}, **error.to_json()}], [], [], [])
        self._prune_quietly()
        return DeleteResult(done, [], [{'install': key, 'core': core} for key, core in sorted(affected)],
                            sorted({core for _, core in affected}), [record['kind']] if affected else [])

    def _in_use(self, mod_id: str) -> list[Path]:
        """The game files still carrying the mod: stats and tails first, then SHA-1 when their stamp changed.
        A part the mod left official carries nothing of it."""
        paths = []
        for name, record in self._applied.items():
            if record.get("source") != f"mod:{mod_id}" or record.get("removed"):
                continue
            path = Path(name)
            try:
                if not path.is_file():
                    continue
                stat = path.stat()
                matched = record.get("size") == stat.st_size and (
                    record.get("mtime") == stat.st_mtime_ns
                    or (bool(record.get("tail")) and read_tail(path) == record["tail"]))
                if not matched and self._hashes.get(path).sha1 != record.get("sha1"):
                    continue
                flag = record.get("official")
                if not isinstance(flag, bool):
                    expected = self._official_size(path.name)
                    flag = trailing_bytes(path) == 0 and (expected is None or expected == stat.st_size)
                if not flag:
                    paths.append(path)
            except OSError:
                continue
        return paths

    def _official_size(self, name: str) -> int | None:
        original = self._original_path(Path(name))
        with contextlib.suppress(OSError):
            return original.stat().st_size
        return next((record.get("size") for path, record in self._applied.items()
                     if Path(path).name == name and says_official(record) and isinstance(record.get("size"), int)),
                    None)

    @_serialized
    def rename(self, mod_id: str, label: str) -> ModEntry:
        """Set or clear a metadata-only alias, retaining the default name."""
        if not isinstance(label, str):
            raise ServiceError("bad_params", key="label")
        alias = " ".join("".join(ch for ch in unicodedata.normalize("NFC", label)
                                 if ch.isspace() or not unicodedata.category(ch).startswith("C")).split())
        if len(alias) > 120:
            raise ServiceError("bad_params", key="label")
        record = self._record(mod_id)
        old = record.get("alias")
        if alias:
            record["alias"] = alias
        else:
            record.pop("alias", None)
        try:
            self._save()
        except OSError:
            if old is None:
                record.pop("alias", None)
            else:
                record["alias"] = old
            raise
        return self._entry(self._record(mod_id))

    @_serialized
    def mark_seen(self, mod_id: str) -> None:
        """Clear a mod's fresh flag."""
        record = self._record(mod_id)
        old = record["seen"]
        record["seen"] = True
        try:
            self._save()
        except OSError:
            record["seen"] = old
            raise

    @_serialized
    def favorites(self) -> set[str]:
        """Return a snapshot of the favorite variant keys."""
        return set(self._favorites)

    @_serialized
    def set_favorite(self, variant_key: str, on: bool) -> None:
        """Set a variant's favorite flag."""
        self._variant(variant_key)
        old = set(self._favorites)
        if on:
            self._favorites.add(variant_key)
        else:
            self._favorites.discard(variant_key)
        try:
            self._save()
        except OSError:
            self._favorites = old
            raise

    # --- game folders ---

    def _scan_allowed(self) -> bool:
        """Whether the scan consent is given, asked at each use (it can change while the library lives)."""
        try:
            return bool(self._scan_allowed_input())
        except Exception as error:
            log_failure(logger, logging.WARNING, "Cannot read the scan consent", error)
            return False

    def _pin(self, folder: Path, server: str) -> Pin | None:
        if not folder.is_dir():
            return None
        root = install_root(folder)
        dirs = tuple(directory.resolve() for directory in get_search_dirs(folder))
        if not dirs:
            return None
        return Pin(install_key(root), root, dirs, server)

    def _named_pins(self) -> list[Pin]:
        """The Global and Japan folders the settings name, each when it is set and exists, whatever the file source.
        In dev mode (devmode) a folder outside the dev roots is not used, as the settings' own game folder."""
        out: list[Pin] = []
        if self.settings is None:
            return out
        for setting, server in (("game_resource_dir", "global"), ("game_resource_dir_japan", "japan")):
            try:
                value = self.settings.get(setting)
            except KeyError:
                continue
            if not value or not devmode.allows_read(value):
                continue
            pin = self._pin(Path(value), server)
            if pin is not None and all(other.key != pin.key for other in out):
                out.append(pin)
        return out

    def _recorded_pin(self, key: str, folder: dict) -> Pin | None:
        root = Path(key)
        if not devmode.allows_read(root) or not root.is_dir():
            return None
        dirs = tuple(directory.resolve() for directory in get_search_dirs(root))
        return Pin(key, root, dirs, folder.get("server") or "global") if dirs else None

    @_serialized
    def variant_cores(self, variant_key: str) -> set[str]:
        """The asset cores of a variant in every known install (lower case), for a scan of them."""
        if variant_key.startswith(("other:", "other-set:")):
            return {core_of(name) for record in self._records.values()
                    if record["kind"] == "other" and record["target"] == variant_key for name in record["files"]}
        cores = set()
        for pin in self.installs():
            for kind in KINDS:
                core = self._core_map(pin).core(variant_key, kind)
                if core:
                    cores.add(core.lower())
        return cores

    def installs(self) -> list[Pin]:
        """The known installs, the ones the switch covers: the folders the settings name, then every install with a
        configuration record whose folder exists, unless this data directory removed it from its list."""
        pins = self._named_pins()
        try:
            config = self.profiles.read()
        except ServiceError:
            return pins
        for key, folder in ((config or {}).get("folders") or {}).items():
            if any(pin.key == key for pin in pins) or self.data_id in (folder.get("hidden") or []):
                continue
            pin = self._recorded_pin(key, folder)
            if pin is not None:
                pins.append(pin)
        return pins

    def _all_pins(self) -> list[Pin]:
        """The known installs and the recorded ones this data directory removed from its list: whose kept originals
        must stay just the same."""
        pins = self.installs()
        with contextlib.suppress(ServiceError):
            for key, folder in ((self.profiles.read() or {}).get("folders") or {}).items():
                if all(pin.key != key for pin in pins):
                    pin = self._recorded_pin(key, folder)
                    if pin is not None:
                        pins.append(pin)
        return pins

    def current_pin(self) -> Pin | None:
        """The known install of the selected file source, None in ADB mode or when its folder is missing."""
        if self.settings is None or self.settings.is_adb_mode():
            return None
        folder = self.settings.game_dir()
        if folder is None:
            return None
        return self._pin(folder, self.settings.server_region())

    def _current(self, pin: Pin | None = None) -> Pin:
        pin = pin or self.current_pin()
        if pin is None:
            raise ServiceError("game_not_found")
        return pin

    def _check_pins(self, pins: list[Pin]) -> None:
        """folder_changed when the known installs now differ from the ones a job was submitted with."""
        if _pins_signature(pins) != _pins_signature(self.installs()):
            raise ServiceError("folder_changed")

    def _check_idle(self, pins: list[Pin]) -> None:
        idle = getattr(safety, "check_steam_idle", None)
        if idle is not None:
            for pin in pins:
                idle(pin.root)

    def _index(self, pin: Pin) -> dict[str, list[Path]]:
        """The install's bundle files by lower-case core (names only). Listed again when a folder changes, and
        rebuilt only when the files there are not the same ones (a write replacing a file keeps the index)."""
        try:
            signature_ = tuple((str(d), d.stat().st_mtime_ns) for d in pin.dirs)
        except OSError:
            signature_ = ()
        cached = self._indexes.get(pin.key)
        if cached and cached[0] == signature_ and signature_:
            return cached[1]
        listing: list[tuple[str, str]] = []
        for directory in pin.dirs:
            try:
                with os.scandir(directory) as entries:
                    listing.extend((entry.name, entry.path) for entry in entries
                                   if entry.name.endswith(".bundle") and entry.is_file(follow_symlinks=False))
            except OSError:
                continue
        files = frozenset(path for _name, path in listing)
        if cached and cached[2] == files:
            self._indexes[pin.key] = (signature_, cached[1], files, cached[3])
            return cached[1]
        index: dict[str, list[Path]] = {}
        for name, path in listing:
            core = self._cores.get(name)
            if core is None:
                core = self._cores[name] = core_of(name)
            index.setdefault(core, []).append(Path(path))
        index = {key: sorted(paths) for key, paths in index.items()}
        self._generation += 1
        self._indexes[pin.key] = (signature_, index, files, self._generation)
        return index

    def _kind(self, core: str, pin: Pin) -> str | None:
        """Use the bundle category for special slots, including files removed by an update."""
        if core.startswith("other:"):
            return "other"
        paths = self._index(pin).get(core.lower(), [])
        if paths:
            return next((kind for path in paths if (kind := kind_of_file(path.name))), None)
        for name in self._applied:
            path = Path(name)
            if path.parent in pin.dirs and core_of(path.name) == core.lower():
                return kind_of_file(path.name)
        for record in self._records.values():
            if core_of(record["files"][0]) == core.lower():
                return record["kind"]
        return kind_of(core)

    def _built_for(self, pin: Pin) -> int:
        """Which build of the install's index the caches built on it belong to."""
        self._index(pin)
        return self._indexes[pin.key][3]

    def _core_map(self, pin: Pin) -> CoreMap:
        """How the install's cores map to variant keys (Catalog.core_map on its file names)."""
        index = self._index(pin)
        built_for = self._built_for(pin)
        cached = self._maps.get(pin.key)
        if cached and cached[0] == built_for:
            return cached[1]
        slots = [parse_filename(path.name) for paths in index.values()
                 if (path := next((part for part in paths if kind_of_file(part.name)), None)) is not None]
        spr = [slot.core for slot in slots if kind_of(slot.core, slot.category) == "spr"]
        lobby = [slot.core for slot in slots if kind_of(slot.core, slot.category) == "lobby"]
        special = [slot.core for slot in slots if kind_of(slot.core, slot.category) == "lobby" and
                   slot.category in ("spinebackground", "spinecharacters")]
        build = getattr(self.catalog, "core_map", None)
        if build is not None:
            mapped = build(spr, lobby, special_cores=special) if special else build(spr, lobby)
        else:  # a catalog without core maps: the current catalog's own answers
            keys, spr_of, lobby_of = {}, {}, {}
            for core in [*spr, *lobby]:
                variant = self.catalog.variant_for_core(core.lower())
                if variant is not None:
                    keys[core.lower()] = variant.key
                    target = spr_of if core.lower().endswith("_spr") else lobby_of
                    target.setdefault(variant.key, core)
            mapped = CoreMap(keys, spr_of, lobby_of, {})
        models = [slot.core for slot in slots if kind_of(slot.core, slot.category) == "model"]
        model_map = getattr(self.catalog, "model_map", None)
        keys = model_map(models) if model_map else {
            core.lower(): variant.key for core in models
            if (variant := self.catalog.variant_for_core(core.lower())) is not None}
        model_of = {}
        for core in sorted(models):
            key = keys.get(core.lower(), core.lower())
            mapped.keys.setdefault(core.lower(), key)
            model_of.setdefault(key, core)
        mapped = replace(mapped, model=model_of)
        self._maps[pin.key] = (built_for, mapped)
        return mapped

    def _names(self, pin: Pin) -> dict[str, Path]:
        """The install's bundle files by name, rebuilt with its index."""
        index = self._index(pin)
        built_for = self._built_for(pin)
        cached = self._names_cache.get(pin.key)
        if cached and cached[0] == built_for:
            return cached[1]
        names = {path.name: path for paths in index.values() for path in paths}
        self._names_cache[pin.key] = (built_for, names)
        return names

    def _originals(self) -> dict[str, int]:
        """The kept originals by name with their sizes, listed again when the folder changed."""
        directory = self.root / "originals"
        try:
            signature_: Any = directory.stat().st_mtime_ns
        except OSError:
            signature_ = None
        if self._originals_cache and self._originals_cache[0] == signature_ and signature_ is not None:
            return self._originals_cache[1]
        sizes: dict[str, int] = {}
        if signature_ is not None:
            for path in directory.glob("*.bundle"):
                with contextlib.suppress(OSError):
                    sizes[path.name] = path.stat().st_size
        self._originals_cache = (signature_, sizes)
        return sizes

    def _record_maps(self) -> tuple[dict, dict]:
        """The records by name and by folder, rebuilt when the records changed."""
        key = (self._version, id(self._applied), len(self._applied))
        if self._maps_cache and self._maps_cache[0] == key:
            return self._maps_cache[1]
        maps = _record_maps(self._applied)
        self._maps_cache = (key, maps)
        return maps

    def _game_files(self, key: str, kind: Kind | None = None, pin: Pin | None = None) -> list[Path]:
        if kind == "other":
            pin = self._current(pin)
            record = next((record for record in self._records.values()
                           if record["kind"] == "other" and record["target"] == key), None)
            if record is None:
                return self._index(pin).get(key, []) if key.startswith("other:") else []
            index = self._index(pin)
            slots = {core_of(name) for name in record["files"]}
            if all(slot in index for slot in slots):
                targets = []
                for slot in sorted(slots):
                    date = max(date_of(path.name) for path in index[slot])
                    latest = [path for path in index[slot] if date_of(path.name) == date]
                    if len(latest) != 1:
                        raise ServiceError("game_file_conflict", file=latest[0])
                    targets.extend(latest)
                return sorted(targets)
            return self._other_targets({path.name: path for path in self._paths(record)}, pin)
        variant = self._variant(key)
        index = self._index(self._current(pin))
        return [path for current, value in (("spr", variant.spr), ("lobby", variant.lobby), ("model", getattr(variant, "model", None)))
                if value and (kind is None or current == kind) for path in index.get(value.lower(), [])]

    def _other_targets(self, files: dict[str, Path], pin: Pin) -> list[Path]:
        """Resolve official file slots by prefix, then container/name/type for older or repacked bundles."""
        available = [path for slot, paths in self._index(pin).items() if slot.startswith("other:") for path in paths]
        targets = set()
        for name, source in files.items():
            collection = name.lower().startswith("uis-01_common-14_charactercollect-")
            if collection:
                exact = [path for path in available if path.name == name]
                if exact:
                    targets.update(exact)
                    continue
            current = None if collection else integrity.replacements({name: source}, available)
            if current:
                targets.update(current)
                continue
            prefix = parse_filename(name).prefix
            candidates = [path for path in available if parse_filename(path.name).prefix == prefix]
            latest = {}
            for path in candidates:
                slot = core_of(path.name)
                if slot not in latest or date_of(path.name) > date_of(latest[slot].name):
                    latest[slot] = path
                elif date_of(path.name) == date_of(latest[slot].name) and path != latest[slot]:
                    raise ServiceError("game_file_conflict", file=name)
            candidates = list(latest.values())
            if not candidates:
                raise ServiceError("game_file_not_found", file=name)
            exact = [path for path in candidates if path.name == name]
            if exact:
                targets.update(exact)
                continue
            bundle = Bundle.load(source)
            if bundle is None:
                raise ServiceError("bundle_invalid", file=source)
            keys = bundle.get_asset_keys("cont_name_type")
            matched = []
            for path in candidates:
                baseline = self._official_for(path, pin)
                bundle = Bundle.load(baseline)
                if bundle and keys & bundle.get_asset_keys("cont_name_type"):
                    matched.append(path)
            if not matched:
                raise ServiceError("game_file_not_found", file=name)
            targets.update(matched)
        return sorted(targets)

    def _view(self, pins: list[Pin], allow: str, config: dict | None | type(...) = ...,
              snapshot: bool = False) -> _View:
        self._refresh_state()
        if config is ...:
            config = self.profiles.read()
        return _View(self, pins, config, allow, snapshot)

    # --- official copies ---

    def _is_official(self, path: Path) -> bool:
        return self._is_official_as(path, path.name)

    def _is_official_as(self, path: Path, name: str) -> bool:
        """Official by the CRC32 of the whole content against the CRC in ``name``, with no trailing bytes."""
        parsed = parse_filename(name)
        fingerprint = self._hashes.get(path)
        return fingerprint.trailing == 0 and bool(parsed.crc) and fingerprint.crc == int(parsed.crc)

    def _original_path(self, game_file: Path) -> Path:
        return self.root / "originals" / game_file.name

    def _elsewhere(self, game_file: Path) -> list[Path]:
        """Files of a game file's name in the other known installs and the folders of the library's records."""
        name, exclude = game_file.name, game_file.resolve()
        out: list[Path] = []
        for pin in self.installs():
            for path in self._index(pin).get(core_of(name), []):
                if path.name == name and path.resolve() != exclude:
                    out.append(path)
        for recorded in self._applied:
            path = Path(recorded)
            if path.name == name and path != exclude and path not in out and devmode.allows_read(path) \
                    and path.is_file():
                out.append(path)
        return out

    def _official_for(self, game_file: Path, pin: Pin, full: bool = True, *, game_first: bool = False) -> Path:
        """An official copy of a game file, in this order: the library's kept original (it was verified when it was
        kept; ``original_invalid`` when it fails, never overwritten), the game file itself, its .backup beside it (the
        classic GUI's; judged by the name without .backup), a file of its name in another game folder. At write
        strength each candidate is verified by the CRC32 of its whole content; else (previews) by the cheap rule.
        ``original_unavailable`` when there is none. Read-only checks may prefer the current official game file
        with ``game_first``; an invalid kept original must still block writes."""
        check_resource_path(game_file, list(pin.dirs))

        def official(path: Path) -> bool:
            try:
                if full:
                    return self._is_official_as(path, game_file.name)
                stat_size = path.stat().st_size
                expected = self._official_size(game_file.name)
                return trailing_bytes(path) == 0 and (expected is None or expected == stat_size)
            except OSError:
                return False

        if game_first and official(game_file):
            return game_file
        original = self._original_path(game_file)
        if original.exists():
            if full and not self._is_official(original):
                raise ServiceError("original_invalid", file=original)
            return original
        if official(game_file):
            return game_file
        backup = game_file.with_name(game_file.name + ".backup")
        if backup.is_file() and official(backup):
            return backup
        for other in self._elsewhere(game_file):
            if official(other):
                return other
        raise ServiceError("original_unavailable", file=game_file)

    def _keep_original(self, game_file: Path, pin: Pin, *, moving: bool = False) -> Path:
        """Keep verified official bytes, cloning where possible. A journaled write may move its own target;
        backups and files of another install must remain available in their current locations."""
        official = self._official_for(game_file, pin)
        original = self._original_path(game_file)
        if official != original:
            sha1 = self._hashes.get(official).sha1
            if not atomic_clone(official, original):
                if moving and official == game_file and not official.is_symlink():
                    verified_move(official, original, sha1)
                else:
                    atomic_copy(official, original)
            verify_file(original, sha1)
            if not self._is_official(original):
                if official.exists():
                    original.unlink()
                raise ServiceError("original_invalid", file=game_file)
        return official

    def _official_sha1(self, target: Path, pin: Pin) -> str | None:
        try:
            return self._hashes.get(self._official_for(target, pin)).sha1
        except (ServiceError, OSError):
            return None

    def _keep_replaced(self, targets: list[Path], pin: Pin) -> list[str]:
        """Store the game files about to be replaced that are kept nowhere else as library mods, one per core, and
        return the ids of the mods it created. Each target is judged in full: official files go to originals/
        (_keep_original), files carrying a library source stay where they are, and a file changed outside the
        library (another tool, a manual copy), or the bytes of a source the library no longer has, is kept. A part
        of a mod the user removed is never kept. At write strength a target's sha1 is compared with its record, never
        its size and date: _write has hashed every target already, so this reads nothing more."""
        view = self._view([pin], "full")
        keep: dict[str, list[Path]] = {}
        for target in targets:
            if self._replaced_unkept(target, pin, view):
                keep.setdefault(core_of(target.name), []).append(target)
        created = []
        for paths in keep.values():
            mod_id, new = self._add_group(paths, parse_filename(paths[0].name).core, pin)
            logger.info("Kept the replaced game file %s as mod %s", paths[0].name, mod_id)
            if new:
                created.append(mod_id)
        return created

    def _replaced_unkept(self, target: Path, pin: Pin, view: _View) -> bool:
        """Whether a game file about to be replaced holds bytes kept nowhere else, by the full judgement: a target
        whose sha1 equals its record carries the record's source, and is kept only when that source is gone from the
        library (never a removed mod's part) and the target is not official; any other target is kept when it is not
        official. A file whose header cannot be read is never kept."""
        fingerprint = self._hashes.get(target)
        record = self._applied.get(str(target.resolve()))
        if record and fingerprint.sha1 == record.get("sha1"):
            if record.get("removed"):
                return False
            if view.source_exists(record.get("source", ""), pin.key, kind_of_file(target.name) or "spr"):
                return False
        elif fingerprint.trailing is None:
            return False
        return not self._is_official(target)

    def _drop_mods(self, mod_ids: list[str]) -> None:
        """Forget mods _keep_replaced added for a replacement that was rolled back (their files are in the game
        again). A state that cannot be saved still lists them; loading drops records without files."""
        if not mod_ids:
            return
        deletion = getattr(self, '_asset_deletion', None)
        if deletion:
            deletion.remember_mods(mod_ids)
            for mod_id in mod_ids:
                self._records.pop(mod_id, None)
            self._save()
            for mod_id in mod_ids:
                shutil.rmtree(self.root / 'mods' / mod_id)
            return
        for mod_id in mod_ids:
            self._records.pop(mod_id, None)
        try:
            self._save()
        except OSError as error:
            log_failure(logger, logging.WARNING, "Could not save the library state after a rollback", error)
        for mod_id in mod_ids:
            shutil.rmtree(self.root / "mods" / mod_id, ignore_errors=True)

    # --- kept originals ---

    def _needs_original(self, path: Path, record: dict[str, Any]) -> bool:
        """Whether a game file the library wrote to may still need the kept original of its name, by stat alone: not
        once its folder exists and the file is gone, nor while it is unchanged since the library wrote official
        bytes there. A folder that cannot be seen (an unmounted drive) is judged by its record. When unsure, the
        original stays: the cost is disk space, never a lost official copy."""
        try:
            if not path.parent.is_dir():
                return not says_official(record)
            if not path.is_file():
                return False
            stat = path.stat()
            return not (says_official(record) and record.get("size") == stat.st_size
                        and record.get("mtime") == stat.st_mtime_ns)
        except OSError:
            return True

    def _needed_elsewhere(self, name: str, mine: set[str], pins: list[Pin]) -> bool:
        """Whether another file needs the kept original of a name: a file of that name the library wrote to outside
        ``mine`` (resolved paths), judged by _needs_original, or a file of that name in one of ``pins`` outside
        ``mine`` the library never wrote (it may be another tool's mod, with this original its only official copy).
        ``pins`` holds the installs this data directory removed from its list too (_all_pins)."""
        for other, record in self._applied.items():
            if other not in mine and Path(other).name == name and self._needs_original(Path(other), record):
                return True
        for pin in pins:
            for path in self._index(pin).get(core_of(name), []):
                resolved = str(path.resolve())
                if path.name == name and resolved not in mine and resolved not in self._applied:
                    return True
        return False

    def _kept_for_configuration(self, name: str, config: dict | None, pins: list[Pin]) -> bool:
        """Whether a configured entry keeps the original of a name: its game file of that name exists in that
        install, and the configured source may write non-official bytes there (no record there shows the configured
        source leaving that part official). When unsure, the original stays."""
        core = core_of(name)
        for pin in pins:
            entry = ((((config or {}).get("folders") or {}).get(pin.key) or {}).get("configured") or {}).get(core)
            if not entry:
                continue
            path = next((path for path in self._index(pin).get(core, []) if path.name == name), None)
            if path is None:
                continue
            record = self._applied.get(str(path.resolve()))
            if not (record and record.get("source") == entry["source"] and record.get("official") is True):
                return True
        return False

    def _release_failed(self, targets: list[Path], pin: Pin) -> None:
        """After a write that failed with its game files back as they were, release the originals that same call kept
        from the game files themselves: those files hold the bytes just verified."""
        if not targets:
            return
        try:
            config = self.profiles.read()
        except ServiceError:
            return
        pins = self._all_pins()
        for target in targets:
            original = self._original_path(target)
            if self._kept_for_configuration(target.name, config, pins) or self._needed_elsewhere(
                    target.name, {str(target.resolve())}, pins):
                continue
            with contextlib.suppress(OSError):
                if not original.resolve().is_relative_to(self.root):
                    continue
                original.unlink()
                logger.info("Released the original of %s kept by a failed write", target.name)

    def _prune(self) -> list[Path]:
        """Serialize deletion with writes that may still need an original for rollback."""
        if any((self.root / "transactions").glob("*/journal.json")):
            return []
        with self._transaction_lock():
            return self._prune_originals()

    def _prune_originals(self) -> list[Path]:
        """Delete the kept originals no longer needed, over every known install, from names, stats and records only
        (no game file's contents are read): an original whose name is present is released once every file of that
        name is unchanged since the library wrote official bytes there; an original whose name is gone from every
        known install is deleted when a game update superseded it (a later-dated file of the same part in the folder
        of each of its gone records). Then the records of superseded gone files are dropped (with the entry's
        ``updated`` marker when the library wrote non-official bytes there), and the built copies whose names are
        gone.

        What it keeps is decided over the installs this data directory removed from its list too (``guarded``): a
        library shared with a data directory that names such an install keeps the same originals here as there, so
        removing an install from the list never changes what the prune keeps."""
        directory = self.root / "originals"
        if not directory.resolve().is_relative_to(self.root):
            return []
        try:
            config = self.profiles.read()
        except ServiceError:
            return []
        pins = self.installs()
        guarded = self._all_pins()
        listed = {path.name for path in directory.glob("*.bundle")} if directory.is_dir() else set()
        view = _View(self, guarded, config, "recorded")
        view.originals = {name: size for name, size in view.originals.items()}  # as listed at the start
        present: dict[str, list[Path]] = {}
        for names in view.names.values():
            for name, path in names.items():
                present.setdefault(name, []).append(path)
        known_dirs = {folder: pin for pin in guarded for folder in pin.dirs}
        released: list[Path] = []
        for name in sorted(listed):
            original = directory / name
            files = present.get(name, [])
            if files:
                if self._kept_for_configuration(name, config, guarded):
                    continue
                if not all(self._unchanged_official(path) for path in files):
                    continue
                if self._needed_elsewhere(name, {str(path.resolve()) for path in files}, guarded):
                    continue
            else:
                gone = [Path(path) for path in self._applied if Path(path).name == name
                        and Path(path).parent in known_dirs and not Path(path).exists()]
                if not gone or not all(view.successor(known_dirs[path.parent], path) for path in gone):
                    continue
                if self._needed_elsewhere(name, {str(path) for path in gone}, guarded):
                    continue
            try:
                original.unlink()
            except OSError as error:
                log_failure(logger, logging.WARNING, "Could not delete the kept original", error)
                continue
            logger.info("Released the kept original %s", name)
            released.append(original)
        # superseded gone records: kept while an original of their name is, else dropped (with the marker)
        kept = {name for name in listed if (directory / name).exists()}
        stale: list[str] = []
        markers: dict[str, set[str]] = {}
        for pin in pins:
            for folder in pin.dirs:
                for path, record in view.by_folder.get(folder, []):
                    if path.exists() or not view.successor(pin, path) or path.name in kept:
                        continue
                    stale.append(str(path))
                    core = core_of(path.name)
                    if (view.says_nonofficial(path, record, present=False) and view.configured(pin.key, core)
                            and not view.later_record(path)):
                        markers.setdefault(pin.key, set()).add(core)
        built_drops: dict[str, set[str]] = {}
        for pin in pins:
            names = view.names[pin.key]
            for core, key in (view.folder(pin.key).get("built") or {}).items():
                wanted = [*(key.get("parts") or {}), *(key.get("inputs") or [])]
                if any(name not in names for name in wanted):
                    built_drops.setdefault(pin.key, set()).add(core)
        if stale:
            old_applied = dict(self._applied)
            for name in stale:
                self._applied.pop(name, None)
            try:
                self._save()
            except OSError as error:
                self._applied = old_applied
                log_failure(logger, logging.WARNING, "Could not save the library state after pruning", error)
                markers = {}
        if markers or built_drops:
            stamp = now()
            dropped: list[dict] = []

            def change(data: dict) -> bool:
                changed = False
                for key, cores in markers.items():
                    folder = data["folders"].get(key)
                    for core in cores:
                        if folder and core in folder["configured"]:
                            folder["updated"][core] = stamp
                            changed = True
                for key, cores in built_drops.items():
                    folder = data["folders"].get(key)
                    for core in cores:
                        if folder and core in folder["built"]:
                            dropped.append(folder["built"].pop(core))
                            changed = True
                return changed

            self._update_profiles(change, after=lambda data: self._delete_built_files(dropped, data))
        self._pruned_cores.update(core_of(Path(name).name) for name in stale)
        self._pruned_cores.update(core for cores in built_drops.values() for core in cores)
        return released

    @_serialized
    def take_pruned_cores(self) -> set[str]:
        """Cores changed by global pruning since the last writer's replacement scan was queued."""
        cores, self._pruned_cores = self._pruned_cores, set()
        return cores

    def _unchanged_official(self, path: Path) -> bool:
        record = self._applied.get(str(path.resolve()))
        if not says_official(record):
            return False
        try:
            stat = path.stat()
        except OSError:
            return False
        return record.get("size") == stat.st_size and record.get("mtime") == stat.st_mtime_ns

    def _prune_quietly(self) -> None:
        # Writers already hold the library lock, possibly followed by transaction
        # and Mod locks. Do not reacquire it after those higher-order locks.
        if getattr(self, '_asset_deletion', None):
            return
        if self._deferred_prunes:
            self._prune_pending = True
            return
        try:
            self._prune()
        except Exception as error:  # never in the way of the switch itself; the next prune tries again
            log_failure(logger, logging.WARNING, "Could not prune the kept originals", error)

    @contextlib.contextmanager
    def import_batch(self) -> Iterator[None]:
        """Keep per-Mod transactions independent, but run global housekeeping once."""
        with self._lock:
            self._deferred_prunes += 1
        try:
            yield
        finally:
            with self._lock:
                self._deferred_prunes -= 1
                if not self._deferred_prunes and self._prune_pending:
                    self._prune_pending = False
                    self._prune_quietly()

    @_serialized
    def prune(self) -> list[Path]:
        """Delete the kept originals no longer needed and return them: those whose game file the library wrote
        official bytes to again, and those of files a game update replaced. Originals another install may need are
        kept, and so are those of configured entries the next Off copies back."""
        return self._prune()

    # --- what the game shows ---

    def _file_state(self, view: _View, entry: _Entry, part: _Part) -> GameFileState:
        parsed = parse_filename(part.path.name)
        copy_ = entry.copies.get(str(part.path))
        applied = "unknown" if part.carried == "damaged" else part.carried
        return GameFileState(part.path, entry.core if entry.kind == "other" else parsed.core, entry.kind,
                             applied, part.crc, part.path.name in view.originals,
                             parsed.date, part.size, copy_, copy_ is not None, part.official)

    @_serialized
    def state(self, variant_key: str, pin: Pin | None = None) -> VariantState:
        """Inspect all game parts of a variant cheaply: size, date and header, never the whole file (decision 27).
        Needs Fix comes from the record of the switch that wrote the file, while it is unchanged since."""
        pin = self._current(pin)
        view = self._view(self._view_pins(pin), "family")
        files = []
        if variant_key.startswith(("other:", "other-set:")):
            values = {core_of(path.name) for path in self._game_files(variant_key, "other", pin)}
        else:
            variant = self._variant(variant_key)
            values = (variant.spr, variant.lobby, getattr(variant, "model", None))
        for value in values:
            if not value:
                continue
            core = value.lower()
            if not view.indexes[pin.key].get(core):
                continue
            entry = view.entry(pin, core)
            files.extend(self._file_state(view, entry, part) for part in entry.parts)
        sources = {file.applied for file in files}
        crc = "needs_fix" if any(f.crc == "needs_fix" for f in files) else (
            "fixed" if any(f.crc == "fixed" for f in files) else "ok")
        return VariantState(variant_key, files, sources.pop() if len(sources) == 1 else "unknown",
                            crc, any(f.original for f in files))

    def _view_pins(self, pin: Pin) -> list[Pin]:
        pins = [pin]
        pins.extend(other for other in self.installs() if other.key != pin.key)
        return pins

    @_serialized
    def configured(self, variant_key: str, pin: Pin | None = None) -> dict[str, str | None]:
        """The sources configured for a variant's asset kinds in the current install."""
        variant = self._variant(variant_key)
        pin = self._current(pin)
        folder = (((self.profiles.read() or {}).get("folders") or {}).get(pin.key) or {}).get("configured") or {}
        return self._configured_sources(variant, folder)

    @staticmethod
    def _configured_sources(variant: Any, folder: dict) -> dict[str, str | None]:
        return {kind: (folder.get(value.lower()) or {}).get("source") if value else None
                for kind, value in (("spr", variant.spr), ("lobby", variant.lobby), ("model", getattr(variant, "model", None)))
                if kind != "model" or hasattr(variant, "model")}

    @_serialized
    def roster_snapshot(self, variant_keys: list[str]) -> dict[str, Any]:
        """Read one install and configuration for the whole roster under the library lock.

        The roster needs manifest intent and cheap replacement checks, not physical
        installation verification. Detailed selection errors and byte verification
        remain in ``selection`` for the detail screen and write operations.
        """
        pin = self.current_pin()
        config = self.profiles.read() if pin is not None else None
        folder = ((config or {}).get("folders") or {}).get(pin.key) if pin else None
        choices = (folder or {}).get("configured") or {}
        assigned = {record["assignment"] for record in self._records.values() if record.get("assignment")}
        configured = {}
        for key in dict.fromkeys([*variant_keys, *sorted(assigned)]):
            try:
                configured[key] = self._configured_sources(self._variant(key), choices) if pin else {"spr": None, "lobby": None}
            except ServiceError:
                configured[key] = {"spr": None, "lobby": None}
        modified = {}
        if pin is not None:
            allow = "scan" if self._scan_allowed() else "recorded"
            modified = self._modified(pin, _View(self, [pin], config, allow))
        return {"install": pin.key if pin else None,
                "mods": [self._entry(record) for record in self._records.values()],
                "favorites": set(self._favorites), "configured": configured, "modified": modified,
                "assigned": sorted(assigned)}

    @_serialized
    def selection(self, variant_key: str, pin: Pin | None = None) -> dict[str, dict]:
        """Saved choices and verified installation status, using the master switch as intent.

        Every current part must match the recorded write of this source. Fingerprints are
        cached by size, mtime and ctime; an unchanged tail is not proof of installation.
        """
        pin = self._current(pin)
        variant = self._variant(variant_key)
        config = self.profiles.read()
        folder = (((config or {}).get("folders") or {}).get(pin.key) or {}).get("configured") or {}
        result = {}
        for kind, core in (("spr", variant.spr), ("lobby", variant.lobby), ("model", getattr(variant, "model", None))):
            choice = folder.get(core.lower()) if core else None
            if not choice:
                continue
            paths = self._index(pin).get(core.lower(), [])
            installed = bool(paths) and profiles_mod.enabled(config) and not choice.get("error")
            try:
                for path in paths:
                    record = self._applied.get(str(path.resolve())) or {}
                    if (record.get("source") != choice["source"] or record.get("removed")
                            or self._hashes.get(path).sha1 != record.get("sha1")):
                        installed = False
                        break
                recorded = {Path(name) for name, record in self._applied.items()
                            if Path(name).parent in pin.dirs and core_of(Path(name).name) == core.lower()
                            and record.get("source") == choice["source"] and not record.get("removed")}
                installed = installed and recorded == set(paths)
            except (OSError, ServiceError):
                installed = False
            result[kind] = {"source": choice["source"], "installed": installed,
                            "error": None if installed else choice.get("error")}
        return result

    def _selection_error(self, pin: Pin, cores, error: dict | None) -> None:
        def change(data):
            choices = (data["folders"].get(pin.key) or {}).get("configured", {})
            changed = False
            for core in cores:
                choice = choices.get(core)
                if choice is not None and choice.get("error") != error:
                    if error is None:
                        choice.pop("error", None)
                    else:
                        choice["error"] = error
                    changed = True
            return changed
        self._update_profiles(change)

    @_serialized
    def modified(self, pin: Pin | None = None) -> dict[str, str]:
        """Variants whose portrait or special slot files are not official, from cheap checks only (no hashing): the
        library's own records while the file is unchanged since it wrote it (a part a record says official adds nothing),
        and, with scan consent, the header of every other slot file (trailing bytes, or not the official size of its
        name). Returns {variant key: source}, the source being "mod:<id>", "variant:<key>" or "unknown"."""
        pin = self.current_pin() if pin is None else pin
        if pin is None:
            return {}
        allowed = self._scan_allowed()
        view = self._view([pin], "scan" if allowed else "recorded")
        return self._modified(pin, view)

    def _modified(self, pin: Pin, view: _View) -> dict[str, str]:
        out: dict[str, str] = {}
        for core, paths in view.indexes[pin.key].items():
            variant = self.catalog.variant_for_core(core)
            if variant is None or (not core.endswith("_spr") and not getattr(variant, "spine_category", None)):
                continue
            kind = next((kind for path in paths if (kind := kind_of_file(path.name))), None) or "spr"
            sources = set()
            for path in paths:
                try:
                    part = view.part(path, pin, kind)
                except (_Unread, OSError):
                    continue
                if not part.official and part.carried != "damaged":
                    sources.add(part.carried)
            if sources:
                out[variant.key] = sources.pop() if len(sources) == 1 else "unknown"
        return out

    @_serialized
    def official_bundles(self, core: str, pin: Pin | None = None) -> list[Path]:
        """Verified official parts of a core, including kept originals of overwritten game files.

        Resolve the whole set or fail: a live mod part must never fill a missing official part.
        """
        pin = self._current(pin)
        paths = self._spine_parts(core, pin)
        if not paths:
            raise ServiceError("game_file_not_found", variant=core)
        return [self._official_for(path, pin) for path in paths]

    def _spine_parts(self, core: str, pin: Pin) -> list[Path]:
        """The supported character bundle parts of a core, in game folder order.

        Model parts include the prefab and its own meshes, materials, textures and clips; shared dependencies
        remain supplied by the install's CAB graph.
        """
        core = core.lower()
        paths = self._index(pin).get(core, [])
        return [path for path in paths if kind_of_file(path.name)]

    @_serialized
    def live_bundles(self, core: str, pin: Pin | None = None) -> list[Path]:
        """The game files of a core with the parts that carry a mod last.

        Files merge by name, the last one winning (``GameAssets.spine_files_from``). A mod preview merges the mod's
        parts after the official ones; the game folder lists parts by file name, so a part left official could come
        after an applied mod part and win a texture it shares by name: the mod's atlas drawn over the official
        texture. Putting every part that is not official last gives the game files the preview's order. Judged by
        the cheap rule (headers, never whole files).
        """
        pin = self._current(pin)
        paths = self._spine_parts(core, pin)
        if not paths:
            raise ServiceError("game_file_not_found", variant=core)
        view = self._view([pin], "family")
        kind = self._kind(core, pin) or "spr"
        parts = [view.part(path, pin, kind) for path in paths]
        return [part.path for part in sorted(parts, key=lambda part: not part.official)]

    @_serialized
    def preview_bundles(self, mod_id: str, pin: Pin | None = None) -> list[Path]:
        """Return missing official parts followed by the mod's overriding parts.

        Parts match by prefix and resource type, independent of date and CRC. The official parts come from the mod's
        own core in the given install (the current one), verified by content. Pass this order to
        ``GameAssets.spine_files_from`` so mod assets win.
        """
        return self._preview(self._record(mod_id), self._current(pin), full=True)

    def _preview(self, record: dict[str, Any], pin: Pin, full: bool) -> list[Path]:
        paths = self._paths(record)
        replaced = {part_of(path.name) for path in paths}
        others = [self._official_for(path, pin, full) for path in self._spine_parts(core_of(paths[0].name), pin)
                  if part_of(path.name) not in replaced]
        return others + paths

    # --- switching ---

    def _plan(self, record: dict[str, Any], log: LogFunc, pin: Pin) -> list[mod_install.ModGroup]:
        if record["kind"] == "other":
            paths = self._paths(record)
            targets = self._other_targets({path.name: path for path in paths}, pin)
            return [mod_install.ModGroup(prefix="", category=None, core=record["target"], files=[
                mod_install.ModFilePlan(mod_path=path, parsed=parse_filename(path.name),
                                       action=mod_install.InstallAction.UPDATE) for path in paths], target_paths=targets)]
        groups = mod_install.plan_mod_install(self._paths(record), list(pin.dirs), log)
        if not groups or any(file.action not in (mod_install.InstallAction.DIRECT_REPLACE,
                                                 mod_install.InstallAction.UPDATE)
                             for group in groups for file in group.files):
            raise ServiceError("game_file_not_found", variant=record["target"])
        return groups

    @staticmethod
    def _plan_targets(groups: list[mod_install.ModGroup]) -> list[Path]:
        return sorted({path for group in groups for path in (
            group.target_paths + [file.existing_path for file in group.files if file.existing_path is not None])})

    def _stage_official(self, paths: list[Path], directory: Path, pin: Pin) -> dict[Path, Path]:
        staged = {}
        directory.mkdir(parents=True, exist_ok=True)
        for path in paths:
            target = directory / path.name
            if target in staged.values():
                raise ServiceError("game_file_conflict", file=path)
            atomic_copy(self._official_for(path, pin), target)
            staged[path] = target
        return staged

    def _commit(self, replacements: dict[Path, Path], source: str, log: LogFunc,
                progress: ProgressCallback | None = None, pin: Pin | None = None, prune: bool = True,
                build_keys: dict[Path, str] | None = None, create_backup: bool = False,
                expected: dict[Path, str] | None = None) -> list[Path]:
        """Write prepared files over game files as one unit, keeping what they replace: the official file in
        originals/ (once), a file kept nowhere else as a library mod (_keep_replaced). Every written part is rolled
        back on failure. With ``prune``, kept originals no longer needed are deleted afterwards, whatever the
        outcome; bulk operations prune once at their end."""
        pin = self._current(pin)
        deletion = getattr(self, '_asset_deletion', None)
        if deletion:
            deletion.remember_game(replacements, pin)
        try:
            with self._transaction_lock():
                return self._write(replacements, source, log, progress, pin, build_keys,
                                   create_backup=create_backup, **({"expected": expected} if expected else {}))
        finally:
            if prune:
                self._prune_quietly()

    @contextlib.contextmanager
    def _writable(self, paths: list[Path], pin: Pin, *, recovering: bool = False) -> Iterator[None]:
        """The checks right before game files are written: the game not running, Steam not updating or verifying the
        install, the files inside its resource folders and lockable, and the caller's own check (write_check)."""
        if self._write_check is not None:
            self._write_check(pin)
        self._check_idle([pin])
        with safety.writable_game_files(paths, list(pin.dirs), allow_missing=recovering):
            yield

    @contextlib.contextmanager
    def _transaction_lock(self) -> Iterator[None]:
        """Lock before mods, state and profiles; nested writes already hold this process lock."""
        if self._transacting:
            yield
            return
        with file_lock(self.root / "transactions.lock", timeout=10):
            self._transacting = True
            try:
                self._refresh_state()
                self._recover_transactions()
                yield
            finally:
                self._transacting = False

    def _recover_pending(self) -> None:
        """Recover before indexing game files, including one moved away just before a crash."""
        if not self._transacting and (any((self.root / "transactions").glob("*/journal.json"))
                                    or any((self.root / "import-transactions").glob("*/journal.json"))
                                    or any((self.root / "asset-deletions").glob("*/journal.json"))):
            with self._transaction_lock():
                pass

    def _recover_transactions(self) -> None:
        self._recover_imports()
        for path in sorted((self.root / "transactions").glob("*/journal.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if data["version"] != 1 or data["phase"] not in ("preparing", "writing", "committed") \
                        or not path.resolve().is_relative_to(self.root / "transactions"):
                    raise ValueError("Invalid write journal")
                if data["phase"] == "committed":
                    shutil.rmtree(path.parent)
                    continue
                info = data["pin"]
                pin = self._pin(Path(info["root"]), info["server"])
                if pin is None or pin.key != info["key"] or list(map(str, pin.dirs)) != info["dirs"]:
                    raise ServiceError("folder_changed")
                targets = []
                for i, item in enumerate(data["files"]):
                    target, backup = Path(item["target"]), self.root / item["rollback"]
                    check_resource_path(target, list(pin.dirs))
                    expected = self._original_path(target) if item["official"] else path.parent / f"{i}.bundle"
                    if backup != expected or not backup.resolve().is_relative_to(self.root):
                        raise ValueError("Invalid rollback path")
                    if item["restore"] and self.root / item["restore"] != self._original_path(target):
                        raise ValueError("Invalid original path")
                    targets.append(target)
                with self._writable(targets, pin, recovering=True):
                    self._rollback_write(data)
                self._release_failed([Path(item["target"]) for item in data["files"] if item["kept_now"]], pin)
                self._drop_mods(data["kept"])
                shutil.rmtree(path.parent)
                logger.info("Recovered interrupted library write %s", path.parent.name)
            except (ValueError, TypeError, KeyError) as error:
                raise ServiceError("library_io_error", file=path) from error
        from .asset_delete import recover
        recover(self)

    def _rollback_write(self, data: dict) -> None:
        """Return consumed originals before restoring mods. Repeating any completed step is safe."""
        for item in reversed(data["files"]):
            target = Path(item["target"])
            current = self._hashes.get(target).sha1 if target.exists() else None
            original = self.root / item["restore"] if item["restore"] else None
            if original is not None and not original.exists():
                if current != item["after"]:
                    raise ServiceError("original_unavailable", file=target)
                verified_move(target, original, item["after"])
                current = None
            if current == item["before"]:
                continue
            if current not in (None, item["after"]):
                raise ServiceError("entry_changed", core=core_of(target.name))
            backup = self.root / item["rollback"]
            verify_file(backup, item["before"])
            if item["official"] and item["kept_now"] and not self._needed_elsewhere(
                    target.name, {str(target.resolve())}, self._all_pins()):
                verified_move(backup, target, item["before"])
            elif not atomic_clone(backup, target):
                atomic_copy(backup, target)
            verify_file(target, item["before"])
        # A failed state flush may already have published the new file. Merge it before undoing its records.
        self._refresh_state()
        for item in data["files"]:
            key = item["target"]
            old = data["old_applied"].get(key)
            if old is None:
                self._applied.pop(key, None)
            else:
                # A rollback copy has a new date, even though its bytes are unchanged.
                self._applied[key] = {**old, "mtime": Path(key).stat().st_mtime_ns}
        if self._applied != self._base[2]:
            self._save()

    def _write(self, replacements: dict[Path, Path], source: str, log: LogFunc,
               progress: ProgressCallback | None, pin: Pin, build_keys: dict[Path, str] | None = None,
               *, create_backup: bool = False, expected: dict[Path, str] | None = None) -> list[Path]:
        dirs = list(pin.dirs)
        for target, prepared in replacements.items():
            check_resource_path(target, dirs)
            if self._hashes.get(prepared).trailing is None:
                raise ServiceError("bundle_invalid", file=prepared)
        changed = {target: prepared for target, prepared in replacements.items()
                   if self._hashes.get(target).sha1 != self._hashes.get(prepared).sha1}
        fingerprints = {target: self._hashes.get(prepared) for target, prepared in replacements.items()}
        tails = {target: read_tail(prepared) if fingerprints[target].trailing else None
                 for target, prepared in replacements.items()}
        old_applied = dict(self._applied)
        stamp = now()

        def records() -> dict[str, dict[str, Any]]:
            out = {}
            for target in replacements:
                fingerprint = fingerprints[target]
                stat = target.stat()
                record = {"source": source, "sha1": fingerprint.sha1, "size": stat.st_size,
                          "mtime": stat.st_mtime_ns,
                          "official": self._official_sha1(target, pin) == fingerprint.sha1,
                          "at": stamp, "tail": tails[target],
                          "crc": crc_state(fingerprint.crc, fingerprint.trailing, target.name)}
                if build_keys and target in build_keys:
                    record["build"] = build_keys[target]
                previous = self._applied.get(str(target.resolve()))
                if previous and {k: v for k, v in previous.items() if k != "at"} == {
                        k: v for k, v in record.items() if k != "at"}:
                    record = previous  # nothing new: the write time stays the one of the bytes there
                out[str(target.resolve())] = record
            return out

        if not changed:
            new = records()
            if any(self._applied.get(path) != record for path, record in new.items()):
                self._applied.update(new)
                try:
                    self._save()
                except OSError:
                    self._applied = old_applied
                    raise
            return []
        written: list[Path] = []
        kept_now: list[Path] = []  # originals this call kept from the game file itself
        kept: list[str] = []
        restored = True
        journal: Path | None = None
        transaction: dict | None = None
        saving_state = False
        try:
            with self._writable(list(changed), pin):
                if expected and any(self._hashes.get(path).sha1 != digest for path, digest in expected.items()):
                    raise ServiceError("entry_changed", core=core_of(next(iter(changed)).name))
                officials = {target: self._official_for(target, pin) for target in changed}
                kept = self._keep_replaced(list(changed), pin)
                directory = self.root / "transactions" / uuid.uuid4().hex
                directory.mkdir(parents=True)
                sync_directory(self.root)
                sync_directory(directory.parent)
                journal = directory / "journal.json"
                items = []
                pins = self._all_pins()
                for i, target in enumerate(changed):
                    original = self._original_path(target)
                    official = self._hashes.get(officials[target]).sha1 == self._hashes.get(target).sha1
                    new_original = officials[target] == target and not original.exists()
                    if new_original:
                        kept_now.append(target)
                    restore = source == "official" and changed[target] == original and not self._needed_elsewhere(
                        target.name, {str(target.resolve())}, pins)
                    backup = original if official else directory / f"{i}.bundle"
                    items.append({"target": str(target.resolve()), "before": self._hashes.get(target).sha1,
                                  "after": fingerprints[target].sha1, "official": official,
                                  "rollback": str(backup.relative_to(self.root)),
                                  "kept_now": new_original,
                                  "restore": str(original.relative_to(self.root)) if restore else None})
                transaction = {"version": 1, "phase": "preparing",
                               "pin": {"key": pin.key, "root": str(pin.root), "dirs": list(map(str, pin.dirs)),
                                       "server": pin.server}, "files": items, "kept": kept,
                               "old_applied": {item["target"]: old_applied.get(item["target"]) for item in items}}
                atomic_json(journal, transaction)
                try:
                    for item, target in zip(items, changed):
                        if create_backup and officials[target] == target.with_name(target.name + ".backup"):
                            # Keep the only official baseline before the adjacent backup is replaced.
                            self._keep_original(target, pin)
                        mod_install.backup_file(target, create_backup, log)
                        self._keep_original(target, pin, moving=True)
                        if not item["official"]:
                            backup = self.root / item["rollback"]
                            if not atomic_clone(target, backup):
                                atomic_copy(target, backup)
                            verify_file(backup, item["before"])
                    transaction["phase"] = "writing"
                    atomic_json(journal, transaction)
                    for i, (target, prepared) in enumerate(changed.items(), 1):
                        check_resource_path(target, dirs)
                        if source == "official" and prepared == self._original_path(target):
                            if not atomic_clone(prepared, target):
                                if items[i - 1]["restore"]:
                                    verified_move(prepared, target, fingerprints[target].sha1)
                                else:
                                    atomic_copy(prepared, target)  # another install still needs this original
                        else:
                            atomic_copy(prepared, target)
                        verify_file(target, fingerprints[target].sha1)
                        written.append(target)
                        log(f"Installed {target.name}")
                        if progress:
                            progress(i, len(changed), t("webui.progress.restore" if source == "official"
                                                        else "webui.progress.apply", name=target.name))
                    saving_state = True
                    self._applied.update(records())
                    self._save()
                except Exception as error:
                    self._applied = old_applied
                    try:
                        self._rollback_write(transaction)
                    except Exception as rollback_error:
                        restored = False
                        log_failure(logger, logging.ERROR, "Could not roll back library write", rollback_error)
                    if isinstance(error, OSError):
                        code = "library_io_error" if saving_state else "game_file_locked"
                        raise ServiceError(code, file=error.filename) from error
                    raise
                # An uncertain commit marker stays for recovery to decide, before any originals are released.
                restored = False
                transaction["phase"] = "committed"
                atomic_json(journal, transaction)
        except Exception:
            if restored:
                # what they kept is in the game again; a part left half written keeps them
                self._drop_mods(kept)
                self._release_failed(kept_now, pin)
                if journal is not None:
                    shutil.rmtree(journal.parent)
            raise
        if journal is not None:
            shutil.rmtree(journal.parent)
        return written

    def _stage_adapted(self, sources: list[Path], targets: list[Path], directory: Path,
                       log: LogFunc, pin: Pin) -> dict[Path, Path]:
        staged = self._stage_official(targets, directory / "targets", pin)
        output = directory / "output"
        output.mkdir(parents=True)
        adapted = adapt_variant_sources(
            sources, list(staged.values()), directory / "sources", self.settings.asset_types(), log)
        result = core.process_mod_update(
            adapted, list(staged.values()), output,
            self.settings.asset_types(), self.settings.save_options(self.settings.crc_needed(targets[0])),
            self.settings.spine_options(), skip_unchanged=True, match_strategy="name_type",
            anim_check=self.settings.anim_check_options(), log=log)
        if not result.success:
            raise ServiceError("mod_apply_failed", file=targets[0])
        reverse = {value: key for key, value in staged.items()}
        replacements = dict(staged)
        for pair in result.file_pairs:
            replacements[reverse[pair.source]] = pair.output
        return replacements

    def _install_direct(self, record: dict[str, Any], targets: list[Path], work: Path, log: LogFunc,
                        progress: ProgressCallback | None, pin: Pin) -> dict[Path, Path]:
        sources = {path.name: path for path in self._paths(record)}
        by_name = {path.name: path for path in targets}
        if (len(sources) == len(record["files"]) and len(by_name) == len(targets)
                and sources.keys() <= by_name.keys()
                and all(not self._needs_crc_fix(path, by_name[name]) for name, path in sources.items())):
            # These parts already have the current names and required CRC. The
            # transaction checks and copies their exact bytes once; staging an
            # official copy and replacing it with the same Mod adds no protection.
            if progress:
                progress(0, 1, t("webui.progress.process", name=core_of(record["files"][0])))
            return {target: sources[target.name] if target.name in sources else self._official_for(target, pin)
                    for target in targets}
        if record["kind"] == "other":
            staged = self._stage_official(targets, work / "targets", pin)
            output = work / "output"
            output.mkdir(parents=True, exist_ok=True)
            sources = self._paths(record)
            for target, original in staged.items():
                exact = next((path for path in sources if path.name == target.name), None)
                if exact:
                    if not self._needs_crc_fix(exact, target):
                        atomic_copy(exact, original)
                        continue
                    # Same-name mods retain the whole uploaded bundle, including types outside the update filter.
                    parsed = parse_filename(exact.name)
                    group = mod_install.ModGroup(parsed.prefix, parsed.category, parsed.core, [
                        mod_install.ModFilePlan(exact, parsed, mod_install.InstallAction.DIRECT_REPLACE,
                                                existing_path=original, need_crc_fix=True)])
                    result = mod_install.execute_mod_install(
                        [group], output, self.settings.asset_types(),
                        self.settings.save_options(self.settings.crc_needed(target)),
                        self.settings.spine_options(), create_backup=False, log=log)
                    if result.failed_groups:
                        raise ServiceError("mod_apply_failed", id=record["id"])
                    continue
                matching = [path for path in sources if parse_filename(path.name).prefix == parse_filename(target.name).prefix]
                if not matching:
                    raise ServiceError("mod_target_mismatch", id=record["id"], variant=core_of(target.name))
                result = core.process_mod_update(matching, [original], output, self.settings.asset_types(),
                    self.settings.save_options(self.settings.crc_needed(target)), self.settings.spine_options(),
                    match_strategy="cont_name_type", skip_unchanged=True,
                    anim_check=self.settings.anim_check_options(), log=log)
                if not result.success:
                    raise ServiceError("mod_apply_failed", id=record["id"])
                for pair in result.file_pairs:
                    atomic_copy(pair.output, original)
            return staged
        started = time.perf_counter()
        groups = self._plan(record, log, pin)
        allowed = set(targets)
        planned = self._plan_targets(groups)
        if any(path not in allowed for path in planned):
            raise ServiceError("game_file_outside_resources", file=next(p for p in planned if p not in allowed))
        staged = self._stage_official(targets, work / "targets", pin)
        logger.info("Mod apply plan and stage: %.3f s", time.perf_counter() - started)
        started = time.perf_counter()
        # Execute only against temporary copies. The classic installer may
        # copy directly or rebuild; all real game writes go through _commit.
        staged_groups = [replace(group, files=[replace(file,
            existing_path=staged.get(file.existing_path),
            need_crc_fix=self._needs_crc_fix(file.mod_path, file.existing_path)
            if file.existing_path else False) for file in group.files],
            target_paths=[staged[path] for path in group.target_paths]) for group in groups]
        result = mod_install.execute_mod_install(
            staged_groups, work / "output", self.settings.asset_types(),
            self.settings.save_options(self.settings.crc_needed(targets[0])),
            self.settings.spine_options(), anim_check=self.settings.anim_check_options(),
            create_backup=False, log=log, progress_callback=(
                lambda current, total, name: progress(current, total, t("webui.progress.process", name=name))
            ) if progress else None)
        logger.info("Mod apply build and CRC: %.3f s", time.perf_counter() - started)
        if result.failed_groups:
            raise ServiceError("mod_apply_failed", id=record["id"])
        return staged

    def _needs_crc_fix(self, source: Path, target: Path) -> bool:
        if not self.settings.crc_needed(target):
            return False
        expected = parse_filename(target.name).crc
        fingerprint = self._hashes.get(source)
        # Already fixed mods can be copied without loading and recompressing their textures with UnityPy.
        return fingerprint.trailing is None or not expected or fingerprint.crc != int(expected)

    @_serialized
    def apply(self, variant_key: str, source: str, log: LogFunc = no_log, progress: ProgressCallback | None = None,
              kind: Kind | None = "spr", pin: Pin | None = None, *, create_backup: bool = False) -> ApplyResult:
        """Install and configure one kind from a mod, variant, or originals.

        None selects all kinds for originals, and both Spine kinds for variant adaptation.

        A mod replaces all parts of its own kind as a unit. Another variant's mod must belong to the same family and
        is adapted to official targets. While mods are off nothing is written: the source is configured and applied
        when mods are on (``deferred``). Save the validated choice before attempting installation.
        """
        if source == "official":
            pin = self._current(pin)
            if not profiles_mod.enabled(self.profiles.read()):
                targets = self._game_files(variant_key, kind, pin)
                kinds = {(core_of(path.name) if kind == "other" else kind_of_file(path.name)): core_of(path.name)
                         for path in targets}
                return self._defer(pin, variant_key, kinds, None)
            return self.restore(variant_key, log, kind, pin=pin)
        if kind == "other":
            return self._apply_other(variant_key, source, log, progress, self._current(pin), create_backup)
        variant = self._variant(variant_key)
        pin = self._current(pin)
        on = profiles_mod.enabled(self.profiles.read())
        started = time.perf_counter()
        kinds = {}
        try:
            with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX) as temporary:
                work = Path(temporary)
                build_keys: dict[Path, str] = {}
                if source.startswith("mod:"):
                    record = self._record(source[4:])
                    target_variant = self._target_of(record)
                    if (kind is not None and record["kind"] != kind) or (
                            self._variant(target_variant).family != variant.family):
                        raise ServiceError("mod_target_mismatch", id=record["id"], variant=variant_key)
                    targets = self._game_files(variant_key, record["kind"], pin)
                    if not targets:
                        raise ServiceError("game_file_not_found", variant=variant_key)
                    cores = [core_of(targets[0].name)]
                    if record["kind"] in ("lobby", "model") and core_of(record["files"][0]) != cores[0]:
                        raise ServiceError("mod_target_mismatch", id=record["id"], variant=variant_key)
                    if not on:
                        return self._defer(pin, variant_key, {record["kind"]: cores[0]}, source)
                    kinds = {record["kind"]: cores[0]}
                    self._configure(pin, variant_key, kinds, source)
                    if core_of(record["files"][0]) == cores[0]:
                        view = self._view([pin], "full")
                        entry = view.entry(pin, cores[0])
                        identity = self._identity({path.name: path for path in self._paths(record)})
                        if entry.carried == source and self._matches_installed(identity, entry):
                            self._note_judged(view, entry)
                            self._configure(pin, variant_key, {record["kind"]: cores[0]}, source)
                            self._selection_error(pin, kinds.values(), None)
                            return ApplyResult(variant_key, source, [], unchanged=True)
                        replacements = self._cached_build(self._paths(record), targets, pin,
                            lambda: self._install_direct(record, targets, work, log, progress, pin), build_keys)
                    elif target_variant != variant_key:
                        sources = self._preview(record, pin, full=True)
                        replacements = self._cached_build(sources, targets, pin,
                            lambda: self._stage_adapted(sources, targets, work / record["kind"], log, pin), build_keys)
                    else:  # a lobby mod of another core of this variant: not offered, never written there
                        raise ServiceError("game_file_outside_resources", file=targets[0])
                    kinds = {record["kind"]: cores[0]}
                elif source.startswith("variant:"):
                    other = source[8:]
                    self._variant(other)
                    if kind == "model":
                        # Mesh names alone cannot adapt a prefab's rig, materials and object references.
                        raise ServiceError("source_unsupported", source=source)
                    replacements: dict[Path, Path] = {}
                    kinds = {}
                    for current in (("spr", "lobby") if kind is None else (kind,)):
                        targets = self._game_files(variant_key, current, pin)
                        sources = self._game_files(other, current, pin)
                        if not targets or not sources:
                            continue
                        kinds[current] = core_of(targets[0].name)
                    if not kinds:
                        raise ServiceError("game_file_not_found", variant=variant_key)
                    self._configure(pin, variant_key, kinds, source)
                    if on:
                        for current in kinds:
                            targets = self._game_files(variant_key, current, pin)
                            sources = self._game_files(other, current, pin)
                            official = [self._official_for(path, pin) for path in sources]
                            replacements.update(self._cached_build(official, targets, pin,
                                lambda: self._stage_adapted(official, targets, work / current, log, pin), build_keys))
                    if not kinds:
                        raise ServiceError("game_file_not_found", variant=variant_key)
                    if not on:
                        return self._defer(pin, variant_key, kinds, source)
                else:
                    raise ServiceError("source_unsupported", source=source)
                prepared = time.perf_counter()
                files = self._commit(replacements, source, log, progress, pin, prune=False, build_keys=build_keys,
                                     create_backup=create_backup)
                self._configure(pin, variant_key, kinds, source)
                self._selection_error(pin, kinds.values(), None)
                for core in kinds.values():
                    self._clear_marker(pin, core)
                logger.info("Mod apply copy and record: %.3f s", time.perf_counter() - prepared)
                return ApplyResult(variant_key, source, files, unchanged=not files)
        except Exception as error:
            if kinds:
                self._selection_error(pin, kinds.values(), error.to_json() if isinstance(error, ServiceError)
                                      else {"code": "library_io_error" if isinstance(error, OSError) else "library_operation_failed",
                                            "params": {"operation": "apply"}})
            raise
        finally:
            pruning = time.perf_counter()
            self._prune_quietly()
            logger.info("Mod apply prune: %.3f s; total: %.3f s", time.perf_counter() - pruning,
                        time.perf_counter() - started)

    def _defer(self, pin: Pin, variant_key: str, kinds: dict[str, str], source: str | None) -> ApplyResult:
        """While mods are off: configure the source without writing, applied when mods are on."""
        self._configure(pin, variant_key, kinds, source)
        if source is None:
            self._prune_quietly()
        return ApplyResult(variant_key, source or "official", [], unchanged=True, deferred=True)

    def _apply_other(self, target: str, source: str, log: LogFunc, progress: ProgressCallback | None,
                     pin: Pin, create_backup: bool) -> ApplyResult:
        if not source.startswith("mod:"):
            raise ServiceError("source_unsupported", source=source)
        record = self._record(source[4:])
        if record["kind"] != "other" or record["target"] != target:
            raise ServiceError("mod_target_mismatch", id=record["id"], variant=target)
        targets = self._game_files(target, "other", pin)
        kinds = {core_of(path.name): core_of(path.name) for path in targets}
        if not profiles_mod.enabled(self.profiles.read()):
            return self._defer(pin, target, kinds, source)
        self._configure(pin, target, kinds, source)
        try:
            with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX) as temporary:
                build_keys = {}
                replacements = self._cached_build(self._paths(record), targets, pin,
                    lambda: self._install_direct(record, targets, Path(temporary), log, progress, pin), build_keys)
                files = self._commit(replacements, source, log, progress, pin, prune=False,
                                     build_keys=build_keys, create_backup=create_backup)
            self._configure(pin, target, kinds, source)
            self._selection_error(pin, kinds, None)
            for slot in kinds:
                self._clear_marker(pin, slot)
            return ApplyResult(target, source, files, unchanged=not files)
        except Exception as error:
            self._selection_error(pin, kinds, error.to_json() if isinstance(error, ServiceError)
                                  else {"code": "library_io_error" if isinstance(error, OSError) else "library_operation_failed",
                                        "params": {"operation": "apply"}})
            raise
        finally:
            self._prune_quietly()

    @_serialized
    def restore(self, variant_key: str, log: LogFunc = no_log, kind: Kind | None = "spr",
                pin: Pin | None = None, progress: ProgressCallback | None = None) -> ApplyResult:
        """Restore one kind to official bytes and drop its configuration; None restores all kinds. Files that
        are official already are not written (only recorded)."""
        pin = self._current(pin)
        self.profiles.read()
        targets = self._game_files(variant_key, kind, pin)
        if not targets:
            raise ServiceError("game_file_not_found", variant=variant_key)
        try:
            replacements = {path: self._official_for(path, pin) for path in targets}
            files = self._commit(replacements, "official", log, progress=progress, pin=pin, prune=False)
            kinds = {(core_of(path.name) if kind == "other" else kind_of_file(path.name)): core_of(path.name)
                     for path in targets}
            self._configure(pin, variant_key, kinds, None)
        finally:
            self._prune_quietly()
        return ApplyResult(variant_key, "official", files, unchanged=not files)

    @_serialized
    def would_write(self, variant_key: str, source: str, kind: Kind | None = "spr", pin: Pin | None = None,
                    *, setting: bool = False) -> bool:
        """Whether a setting (setting=True) or explicit restore would write a game file, judged cheaply: not a deferred
        apply while mods are off, nor a restore of files that are official already. Such calls only change the
        configuration (allowed while the classic UI is open)."""
        pin = self._current(pin)
        on = profiles_mod.enabled(self.profiles.read())
        if setting and not on:
            return False
        if source != "official":
            return on
        view = self._view([pin], "family")
        for path in self._game_files(variant_key, kind, pin):
            part = view.part(path, pin, kind_of_file(path.name) or "spr")
            if not part.official:
                return True
        return False

    def _switch(self, pin: Pin, core: str, source: str, log: LogFunc = no_log,
                progress: ProgressCallback | None = None, use_built: bool = True) -> list[Path]:
        """The internal write of an entry: its core's parts in its own install switched to a source, and nothing
        else (the configuration stays). From a built copy when one still fits; a mod made for the core is installed
        directly, another variant's mod adapted, another variant's files (in that same install) adapted."""
        targets = self._index(pin).get(core, [])
        if not targets:
            raise ServiceError("game_file_not_found", variant=core)
        kind = self._kind(core, pin) or "spr"
        with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX) as temporary:
            work = Path(temporary)
            build_keys: dict[Path, str] = {}
            replacements = None
            if source == "official":
                replacements = {path: self._official_for(path, pin) for path in targets}
            elif use_built:
                replacements = self._built_replacements(pin, core, source, targets, build_keys)
            if replacements is None:
                if source.startswith("mod:"):
                    record = self._record(source[4:])
                    if record["kind"] == "other" or core_of(record["files"][0]) == core:
                        replacements = self._cached_build(self._paths(record), targets, pin,
                            lambda: self._install_direct(record, targets, work, log, progress, pin), build_keys)
                    else:
                        sources = self._preview(record, pin, full=True)
                        replacements = self._cached_build(sources, targets, pin,
                            lambda: self._stage_adapted(sources, targets, work / kind, log, pin), build_keys)
                elif source.startswith("variant:"):
                    other = self._core_map(pin).core(source[8:], kind)
                    sources = self._index(pin).get(other.lower(), []) if other else []
                    if not sources:
                        raise ServiceError("game_file_not_found", variant=source[8:])
                    official = [self._official_for(path, pin) for path in sources]
                    replacements = self._cached_build(official, targets, pin,
                        lambda: self._stage_adapted(official, targets, work / kind, log, pin), build_keys)
                else:
                    raise ServiceError("source_unsupported", source=source)
            files = self._commit(replacements, source, log, progress, pin, prune=False, build_keys=build_keys)
        self._clear_marker(pin, core)
        return files

    # --- built copies ---

    def _cached_build(self, sources: list[Path], targets: list[Path], pin: Pin,
                      build: Callable[[], dict[Path, Path]], build_keys: dict[Path, str]) -> dict[Path, Path]:
        """Reuse only a referenced instant-On copy with the same program, inputs, official targets and options.
        Prepared files otherwise live solely in the caller's temporary staging directory."""
        if len({path.name for path in targets}) != len(targets):
            return build()  # built keys identify parts by file name
        inputs = [(path.name, self._hashes.get(path).sha1) for path in sources]
        originals = [(path.name, self._hashes.get(self._official_for(path, pin)).sha1) for path in targets]
        options = (sorted(self.settings.asset_types()), self.settings.save_options(self.settings.crc_needed(targets[0])),
                   self.settings.spine_options(), self.settings.anim_check_options())
        signature = hashlib.sha1(repr((1, _build_version(), inputs, originals, options)).encode()).hexdigest()
        build_keys.update((target, signature) for target in targets)
        for folder in ((self.profiles.read() or {}).get("folders") or {}).values():
            for core, key in (folder.get("built") or {}).items():
                configured = (folder.get("configured") or {}).get(core) or {}
                if key.get("build") != signature or key.get("source") != configured.get("source"):
                    continue
                parts = key.get("parts") or {}
                if not parts or not set(parts) <= {target.name for target in targets}:
                    continue
                try:
                    replacements = {}
                    for target in targets:
                        part = parts.get(target.name)
                        if part is None:
                            replacements[target] = self._official_for(target, pin)
                            continue
                        kept = self.root / "built" / f"{part['sha1']}.bundle"
                        if part.get("mod_file") and key["source"].startswith("mod:"):
                            kept = self.root / "mods" / key["source"][4:] / part["mod_file"]
                        if self._hashes.get(kept).sha1 != part["sha1"]:
                            raise ValueError("Changed built copy")
                        replacements[target] = kept
                    logger.debug("Reused configured build %s", signature)
                    return replacements
                except (OSError, ValueError, KeyError, TypeError):
                    continue
        start = time.perf_counter()
        replacements = build()
        logger.debug("Built %s in %.3f s", signature, time.perf_counter() - start)
        return replacements

    def _built_replacements(self, pin: Pin, core: str, source: str, targets: list[Path],
                            build_keys: dict[Path, str] | None = None) -> dict[Path, Path] | None:
        """The entry's built copy written back, when it still fits: built for this very source, every part's name and
        every input's name still in the install. The other parts take their official copies. A kept file whose bytes
        are not the recorded ones drops the key (the entry is rebuilt)."""
        folder = ((self.profiles.read() or {}).get("folders") or {}).get(pin.key) or {}
        key = (folder.get("built") or {}).get(core)
        if not key:
            return None
        names = {path.name for paths in self._index(pin).values() for path in paths}
        parts = key.get("parts") or {}
        fits = key.get("source") == source and parts and all(name in names for name in parts) and all(
            name in names for name in key.get("inputs") or [])
        replacements: dict[Path, Path] = {}
        if fits:
            for target in targets:
                part = parts.get(target.name)
                if part is None:
                    replacements[target] = self._official_for(target, pin)
                    continue
                kept = (self.root / "mods" / source[4:] / part["mod_file"]) if part.get("mod_file") and \
                    source.startswith("mod:") else self.root / "built" / f"{part.get('sha1')}.bundle"
                try:
                    if self._hashes.get(kept).sha1 != part.get("sha1"):
                        raise ValueError(kept)
                except (OSError, ValueError):
                    logger.info("The built copy of %s no longer fits, rebuilding", target.name)
                    fits = False
                    break
                replacements[target] = kept
        if fits:
            if build_keys is not None and key.get("build"):
                build_keys.update((target, key["build"]) for target in targets)
            return replacements
        self._drop_built(pin, [core])
        return None

    def _make_built(self, pin: Pin, entry: _Entry) -> None:
        """Keep the exact bytes of an entry's modded parts before an Off replaces them, whole: every non-official part
        of one write of its configured source, as a file of the mod in mods/<id>/ when one holds those bytes, else a
        copy in built/<sha1>.bundle. The key replaces any earlier one."""
        source = entry.configured
        parts: dict[str, dict[str, Any]] = {}
        mod_files: dict[str, str] = {}
        if source.startswith("mod:") and source[4:] in self._records:
            for path in self._paths(self._records[source[4:]]):
                with contextlib.suppress(OSError):
                    mod_files[self._hashes.get(path).sha1] = path.name
        for part in entry.parts:
            if part.official or not part.record:
                continue
            sha1 = part.record["sha1"]
            if sha1 in mod_files:
                parts[part.path.name] = {"sha1": sha1, "mod_file": mod_files[sha1]}
                continue
            built = self.root / "built" / f"{sha1}.bundle"
            if not built.exists():
                atomic_copy(part.path, built)
            parts[part.path.name] = {"sha1": sha1, "mod_file": None}
        if not parts:
            return
        inputs = self._inputs(pin, entry.core, source)
        key = {"source": source, "inputs": inputs, "parts": parts}
        signatures = {(part.record or {}).get("build") for part in entry.parts}
        if len(signatures) == 1 and None not in signatures:
            key["build"] = signatures.pop()
        replaced: list[dict] = []

        def change(data: dict) -> None:
            built = self._folder(data, pin)["built"]
            if entry.core in built:
                replaced.append(built[entry.core])
            built[entry.core] = key

        self._update_profiles(change, after=lambda data: self._delete_built_files(replaced, data))
        # another instance may have dropped the last reference before the new key was saved
        recovered = False
        for part in entry.parts:
            kept = parts.get(part.path.name)
            if kept is not None and kept["mod_file"] is None:
                built = self.root / "built" / f"{kept['sha1']}.bundle"
                if not built.exists():
                    atomic_copy(part.path, built)
                    recovered = True
        if recovered:
            self._update_profiles(lambda data: False, after=lambda data: self._delete_built_files([key], data))

    def _inputs(self, pin: Pin, core: str, source: str) -> list[str]:
        """The other game files a build of a source reads: an adapted mod's official parts of its own core, another
        variant's files of the kind; none for a mod made for the core."""
        index = self._index(pin)
        if source.startswith("mod:") and source[4:] in self._records:
            record = self._records[source[4:]]
            own = core_of(record["files"][0])
            if own == core:
                return []
            replaced = {part_of(name) for name in record["files"]}
            return sorted(path.name for path in index.get(own, []) if part_of(path.name) not in replaced)
        if source.startswith("variant:"):
            other = self._core_map(pin).core(source[8:], self._kind(core, pin) or "spr")
            return sorted(path.name for path in index.get(other.lower(), [])) if other else []
        return []

    def _drop_built(self, pin_or_key: Pin | str, cores: list[str] | None = None,
                    when: Callable[[dict], bool] | None = None) -> None:
        """Drop built keys of an install (the given cores, or those ``when`` picks; with neither, all), deleting the
        built/ files no other key references."""
        target = pin_or_key.key if isinstance(pin_or_key, Pin) else pin_or_key
        dropped: list[dict] = []

        def change(data: dict) -> bool:
            folder = data["folders"].get(target)
            if not folder:
                return False
            for core in list(folder["built"]):
                if (cores is not None and core not in cores) or (when is not None and not when(folder["built"][core])):
                    continue
                dropped.append(folder["built"].pop(core))
            return bool(dropped)

        self._update_profiles(change, after=lambda data: self._delete_built_files(dropped, data))

    def _delete_built_files(self, keys: list[dict], data: dict | None) -> None:
        """Delete dropped keys' files no key references, under the profiles lock, against the saved configuration."""
        if not keys:
            return
        # a part kept as a file of its mod reads mods/<id>/, so only the others hold their built/ file
        referenced = {part.get("sha1") for folder in ((data or {}).get("folders") or {}).values()
                      for key in (folder.get("built") or {}).values()
                      for part in (key.get("parts") or {}).values() if not part.get("mod_file")}
        for key in keys:
            for part in (key.get("parts") or {}).values():
                sha1 = part.get("sha1")
                if part.get("mod_file") or not sha1 or sha1 in referenced:
                    continue
                path = self.root / "built" / f"{sha1}.bundle"
                if path.resolve().is_relative_to(self.root) and path.parent == self.root / "built":
                    deletion = getattr(self, '_asset_deletion', None)
                    if deletion:
                        deletion.remember_built(path)
                        path.unlink(missing_ok=True)
                    else:
                        with contextlib.suppress(OSError):
                            path.unlink()

    @_serialized
    def clear_built(self) -> int:
        """Clear Built Mods: delete built/*.bundle, stale temporaries and every built key with a part kept there.
        Keys whose parts are all files of their mod stay: they use no disk. The kept originals stay (Off needs
        them). Returns the bytes freed."""
        directory = self.root / "built"
        freed = _folder_size(directory)

        def change(data: dict) -> bool:
            changed = False
            for folder in data["folders"].values():
                for core in list(folder["built"]):
                    if any(not part.get("mod_file") for part in (folder["built"][core].get("parts") or {}).values()):
                        del folder["built"][core]
                        changed = True
            return changed

        def after(data: dict) -> None:
            nonlocal freed
            for path in directory.glob("*.bundle"):
                with contextlib.suppress(OSError):
                    path.unlink()
            cutoff = time.time() - BUILT_TEMP_MAX_AGE
            for path in directory.glob(".library-*"):
                with contextlib.suppress(OSError):
                    stat = path.stat()
                    if stat.st_mtime <= cutoff:
                        path.unlink()
                        freed += stat.st_size

        self._update_profiles(change, after=after)
        return freed

    # --- the configuration ---

    def _update_profiles(self, change: Callable[[dict], Any], after: Callable[[dict], Any] | None = None) -> Any:
        """One change of profiles.json, then ``after`` under its lock. Neither callback calls into Profiles or the
        library's public methods. Returns what the change returned when it is not a bool, else the configuration
        as written."""
        result: list[Any] = []

        def wrapped(data: dict) -> Any:
            value = change(data)
            result.append(value)
            return value

        data = self.profiles.update(wrapped, after=after)
        value = result[0] if result else None
        return data if value is None or isinstance(value, bool) else value

    def _folder(self, data: dict, pin: Pin) -> dict:
        """The install's record in a configuration, created when missing (with this data directory's id in
        named_by when its settings name the install)."""
        folders = data["folders"]
        folder = folders.get(pin.key)
        if folder is None:
            folder = folders[pin.key] = {"server": pin.server, "named_by": {}, "hidden": [], "configured": {},
                                          "updated": {}, "built": {}, "dismissed": {}}
            if any(named.key == pin.key for named in self._named_pins()):
                folder["named_by"][self.data_id] = now()
        return folder

    def _configure(self, pin: Pin, variant_key: str, kinds: dict[str, str], source: str | None) -> None:
        """Set (or, with None, drop) the configured source of an entry's cores. A changed or dropped configuration
        drops the entry's built copy and its updated marker."""
        stamp = now()
        dropped_keys: list[dict] = []
        named = any(other.key == pin.key for other in self._named_pins())

        def change(data: dict) -> bool:
            folder = data["folders"].get(pin.key)
            if folder is None:
                if source is None:
                    return False
                folder = self._new_folder(data, pin, named)
            changed = False
            for kind, core in kinds.items():
                if core.startswith("other:"):
                    kind = "other"
                current = folder["configured"].get(core)
                if source is None:
                    if current is None:
                        continue
                    del folder["configured"][core]
                elif current and current.get("source") == source:
                    continue
                else:
                    folder["configured"][core] = {"variant": variant_key, "kind": kind, "source": source,
                                                  "since": stamp}
                changed = True
                folder["updated"].pop(core, None)
                if core in folder["built"]:
                    dropped_keys.append(folder["built"].pop(core))
            return changed

        self._update_profiles(change, after=lambda data: self._delete_built_files(dropped_keys, data))

    def _new_folder(self, data: dict, pin: Pin, named: bool) -> dict:
        folder = data["folders"][pin.key] = {"server": pin.server, "named_by": {}, "hidden": [], "configured": {},
                                             "updated": {}, "built": {}, "dismissed": {}}
        if named:
            folder["named_by"][self.data_id] = now()
        return folder

    def _clear_marker(self, pin: Pin, core: str) -> None:
        def change(data: dict) -> bool:
            folder = data["folders"].get(pin.key)
            return bool(folder) and folder["updated"].pop(core, None) is not None

        with contextlib.suppress(ServiceError):
            if core in ((((self.profiles.read() or {}).get("folders") or {}).get(pin.key) or {}).get("updated") or {}):
                self._update_profiles(change)

    def _lookup_records(self) -> None:
        """At each build: find each named install's record (its own; a moved install's, re-keyed; else one migrated
        from what the library already wrote there), then refresh named_by and hidden of the records that exist. The
        scan consent is asked before profiles.json is locked."""
        config = self.profiles.read()
        allowed = self._scan_allowed()
        named = self._named_pins()
        folders = (config or {}).get("folders") or {}
        moves: dict[str, str] = {}
        migrations: dict[str, dict[str, dict]] = {}
        for pin in named:
            if pin.key in folders:
                continue
            gone = [key for key, folder in folders.items() if key not in moves.values()
                    and (folder.get("server") or "global") == pin.server and not Path(key).exists()
                    and Path(key).parent.is_dir()]
            if len(gone) == 1:
                moves[pin.key] = gone[0]
                continue
            migration = self._migration(pin, config)
            if migration:
                migrations[pin.key] = migration
        for new, old in moves.items():
            self._rekey(Path(old), next(pin for pin in named if pin.key == new), allowed)
        if not folders and not migrations:
            return
        named_keys = {pin.key for pin in named}
        pins = {pin.key: pin for pin in named}
        stamp = now()

        def change(data: dict) -> None:
            for new, old in moves.items():
                if new in data["folders"] or old not in data["folders"]:
                    continue
                data["folders"][new] = data["folders"].pop(old)
                for item in data["unfinished"]:
                    if item["install"] == old:
                        item["install"] = new
                logger.info("Moved the mod configuration of %s to %s", old, new)
            for key, configured in migrations.items():
                if key in data["folders"]:
                    continue
                folder = self._new_folder(data, pins[key], True)
                folder["configured"] = configured
                logger.info("Configured %d entries of %s from what the library wrote there", len(configured), key)
            for key, folder in data["folders"].items():
                if key in named_keys:
                    folder["named_by"][self.data_id] = stamp
                    if self.data_id in folder["hidden"]:
                        folder["hidden"].remove(self.data_id)
                else:
                    folder["named_by"].pop(self.data_id, None)

        self.profiles.update(change)

    def _rekey(self, old_root: Path, pin: Pin, allowed: bool) -> None:
        """A moved install: its records follow to the same relative paths where the file matches, by size and date,
        or (with scan consent: the new paths are not the library's yet) by size and last bytes. Nothing is hashed."""
        moved = 0
        for name, record in list(self._applied.items()):
            path = Path(name)
            if not path.is_relative_to(old_root):
                continue
            new = pin.root / path.relative_to(old_root)
            try:
                stat = new.stat()
            except OSError:
                continue
            match = stat.st_size == record.get("size") and stat.st_mtime_ns == record.get("mtime")
            if not match and allowed and record.get("tail") and stat.st_size == record.get("size"):
                match = read_tail(new) == record["tail"]
            if match:
                del self._applied[name]
                self._applied[str(new.resolve())] = {**record, "mtime": stat.st_mtime_ns}
                moved += 1
        if moved:
            self._save()
            logger.info("Moved %d records of %s to %s", moved, old_root, pin.root)

    def _migration(self, pin: Pin, config: dict | None) -> dict[str, dict]:
        """The configuration of an install without a record, from what the library already wrote there (recorded
        paths and names only): every entry whose non-official parts all carry one library source, and every entry
        whose present parts carry none while its gone records (renamed by a game update) all say non-official bytes
        of one source."""
        view = _View(self, [pin], config, "recorded")
        stamp = now()
        configured: dict[str, dict] = {}
        by_core: dict[str, list[tuple[Path, dict]]] = {}
        for folder in pin.dirs:
            for path, record in view.by_folder.get(folder, []):
                core = core_of(path.name)
                if kind_of_file(path.name):
                    by_core.setdefault(core, []).append((path, record))
        for core, records in sorted(by_core.items()):
            kind = self._kind(core, pin)
            parts = []
            for path in view.indexes[pin.key].get(core, []):
                if str(path.resolve()) in view.applied:
                    with contextlib.suppress(OSError, _Unread):
                        parts.append(view.part(path, pin, kind))
            nonofficial = [part for part in parts if not part.official]
            sources = {part.carried for part in nonofficial}
            source = None
            if nonofficial:
                if len(sources) == 1 and next(iter(sources)).startswith(LIBRARY_SOURCES):
                    source = next(iter(sources))
            else:
                gone = [(path, record) for path, record in records
                        if not path.exists() and path.parent.is_dir() and view.successor(pin, path)]
                gone_sources = {record.get("source") for path, record in gone
                                if view.says_nonofficial(path, record, present=False)}
                if gone and len(gone_sources) == 1 and all(
                        view.says_nonofficial(path, record, present=False) for path, record in gone):
                    candidate = next(iter(gone_sources))
                    if candidate and candidate.startswith(LIBRARY_SOURCES) and view.source_exists(
                            candidate, pin.key, kind):
                        source = candidate
            if source is None:
                # Older state kept only applied records. Preserve that choice after an
                # external reset too; selection() separately verifies installation.
                remembered = {record.get("source") for path, record in records
                              if view.says_nonofficial(path, record, present=path.exists())}
                if len(remembered) == 1:
                    candidate = next(iter(remembered))
                    if candidate and candidate.startswith(LIBRARY_SOURCES) and view.source_exists(candidate, pin.key, kind):
                        source = candidate
            if source:
                configured[core] = {"variant": view.maps[pin.key].key(core) or core, "kind": kind,
                                    "source": source, "since": stamp}
        return configured

    # --- entries and the scan ---

    def _entry_state(self, view: _View, entry: _Entry) -> EntryState:
        names = None
        if self.catalog.variant_for_core(entry.core) is None:
            names = view.maps[entry.pin.key].names.get(entry.variant)
        unknown = [part for part in entry.parts if part.carried == "unknown"]
        return EntryState(entry.pin.key, entry.core, entry.variant, names, entry.kind, entry.carried,
                          entry.configured, entry.state, entry.overwritten,
                          any(part.trailing for part in unknown), sum(part.size for part in unknown),
                          [self._file_state(view, entry, part) for part in entry.parts], entry.dismissed)

    def entries(self, pins: list[Pin] | None = None, include_dismissed: bool = False) -> list[EntryState]:
        """The entries of the pinned installs (default: every known one) that are configured, untracked, damaged,
        overwritten or not in their intended state. It reads headers of files the library did not write: it needs
        the scan consent (``scan_off``)."""
        return self.scan(pins, include_dismissed=include_dismissed).entries

    def scan(self, pins: list[Pin] | None = None, cancel: Callable[[], bool] | None = None,
             include_dismissed: bool = False, cores: set[str] | None = None) -> ScanResult:
        """The scan: the entries of every known install, judged cheaply (headers and the last bytes of recorded
        files; no file is read in full), with counts per install. Only with scan consent (``scan_off``). The records
        are copied under the library lock and the files read outside it; when the library wrote meanwhile, the
        result is ``stale`` and carries nothing. Take-overs and dropped configurations of sources gone from the
        library are saved."""
        if not self._scan_allowed():
            raise ServiceError("scan_off")
        with self._lock, _errors("scan"):
            pins = list(pins) if pins is not None else self.installs()
            view = self._view(pins, "scan", snapshot=True)
            version = self._version
        found = view.entries(pins, cancel) if cores is None else view.entries(pins, cancel, cores)
        with self._lock, _errors("scan"):
            if self._version != version:
                return ScanResult([], {}, stale=True)
            self._settle(view, found)
            result = [self._entry_state(view, entry) for entry in found]
        if include_dismissed:
            result = [replace(entry, dismissed=False) for entry in result]
        counts: dict[str, dict[str, int]] = {}
        for entry in result:
            count = counts.setdefault(entry.install, {})
            name = "stuck" if entry.state == "pending" and entry.overwritten else entry.state
            count[name] = count.get(name, 0) + 1
            if entry.configured:
                count["configured"] = count.get("configured", 0) + 1
        return ScanResult(result, counts)

    def _settle(self, view: _View, found: list[_Entry]) -> None:
        """What the judgement settles in the configuration: take-overs (a newer library write than the configured
        source, or a library source with none) and sources gone from the library (dropped once listed); and the new
        dates of files the library knows by their last bytes."""
        restamps = {str(part.path.resolve()): part.restamp for entry in found for part in entry.parts
                    if part.restamp is not None and part.record is not None}
        if restamps:
            for path, mtime in restamps.items():
                if path in self._applied:
                    logger.info("Same bytes, new date: %s", Path(path).name)
                    self._applied[path]["mtime"] = mtime
            with contextlib.suppress(OSError):
                self._save()
        takeovers = [entry for entry in found if entry.takeover]
        missing = [entry for entry in found if entry.state == "source_missing"]
        if not takeovers and not missing:
            return
        stamp = now()
        dropped: list[dict] = []

        def change(data: dict) -> bool:
            changed = False
            for entry in takeovers:
                folder = self._folder(data, entry.pin)
                current = (folder["configured"].get(entry.core) or {}).get("source")
                expected = (view.configured(entry.pin.key, entry.core) or {}).get("source")
                if current != expected:
                    continue
                logger.info("Configured %s in %s with %s (taken over)", entry.core, entry.pin.key, entry.takeover)
                folder["configured"][entry.core] = {"variant": entry.variant, "kind": entry.kind,
                                                    "source": entry.takeover, "since": stamp}
                if entry.core in folder["built"]:
                    dropped.append(folder["built"].pop(entry.core))
                changed = True
            for entry in missing:
                folder = data["folders"].get(entry.pin.key)
                if folder and entry.core in folder["configured"]:
                    logger.info("Dropped the configuration of %s in %s: %s is gone from the library", entry.core,
                                entry.pin.key, entry.configured)
                    del folder["configured"][entry.core]
                    folder["updated"].pop(entry.core, None)
                    if entry.core in folder["built"]:
                        dropped.append(folder["built"].pop(entry.core))
                    changed = True
            return changed

        self._update_profiles(change, after=lambda data: self._delete_built_files(dropped, data))

    # --- adopting mods already in use ---

    def adopt(self, entries: list[dict], pins: list[Pin] | None = None, log: LogFunc = no_log,
              progress: ProgressCallback | None = None, cancel: Callable[[], bool] | None = None) -> AdoptResult:
        """Add mods already in use to the library (a writer job of the library only): each given entry ({install,
        core}) that is still untracked or changed is stored as one mod of its non-official parts, every part is
        recorded, the entry configured with it and its built copy kept as the mod's own files. Official copies are
        kept in originals/ now, while they exist. ``not_enough_space`` when it does not fit with 512 MiB to spare."""
        with self._lock, _errors("adopt"):
            pins = list(pins) if pins is not None else self.installs()
            self._check_pins(pins)
            by_key = {pin.key: pin for pin in pins}
            wanted = [(by_key[item["install"]], item["core"].lower()) for item in entries
                      if isinstance(item, dict) and item.get("install") in by_key and isinstance(item.get("core"), str)]
            view = self._view(pins, "family")
            need = 0
            for pin, core in wanted:
                with contextlib.suppress(OSError, _Unread):
                    entry = view.entry(pin, core)
                    need += sum(part.size for part in entry.parts if part.carried == "unknown")
                    need += sum(part.size for part in entry.parts if not part.official
                                and entry.copies.get(str(part.path)) in ("backup", "elsewhere"))
            self._check_space(need)
        added, failed, skipped, cores, kinds = [], [], [], set(), set()
        for i, (pin, core) in enumerate(wanted, 1):
            if cancel and cancel():
                break
            with self._lock:
                try:
                    with _errors("adopt"):
                        mod_id = self._adopt_one(pin, core)
                except ServiceError as error:
                    if error.code == "entry_changed":
                        skipped.append({"install": pin.key, "core": core, "why": "entry_changed"})
                    else:
                        failed.append({"entry": {"install": pin.key, "core": core}, "code": error.code,
                                       "params": error.to_json()["params"]})
                    continue
                added.append(self._entry(self._records[mod_id]))
                cores.add(core)
                kinds.add(self._kind(core, pin) or "spr")
            if progress:
                progress(i, len(wanted), t("webui.progress.add", name=core))
        return AdoptResult(added, failed, skipped, sorted(cores), sorted(kinds))

    def _check_space(self, need: int) -> None:
        if need <= 0:
            return
        folder = self.root
        while not folder.exists() and folder.parent != folder:
            folder = folder.parent
        free = shutil.disk_usage(folder).free
        if need + SPACE_MARGIN > free:
            raise ServiceError("not_enough_space", need=need, free=free)

    @_mod_writer
    def _adopt_one(self, pin: Pin, core: str, mod_id: str | None = None) -> str:
        """Adopt one entry, under the library lock: its files read in full (they are copied anyway). Rolled back as a
        whole on failure; a mod already in the library stays as it was."""
        view = self._view([pin, *[p for p in self.installs() if p.key != pin.key]], "full")
        entry = view.entry(pin, core)
        if entry.state not in ("untracked", "changed"):
            raise ServiceError("entry_changed", core=core)
        nonofficial = [part for part in entry.parts if not part.official]
        if not nonofficial:
            raise ServiceError("entry_changed", core=core)
        old_applied = copy.deepcopy(self._applied)
        if mod_id is None:
            mod_id = next((record["id"] for record in self._records.values()
                           if self._matches_installed(self._identity({path.name: path for path in self._paths(record)}),
                                                      entry)), None)
        if mod_id is None:
            mod_id, created = self._add_group([part.path for part in nonofficial],
                                              parse_filename(nonofficial[0].path.name).core, pin)
        else:
            record = self._record(mod_id)
            if not self._matches_installed(self._identity({path.name: path for path in self._paths(record)}), entry):
                raise ServiceError("entry_changed", core=core)
            created = False
        source = f"mod:{mod_id}"
        try:
            for part in nonofficial:
                with contextlib.suppress(ServiceError):  # overwritten: no official copy to keep
                    self._keep_original(part.path, pin)
            stamp = now()
            for part in entry.parts:
                fingerprint = self._hashes.get(part.path)
                stat = part.path.stat()
                self._applied[str(part.path.resolve())] = {
                    "source": source, "sha1": fingerprint.sha1, "size": stat.st_size, "mtime": stat.st_mtime_ns,
                    "official": part.official, "at": stamp,
                    "tail": read_tail(part.path) if fingerprint.trailing else None}
            self._save()
            files = {self._hashes.get(path).sha1: path.name for path in self._paths(self._records[mod_id])}
            built = {"source": source, "inputs": [],
                     "parts": {part.path.name: {"sha1": self._hashes.get(part.path).sha1,
                                                "mod_file": files.get(self._hashes.get(part.path).sha1)}
                               for part in nonofficial}}
            variant = entry.variant
            named = any(other.key == pin.key for other in self._named_pins())
            replaced: list[dict] = []

            def change(data: dict) -> None:
                folder = data["folders"].get(pin.key) or self._new_folder(data, pin, named)
                folder["configured"][core] = {"variant": variant, "kind": entry.kind, "source": source,
                                              "since": stamp}
                folder["updated"].pop(core, None)
                if core in folder["built"]:
                    replaced.append(folder["built"][core])
                folder["built"][core] = built

            self._update_profiles(change, after=lambda data: self._delete_built_files(replaced, data))
        except Exception:
            self._applied = old_applied
            with contextlib.suppress(OSError):
                self._save()
            if created:
                self._drop_mods([mod_id])
            raise
        logger.info("Added %s of %s to the library as mod %s", core, pin.key, mod_id)
        return mod_id

    # --- the Enable Mods switch ---

    def intent(self) -> dict[str, Any]:
        """The switch's shared intent: {enabled, toggled, unfinished: {pending, left, stuck}} over this data
        directory's known installs; ``profiles_unreadable`` raised as is."""
        config = self.profiles.read()
        keys = {pin.key for pin in self.installs()}
        counts = {why: 0 for why in profiles_mod.WHY}
        for item in (config or {}).get("unfinished", []):
            if item["install"] in keys:
                counts[item["why"]] += 1
        return {"enabled": profiles_mod.enabled(config), "toggled": (config or {}).get("toggled"),
                "unfinished": counts}

    def status(self) -> dict[str, Any]:
        """What the switch's snapshot needs from the library, from names and profiles.json only: the known
        installs, the current one, the intent, the configured count, and ``reason`` (profiles_unreadable or None).
        Never takes the library lock or walks the storage folders. Each install's
        ``distinct`` is the shortest trailing part of its path that tells it from the other installs of its server
        (for the install label, "Global (BlueArchive)"), None when it is the only one of its server."""
        pins = self.installs()
        named = {pin.key for pin in self._named_pins()}
        current = self.current_pin()
        servers: dict[str, dict[str, Path]] = {}
        for pin in pins:
            servers.setdefault(pin.server, {})[pin.key] = pin.root
        distinct: dict[str, str] = {}
        for roots in servers.values():
            if len(roots) > 1:
                distinct.update(distinguishing_folders(roots))
        out: dict[str, Any] = {
            "installs": [{"id": pin.id, "key": pin.key, "server": pin.server, "folder": str(pin.root),
                          "named": pin.key in named, "distinct": distinct.get(pin.key)} for pin in pins],
            "current": current.key if current else None,
            "reason": None,
        }
        try:
            config = self.profiles.read()
            out.update(self.intent())
        except ServiceError as error:
            out.update(enabled=True, toggled=None, unfinished={why: 0 for why in profiles_mod.WHY},
                       reason=error.code, file=error.params.get("file"))
            config = None
        keys = {pin.key for pin in pins}
        out["configured"] = sum(len(folder.get("configured") or {}) for key, folder in
                                ((config or {}).get("folders") or {}).items() if key in keys)
        return out

    def sizes(self, kind: str) -> dict[str, int]:
        """Count stored bundles only for the size a help popup or Settings row is showing."""
        if kind not in ("built", "originals"):
            raise ServiceError("bad_params", key="kind")
        return {f"{kind}Size": _folder_size(self.root / kind)}

    def _plan_toggle(self, enabled: bool, pins: list[Pin], config: dict | None,
                     found: list[_Entry]) -> list[tuple[Pin, str]]:
        """The entries a toggle reaches, in every known install: for an Off with scan consent, every entry its own
        pass over the files found (``found``), and for any Off the configured entries and those with records. For an
        On, the configured entries, those with a record of a removed mod, and those the unfinished list holds."""
        plan: list[tuple[Pin, str]] = []
        seen: set[tuple[str, str]] = set()

        def add(pin: Pin, core: str) -> None:
            if (pin.key, core) not in seen and self._kind(core, pin):
                seen.add((pin.key, core))
                plan.append((pin, core))

        folders = (config or {}).get("folders") or {}
        for entry in found:
            add(entry.pin, entry.core)
        for pin in pins:
            folder = folders.get(pin.key) or {}
            for core in sorted(folder.get("configured") or {}):
                add(pin, core)
            for name, record in sorted(self._applied.items()):
                path = Path(name)
                if path.parent in pin.dirs and (not enabled or record.get("removed")):
                    add(pin, core_of(path.name))
        if enabled:
            keys = {pin.key: pin for pin in pins}
            for item in (config or {}).get("unfinished", []):
                if item["install"] in keys:
                    add(keys[item["install"]], item["core"])
        return plan

    def _hidden_items(self, config: dict | None) -> list[dict[str, str]]:
        """The entries of the installs this data directory removed from its list: listed as not switched for the data
        directory that names them (a toggle here leaves their files as they are)."""
        items = []
        for key, folder in ((config or {}).get("folders") or {}).items():
            if self.data_id not in (folder.get("hidden") or []):
                continue
            cores = set(folder.get("configured") or {})
            root = Path(key)
            cores.update(core_of(Path(path).name) for path in self._applied
                         if Path(path).is_relative_to(root) and kind_of_file(Path(path).name))
            items.extend({"install": key, "core": core, "why": "pending"} for core in sorted(cores))
        return items

    def toggle(self, enabled: bool, expect: bool, pins: list[Pin] | None = None, log: LogFunc = no_log,
               progress: ProgressCallback | None = None, cancel: Callable[[], bool] | None = None) -> ToggleResult:
        """The Enable Mods switch over every known install (a writer job of the game folders). An Off adopts the mods
        it finds first (with scan consent its own pass finds them; without, the changed files it meets), keeps the
        built copies, then switches every entry carrying a library source to official. An On switches every
        configured entry that does not carry its source to it, from the built copy when it still fits. The
        configuration never changes (decision 2); the intent and the entries not switched yet are saved first.
        ``expect`` is the intent the caller saw (``state_changed`` otherwise); Retry is the same call with ``expect``
        equal to the current intent."""
        return self._run(enabled, expect, pins, log, progress, cancel, drift=None)

    def restore_drift(self, entries: list[dict], pins: list[Pin] | None = None, log: LogFunc = no_log,
                      progress: ProgressCallback | None = None,
                      cancel: Callable[[], bool] | None = None) -> ToggleResult:
        """Apply Mod Configuration: switch each given reset or updated entry ({install, core, state}) to its
        configured source again, the whole core, from its built copy when it still fits; its configuration stays.
        A changed entry is switched only when listed as changed (its outside change is kept as a mod first); one
        that turned changed since it was listed is skipped."""
        return self._run(None, None, pins, log, progress, cancel, drift=entries)

    def _run(self, enabled: bool | None, expect: bool | None, pins: list[Pin] | None, log: LogFunc,
             progress: ProgressCallback | None, cancel: Callable[[], bool] | None,
             drift: list[dict] | None) -> ToggleResult:
        with self._lock, _errors("toggle"):
            pins = list(pins) if pins is not None else self.installs()
            self._check_pins(pins)
            config = self.profiles.read()
            current = profiles_mod.enabled(config)
            if drift is None and current != expect:
                raise ServiceError("state_changed")
            safety.check_game_not_running()
            self._check_idle(pins)
            if drift is None:
                from .portrait_edit import refresh_missing
                refresh_missing(self, pins, log)
                config = self.profiles.read()
            if drift is not None:
                if not current:  # mods off: official files are the intent, there is no drift to apply
                    raise ServiceError("state_changed")
                enabled = current
                by_key = {pin.key: pin for pin in pins}
                plan = [(by_key[item["install"]], item["core"].lower()) for item in drift
                        if isinstance(item, dict) and item.get("install") in by_key
                        and isinstance(item.get("core"), str)]
                listed = {(item["install"], item["core"].lower()): item.get("state") for item in drift
                          if isinstance(item, dict) and isinstance(item.get("core"), str)}
                allowed = False
            else:
                allowed = self._scan_allowed()  # asked once: the job keeps the answer it planned with
                # an Off with scan consent plans from the files as they are now: its own pass
                found = self._view(pins, "scan", config).entries(pins) if (not enabled and allowed) else []
                plan = self._plan_toggle(enabled, pins, config, found)
                listed = {}
                if not enabled:
                    self._check_space(self._off_space(plan, found, config))
            hidden = self._hidden_items(config) if drift is None else []
        stamp = now()
        if drift is None:
            def intent(data: dict) -> None:
                data["enabled"], data["toggled"] = enabled, stamp
                listed_keys = {(item["install"], item["core"]) for item in data["unfinished"]}
                for pin, core in plan:
                    if (pin.key, core) not in listed_keys:
                        data["unfinished"].append({"install": pin.key, "core": core, "why": "pending"})
                        listed_keys.add((pin.key, core))
                for item in hidden:
                    if (item["install"], item["core"]) not in listed_keys:
                        data["unfinished"].append(item)
                        listed_keys.add((item["install"], item["core"]))

            with _errors("toggle"):
                self.profiles.update(intent)
            logger.info("Mods %s: %d entries to reach", "on" if enabled else "off", len(plan))
        result = {"done": [], "adopted": [], "failed": [], "stuck": [], "left": [], "skipped": [], "dropped": []}
        outcomes: dict[tuple[str, str], str | None] = {}
        cores: set[str] = set()
        kinds: set[str] = set()
        saved_at, unsaved = time.monotonic(), 0
        stop: ServiceError | None = None
        for i, (pin, core) in enumerate(plan, 1):
            if cancel and cancel():
                break
            with self._lock:
                try:
                    with _errors("toggle"):
                        self._check_pins(pins)
                        outcome, why, entry = self._reach(pin, core, enabled, allowed, listed.get((pin.key, core)),
                                                          drift is not None, log)
                except ServiceError as error:
                    item = {"install": pin.key, "core": core, "kind": self._kind(core, pin) or "spr",
                            "variant": self._core_map(pin).key(core) or core}
                    self._selection_error(pin, [core], error.to_json())
                    result["failed"].append({"entry": item, "code": error.code, "params": error.to_json()["params"]})
                    outcomes[(pin.key, core)] = "pending"
                    if error.code in STOPPING:
                        stop = error
                        break
                    continue
            outcomes[(pin.key, core)] = why
            if "done" in outcome:
                self._selection_error(pin, [core], None)
            for name, value in outcome.items():
                result[name].append(value)
            if entry is not None and ("done" in outcome or "adopted" in outcome):
                cores.add(core)
                kinds.add(entry["kind"])
            unsaved += 1
            if unsaved >= SAVE_EVERY[0] or time.monotonic() - saved_at >= SAVE_EVERY[1]:
                with _errors("toggle"):
                    self._save_outcomes(outcomes)
                outcomes, unsaved, saved_at = {}, 0, time.monotonic()
            if progress:
                progress(i, len(plan), t("webui.progress.apply" if enabled else "webui.progress.restore", name=core))
        with self._lock:
            self._prune_quietly()
        with _errors("toggle"):
            self._save_outcomes(outcomes)
        if stop is not None:
            raise stop
        return ToggleResult(bool(enabled), result["done"], result["adopted"], result["failed"], result["stuck"],
                            result["left"], result["skipped"], result["dropped"], sorted(cores), sorted(kinds))

    def _save_outcomes(self, outcomes: dict[tuple[str, str], str | None]) -> None:
        """The unfinished list after reached entries: an entry that holds its intent leaves, another keeps (or gets)
        the why of what happened. Items of entries the job did not reach stay as they are."""
        if not outcomes:
            return

        def change(data: dict) -> bool:
            items = {(item["install"], item["core"]): item for item in data["unfinished"]}
            for key, why in outcomes.items():
                if why is None:
                    items.pop(key, None)
                else:
                    items[key] = {"install": key[0], "core": key[1], "why": why}
            data["unfinished"] = list(items.values())
            return True

        self.profiles.update(change)

    def _off_space(self, plan: list[tuple[Pin, str]], found: list[_Entry], config: dict | None) -> int:
        """What an Off copies: the mods it adopts and their official copies (from its pass), and the built copies it
        keeps (parts not in built/ yet and not files of their mod)."""
        need = 0
        for entry in found:
            if entry.state in ("untracked", "changed"):
                need += sum(part.size for part in entry.parts if part.carried == "unknown")
                need += sum(part.size for part in entry.parts if not part.official
                            and entry.copies.get(str(part.path)) in ("backup", "elsewhere"))
        folders = (config or {}).get("folders") or {}
        for pin, core in plan:
            configured = ((folders.get(pin.key) or {}).get("configured") or {}).get(core)
            source = (configured or {}).get("source")
            if not source:
                continue
            mod_sha1s: set[str] = set()
            if source.startswith("mod:") and source[4:] in self._records:
                with contextlib.suppress(OSError):
                    mod_sha1s = {self._hashes.get(path).sha1 for path in self._paths(self._records[source[4:]])}
            for path in self._index(pin).get(core, []):
                record = self._applied.get(str(path.resolve()))
                if not record or record.get("source") != source or record.get("official") is True:
                    continue
                if record.get("sha1") in mod_sha1s or (self.root / "built" / f"{record.get('sha1')}.bundle").exists():
                    continue
                need += record.get("size") or 0
        return need

    def _reach(self, pin: Pin, core: str, enabled: bool, allowed: bool, listed_state: str | None, drift: bool,
               log: LogFunc) -> tuple[dict[str, Any], str | None, dict | None]:
        """One entry of a toggle, Retry or Apply Mod Configuration, under the library lock: its configuration read
        again and its files judged at write strength (a part the library can show unchanged by stat carries its
        record's source; every other part is read in full). Returns (what happened, by result list; the entry's
        why in the unfinished list, None when it leaves; the entry)."""
        pins = self._view_pins(pin)
        view = self._view(pins, "full")
        entry = view.entry(pin, core)
        self._note_judged(view, entry)
        item = entry.item()
        outcome: dict[str, Any] = {}
        if entry.state == "source_missing":
            self._configure(pin, entry.variant, {entry.kind: core}, None)
            logger.info("Dropped the configuration of %s: %s is gone from the library", core, entry.configured)
            outcome["dropped"] = item
            view = self._view(pins, "full")
            entry = view.entry(pin, core)
        if entry.takeover:
            self._configure(pin, entry.variant, {entry.kind: core}, entry.takeover)
            logger.info("Configured %s in %s with %s (taken over)", core, pin.key, entry.takeover)
            view = self._view(pins, "full")
            entry = view.entry(pin, core)
        state = entry.state
        if state in ("damaged", "missing"):
            outcome["skipped"] = {**item, "why": state}
            return outcome, None, item
        if enabled is False:
            if state in ("untracked", "changed"):
                try:
                    if allowed is False:
                        self._check_space(sum(part.size for part in entry.parts if part.carried == "unknown"))
                    saved = entry.configured
                    mod_id = self._adopt_one(pin, core)
                    if saved and view.source_exists(saved, pin.key, entry.kind):
                        self._configure(pin, entry.variant, {entry.kind: core}, saved)
                except ServiceError as error:
                    outcome["left"] = {**item, "code": error.code, "params": error.to_json()["params"]}
                    return outcome, "left", item
                outcome["adopted"] = {**item, "mod": mod_id}
                view = self._view(pins, "full")
                entry = view.entry(pin, core)
            if entry.carried == "official":
                return outcome, None, item
            if entry.overwritten:
                outcome["stuck"] = item
                return outcome, "stuck", item
            if entry.configured and entry.carried == entry.configured and not entry.drifted:
                self._make_built(pin, entry)
            try:
                self._switch(pin, core, "official", log)
            except ServiceError as error:
                if error.code == "original_unavailable":
                    outcome["stuck"] = item
                    return outcome, "stuck", item
                raise
            outcome["done"] = item
            return outcome, None, item
        # mods on: an On, its Retry, or Apply Mod Configuration
        if state in ("untracked", "changed") and not (entry.configured and not drift) and not (drift and state == "changed" and listed_state == "changed"):
            outcome["skipped"] = {**item, "why": state}
            return outcome, (None if leaves(state, True) else "pending"), item
        if drift and state not in ("reset", "updated", "changed"):
            if state != "ok":
                outcome["skipped"] = {**item, "why": "entry_changed"}
            return outcome, (None if leaves(state, True) else "pending"), item
        target = entry.configured or "official"
        if state == "ok":
            self._selection_error(pin, [core], None)
            return outcome, None, item
        if entry.overwritten and not entry.configured:
            outcome["stuck"] = item
            return outcome, "stuck", item
        try:
            self._switch(pin, core, target, log)
        except ServiceError as error:
            if error.code == "original_unavailable":
                outcome["stuck"] = item
                return outcome, "stuck", item
            raise
        outcome["done"] = item
        return outcome, None, item

    def _note_judged(self, view: _View, entry: _Entry) -> None:
        """What a judgement found that the records keep, so the cheap judgement agrees with it from then on: the new
        date of a file whose bytes are the record's (its sha1 at write strength, its last bytes cheaply), and, at
        write strength, a file the cheap rule calls official whose bytes were changed outside the library (``outside``,
        its size and date; dropped by the next write there)."""
        changed = False
        for part in entry.parts:
            record = self._applied.get(str(part.path.resolve())) if part.record is not None else None
            if record is None:
                continue
            if part.restamp is not None:
                if record.get("mtime") != part.restamp or "outside" in record:
                    logger.info("Same bytes, new date: %s", part.path.name)
                    record["mtime"] = part.restamp
                    record.pop("outside", None)
                    changed = True
                continue
            if view.allow != "full" or part.matched or part.carried != "unknown" or part.trailing != 0:
                continue
            expected = view.official_size(part.path.name)
            if expected is not None and expected != part.size:
                continue  # the cheap rule finds it already: another size than the official file
            mark = [part.size, part.mtime]
            if record.get("outside") != mark:
                logger.info("Changed outside the library, though it looks official: %s", part.path.name)
                record["outside"] = mark
                changed = True
        if changed:
            try:
                self._save()
            except OSError as error:
                log_failure(logger, logging.WARNING, "Could not save what a judgement found", error)

    def judge_unfinished(self) -> int:
        """Judge the unfinished list's entries again from what the library recorded (stat, header and last bytes of
        its own writes; no scan consent needed), and drop those that need nothing more (the leaving rule). Only the
        items of this data directory's known installs; nothing is dropped when the intent changed meanwhile.
        Returns the number of items dropped. Runs on the job worker."""
        with self._lock, _errors("judge_unfinished"):
            config = self.profiles.read()
            if not config or not config.get("unfinished"):
                return 0
            enabled, toggled = profiles_mod.enabled(config), config.get("toggled")
            pins = self.installs()
            by_key = {pin.key: pin for pin in pins}
            allowed = self._scan_allowed()
            view = self._view(pins, "scan" if allowed else "recorded", config)
            leaving: set[tuple[str, str]] = set()
            for item in config["unfinished"]:
                pin = by_key.get(item["install"])
                if pin is None:
                    continue
                files = view.indexes[pin.key].get(item["core"], [])
                if not allowed and files and not any(str(path.resolve()) in view.applied for path in files):
                    continue  # judged only by the scan, or when a toggle reaches it
                try:
                    entry = view.entry(pin, item["core"])
                except (OSError, _Unread):
                    continue
                self._note_judged(view, entry)
                if leaves(entry.state, enabled):
                    leaving.add((item["install"], item["core"]))
            if not leaving:
                return 0
            dropped = []

            def change(data: dict) -> bool:
                if profiles_mod.enabled(data) != enabled or data.get("toggled") != toggled:
                    return False
                kept = [item for item in data["unfinished"] if (item["install"], item["core"]) not in leaving]
                dropped.extend(range(len(data["unfinished"]) - len(kept)))
                data["unfinished"] = kept
                return bool(dropped)

            self.profiles.update(change)
            return len(dropped)

    # --- prompts and settings ---

    @_serialized
    def dismiss(self, kind: str, entries: list[dict]) -> None:
        """Keep as Is / Don't Ask Again: remember each entry's files by name, size and modification time, so its
        prompt does not come back until one of them changes. Nothing is read beyond stats."""
        if kind not in ("drift", "untracked"):
            raise ServiceError("bad_params", kind=kind)
        pins = {pin.key: pin for pin in self.installs()}
        found = {}
        for item in entries:
            pin = pins.get(item.get("install")) if isinstance(item, dict) else None
            if pin is None or not isinstance(item.get("core"), str):
                continue
            core = item["core"].lower()
            files = []
            for path in self._index(pin).get(core, []):
                with contextlib.suppress(OSError):
                    stat = path.stat()
                    files.append([path.name, stat.st_size, stat.st_mtime_ns])
            found[(pin.key, core)] = (pin, sorted(files))
        if not found:
            return

        def change(data: dict) -> None:
            for (key, core), (pin, files) in found.items():
                self._folder(data, pin)["dismissed"].setdefault(kind, {})[core] = files

        self._update_profiles(change)

    @_serialized
    def forget(self, install: str) -> None:
        """Remove from List: take a recorded install this data directory's settings no longer name off its list. With
        no other data directory naming it, its record goes (configuration, markers, dismissals, built copies and
        unfinished items); otherwise it is only hidden here. state.json's records and the kept originals stay, and
        no game file is touched. ``bad_params`` for a named install."""
        if any(pin.key == install for pin in self._named_pins()):
            raise ServiceError("bad_params", install=install)
        dropped: list[dict] = []
        data_id = self.data_id

        def change(data: dict) -> bool:
            folder = data["folders"].get(install)
            if folder is None:
                return False
            if any(other != data_id for other in folder["named_by"]):
                if data_id not in folder["hidden"]:
                    folder["hidden"].append(data_id)
                return True
            dropped.extend(folder["built"].values())
            del data["folders"][install]
            data["unfinished"] = [item for item in data["unfinished"] if item["install"] != install]
            return True

        self._update_profiles(change, after=lambda data: self._delete_built_files(dropped, data))

    # --- working on mods ---

    def _remap_source_atlases(self, paths: list[Path], selected: dict[str, bytes],
                             official: dict[str, bytes], available: list[Path] | None = None) -> dict[str, bytes]:
        """Fill absent source atlases only from verified official copies of the mod's date."""
        missing = official.keys() - atlas_remap.pair_atlases(selected, official).keys()
        if not missing:
            return selected
        core = core_of(paths[0].name)
        dates = {date_of(path.name) for path in paths} - {""}
        fallback = {}
        candidates = {name: self.root / "originals" / name for name in self._originals()}
        candidates.update({path.name: path for path in available or ()})
        for name, path in sorted(candidates.items()):
            if core_of(name) != core or date_of(name) not in dates:
                continue
            if not self._is_official(path):
                raise ServiceError("original_invalid", file=name)
            for asset, text in integrity.inspect(path).atlases.items():
                if asset in fallback and fallback[asset] != text:
                    raise atlas_remap.RemapError("atlas_remap_asset_ambiguous", file=name, name=asset)
                fallback[asset] = text
        pairs = atlas_remap.pair_atlases(fallback, {name: official[name] for name in missing})
        result = dict(selected)
        result.update({name: fallback[source] for name, source in pairs.items()})
        if not result:
            raise atlas_remap.RemapError("atlas_remap_source_missing", file=", ".join(sorted(missing)),
                                         date=", ".join(sorted(dates)) or "—")
        return result

    @_serialized
    def remap(self, mod_id: str, log: LogFunc = no_log,
              progress: Callable[[dict], None] | None = None, pin: Pin | None = None) -> dict:
        """Prepare a review in temporary storage; only accept_remap can add it to the library."""
        pin = self._current(pin)
        record = self._record(mod_id)
        if record.get("repaired_from") or record.get("repaired_id"):
            raise ServiceError("entry_changed")
        self._remap_previews = {token: preview for token, preview in self._remap_previews.items()
                                if preview["expires"] > time.monotonic() and preview["source"] != mod_id}
        paths = self._paths(record)
        identity = self._identity({path.name: path for path in paths})
        targets = self._spine_parts(core_of(paths[0].name), pin)
        if not targets:
            raise ServiceError("game_file_not_found", variant=record["target"])
        def step(key: str, current: int = 1) -> None:
            if progress:
                progress({"current": current, "total": len(targets), "step": f"import.step.{key}"})

        with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX + "remap-") as temporary:
            output = Path(temporary)
            step("check")
            originals = self._stage_official(targets, output / "official", pin)
            try:
                step("extract")
                mod = atlas_remap.read_inputs(paths)
                official = atlas_remap.read_inputs(list(originals.values()))

                replaced = {part_of(path.name) for path in paths}
                others = [original for target, original in originals.items() if part_of(target.name) not in replaced]
                original_view = atlas_remap.read_inputs(others + paths)
                mixed = {name: data for name, data in original_view.atlases.items() if name not in mod.atlases
                         and any(atlas_remap.texture_key(page) in mod.textures
                                 for page in atlas_remap.parse_atlas(data, name).pages)}
                if not mixed or not atlas_remap.page_size_mismatch(
                        mixed, {name: image.size for name, image in original_view.textures.items()}):
                    return {"unchanged": True}
                mod.atlases = {**mod.atlases, **self._remap_source_atlases(paths, {}, mixed, list(originals.values()))}
                target_inputs = replace(official, atlases=original_view.atlases, skeletons=original_view.skeletons)
                patch, report = atlas_remap.prepare_patch(mod, target_inputs)
                # Preserve the winning mod skeleton and atlas when porting the texture patch.
                text_patch = {}
                for path in paths:
                    bundle = Bundle.load(path)
                    extracted, _ = bundle.extract_patch({"TextAsset"}, "cont_name_type")
                    text_patch.update(extracted)
                target_keys = set().union(*(Bundle.load(path).get_asset_keys("cont_name_type") for path in originals.values()))
                if text_patch.keys() - target_keys:
                    raise atlas_remap.RemapError("atlas_remap_target_mismatch", file=paths[0].name,
                                                 matched=len(text_patch.keys() & target_keys), expected=len(text_patch))
                patch.update(text_patch)
            except atlas_remap.RemapError as error:
                raise ServiceError(error.code, **error.params) from error
            except (ValueError, KeyError, EOFError, OSError) as error:
                raise ServiceError("atlas_remap_invalid", file=", ".join(path.name for path in paths),
                                   reason=str(error)) from error
            if report["unchanged"]:
                return {"unchanged": True, "report": report}
            generated = {}
            for i, (target, original) in enumerate(originals.items(), 1):
                step("replace", i)
                bundle = Bundle.load(original)
                if bundle is None:
                    raise ServiceError("bundle_invalid", file=original.name)
                keys = bundle.get_asset_keys("cont_name_type")
                local_patch = {key: value for key, value in patch.items() if key in keys}
                local_patch.update({key: patch[official.keys[atlas_remap.texture_key(key.name)]]
                                    for key in keys if key.type == "Texture2D"})
                if local_patch:
                    result = core.process_mod_update([], [original], output, {"Texture2D"},
                        self.settings.save_options(self.settings.crc_needed(target)),
                        match_strategy="cont_name_type", log=log, prepared_patch=local_patch,
                        on_step=lambda key: step(key, i))
                    if not result.success or len(result.file_pairs) != 1:
                        raise ServiceError("mod_update_failed", id=mod_id)
                else:
                    atomic_copy(original, output / target.name)
                generated[target.name] = output / target.name
            if identity != self._identity({path.name: path for path in paths}):
                raise ServiceError("entry_changed")
            comparison = self._compare_paths(mod_id, list(generated.values()), paths)
            repaired = atlas_remap.read_inputs(list(generated.values()))

            def png(image) -> str | None:
                if image is None:
                    return None
                stream = io.BytesIO()
                image.save(stream, format="PNG")
                return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")

            pages = [{"name": name, "original": png(original_view.textures.get(name)),
                      "repaired": png(repaired.textures.get(name))}
                     for name in sorted(original_view.textures.keys() | repaired.textures.keys())]

            def scenes(inputs) -> list[dict]:
                atlas_by_stem = {Path(name).stem.lower(): data for name, data in inputs.atlases.items()}
                result = []
                for name, data in inputs.skeletons.items():
                    atlas = atlas_by_stem.get(Path(name).stem.lower())
                    if atlas is None and len(inputs.atlases) == 1:
                        atlas = next(iter(inputs.atlases.values()))
                    if atlas is not None:
                        result.append({"name": name, "json": data.decode("utf-8-sig", errors="replace").lstrip().startswith("{"),
                                       "skeleton": base64.b64encode(data).decode("ascii"),
                                       "atlas": atlas.decode("utf-8-sig")})
                return result

            drawings = {"original": scenes(original_view), "repaired": scenes(repaired)}
            token = uuid.uuid4().hex
            self._remap_previews[token] = {
                "source": mod_id, "identity": identity,
                "files": {name: path.read_bytes() for name, path in generated.items()},
                "report": report, "compare": comparison, "expires": time.monotonic() + 3600,
            }
        return {"preview": token, "report": report, "compare": comparison.to_json(),
                "pages": pages, "drawings": drawings}

    @_serialized
    @_mod_writer
    def accept_remap(self, preview: str) -> RemapResult:
        """Store the exact reviewed bytes once, recording both ends in the same state write."""
        prepared = self._remap_previews.get(preview)
        if prepared is None or prepared["expires"] <= time.monotonic():
            self._remap_previews.pop(preview, None)
            raise ServiceError("entry_changed")
        record = self._record(prepared["source"])
        if record.get("repaired_from") or record.get("repaired_id") or prepared["identity"] != self._identity(
                {path.name: path for path in self._paths(record)}):
            raise ServiceError("entry_changed")
        with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX + "accept-") as temporary:
            files = {}
            for name, data in prepared["files"].items():
                path = Path(temporary) / name
                path.write_bytes(data)
                files[name] = path
            stored = self._store(files, self._label(record), record["target"], record["kind"], repaired_from=record["id"])
        self._remap_previews.pop(preview, None)
        return RemapResult(self._entry(stored), prepared["report"],
                           replace(prepared["compare"], mod_id=stored["id"]))

    @_serialized
    def discard_remap(self, preview: str) -> None:
        """Drop the temporary review without changing any mod or game file."""
        self._remap_previews.pop(preview, None)

    @_serialized
    def update(self, mod_id: str, log: LogFunc = no_log,
               progress: Callable[[dict], None] | None = None, pin: Pin | None = None) -> UpdateResult:
        """Rebuild a mod against current official bundles and retain its old files. Its built copies go: they hold
        the old build."""
        pin = self._current(pin)
        record = self._record(mod_id)
        paths = self._paths(record)
        targets = self._plan_targets(self._plan(record, log, pin))
        with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX + "update-") as temporary:
            output = Path(temporary)
            generated = []
            all_unchanged = True
            for i, target in enumerate(targets, 1):
                def step(key: str) -> None:
                    if progress:
                        progress({"current": i, "total": len(targets), "step": f"import.step.{key}"})

                step("check")
                result = core.process_mod_update(
                    paths, [self._official_for(target, pin)], output, self.settings.asset_types(),
                    self.settings.save_options(self.settings.crc_needed(target)), self.settings.spine_options(),
                    skip_unchanged=True, match_strategy="cont_name_type",
                    anim_check=self.settings.anim_check_options(), log=log, on_step=step)
                if not result.success:
                    raise ServiceError("mod_update_failed", id=mod_id)
                if result.message != "all_targets_unchanged":
                    all_unchanged = False
                generated.extend(pair.output for pair in result.file_pairs)
            if all_unchanged or (len(generated) == len(paths) and all(
                    new.name == old.name and self._hashes.get(new).sha1 == self._hashes.get(old).sha1
                    for new, old in zip(sorted(generated), sorted(paths)))):
                return UpdateResult(self._entry(record), paths, [], unchanged=True)
            # Include unchanged parts when a rebuild splits a mod across bundles.
            names = {path.name for path in generated}
            for target in targets:
                if target.name not in names:
                    atomic_copy(self._official_for(target, pin), output / target.name)
                    generated.append(output / target.name)
            directory = paths[0].parent
            previous_dir = directory / "previous" / uuid.uuid4().hex
            previous = []
            for path in paths:
                backup = previous_dir / path.name
                atomic_copy(path, backup)
                previous.append(backup)
            old_record = dict(record)
            try:
                for path in generated:
                    atomic_copy(path, directory / path.name)
                record["files"] = [path.name for path in sorted(generated)]
                self._save()
            except OSError:
                record.update(old_record)
                for path in previous:
                    atomic_copy(path, directory / path.name)
                for path in generated:
                    if path.name not in old_record["files"]:
                        (directory / path.name).unlink(missing_ok=True)
                raise
            for path in paths:
                if path.name not in record["files"]:
                    path.unlink()
        with contextlib.suppress(ServiceError):
            for key in ((self.profiles.read() or {}).get("folders") or {}):
                self._drop_built(key, when=lambda built: built.get("source") == f"mod:{mod_id}")
        return UpdateResult(self._entry(record), self._paths(record), previous)

    @_serialized
    def extract(self, target: str, out_dir: Path, log: LogFunc = no_log, pin: Pin | None = None,
                progress: Callable[[dict], None] | None = None) -> Path:
        """Extract game or mod bundles into a folder named after their core."""
        if target.startswith("mod:"):
            paths = self._paths(self._record(target[4:]))
        elif target.startswith("variant:"):
            paths = self._game_files(target[8:], None, pin)
        else:
            raise ServiceError("source_unsupported", source=target)
        if not paths:
            raise ServiceError("game_file_not_found", target=target)
        folder = Path(out_dir).resolve() / parse_filename(paths[0].name).core
        folder.mkdir(parents=True, exist_ok=True)
        report = (lambda current, total, _name: progress({"current": current, "total": total,
                                                        "step": "import.step.extract"})) if progress else None
        success, _ = core.process_asset_extraction(paths, folder, spine_options=self.settings.spine_options(False),
                                                  log=log, progress_callback=report)
        if not success:
            raise ServiceError("asset_extraction_failed", target=target)
        return folder

    def _asset_hashes(self, paths: list[Path]) -> dict[tuple[str, str, int], tuple[str, int]]:
        assets = {}
        counts: dict[tuple[str, str], int] = {}
        types = {AssetType.Texture2D, AssetType.TextAsset, AssetType.Mesh, AssetType.AnimationClip}
        for path in paths:
            bundle = Bundle.load(path)
            if bundle is None:
                raise ServiceError("bundle_invalid", file=path)
            for obj in bundle.env.objects:
                if obj.type not in types:
                    continue
                name = obj.peek_name() or ""
                key = (name, obj.type.name)
                occurrence = counts.get(key, 0)
                counts[key] = occurrence + 1
                raw = obj.get_raw_data()
                digest = hashlib.sha1(raw)
                size = len(raw)
                # Streamed textures and meshes may change without any change to
                # their serialized object; include the referenced payload too.
                data = obj.read()
                stream = getattr(data, "m_StreamData", None)
                if stream and stream.path and stream.size:
                    payload = get_resource_data(stream.path, obj.assets_file, stream.offset, stream.size)
                    digest.update(payload)
                    size += len(payload)
                assets[(*key, occurrence)] = (digest.hexdigest(), size)
        return assets

    @_serialized
    def compare(self, mod_id: str, pin: Pin | None = None) -> CompareResult:
        """Hash raw assets against the current official files, even when a mod is installed."""
        pin = self._current(pin)
        record = self._record(mod_id)
        targets = self._plan_targets(self._plan(record, no_log, pin))
        baseline = [self._official_for(path, pin) for path in targets]
        return self._compare_paths(mod_id, self._paths(record), baseline)

    def _compare_paths(self, mod_id: str, paths: list[Path], baseline: list[Path]) -> CompareResult:
        try:
            mod = self._asset_hashes(paths)
            official = self._asset_hashes(baseline)
        except (ValueError, EOFError) as error:
            raise ServiceError("bundle_invalid", id=mod_id) from error
        differences = []
        for key in sorted(mod.keys() | official.keys()):
            left, right = mod.get(key), official.get(key)
            status = "removed" if left is None else "added" if right is None else (
                "same" if left[0] == right[0] else "changed")
            differences.append(AssetDifference(key[0], key[1], status, left[1] if left else None,
                                               right[1] if right else None))
        return CompareResult(mod_id, differences)


def _merge(base: dict, mine: dict, disk: dict) -> dict:
    """This instance's changes since ``base`` applied to ``disk``: keys it added or changed take its value, keys it
    removed go; the rest is as the file holds it (this instance's own objects where they are equal)."""
    out = {key: mine[key] if key in mine and mine[key] == value else value for key, value in disk.items()}
    for key in base.keys() | mine.keys():
        if key in mine:
            if key not in base or mine[key] != base[key]:
                out[key] = mine[key]
        else:
            out.pop(key, None)
    return out


def _drop_source(data: dict, source: str, keys: list[dict]) -> list[tuple[str, str]]:
    """Drop every configuration naming a source, with its markers and built copies (collected in ``keys``);
    returns the entries."""
    dropped = []
    for key, folder in data["folders"].items():
        for core in [core for core, entry in folder["configured"].items() if entry.get("source") == source]:
            del folder["configured"][core]
            folder["updated"].pop(core, None)
            dropped.append((key, core))
        for core in [core for core, entry in folder["built"].items() if entry.get("source") == source]:
            keys.append(folder["built"].pop(core))
            if (key, core) not in dropped:
                dropped.append((key, core))
    return dropped


def _pins_signature(pins: list[Pin]) -> list[tuple[str, tuple[str, ...]]]:
    return sorted((pin.key, tuple(str(folder) for folder in pin.dirs)) for pin in pins)


@functools.cache
def _build_version() -> str:
    """The program build: a cached build is never reused across versions."""
    from ..utils import get_version_info

    info = get_version_info()
    return f"{info.get('version')}:{info.get('commit_hash')}"


def _folder_size(directory: Path) -> int:
    total = 0
    if directory.is_dir():
        for path in directory.glob("*.bundle"):
            with contextlib.suppress(OSError):
                total += path.stat().st_size
    return total
