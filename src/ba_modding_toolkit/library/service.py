"""Thread-safe library operations built on the classic mod installer."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from UnityPy.helpers.ResourceReader import get_resource_data

from .. import core, devmode, mod_install
from ..bundle import Bundle
from ..catalog import HOME_SUFFIXES
from ..errors import ServiceError
from ..models import AssetType, LogFunc, ProgressCallback
from ..naming import parse_filename
from ..searching import SEARCH_DIR_SUFFIXES
from ..utils import no_log
from .models import (
    ApplyResult, AssetDifference, CompareResult, GameFileState, Kind, ModEntry,
    UpdateResult, VariantState,
)
from .safety import check_resource_path, writable_game_files
from .storage import Fingerprints, atomic_copy, atomic_json
from .variants import adapt_variant_sources

if TYPE_CHECKING:
    from ..catalog import Catalog
    from ..config import Settings
    from ..gameassets import GameAssets

logger = logging.getLogger(__name__)


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
        with self._lock:
            try:
                return method(self, *args, **kwargs)
            except OSError as error:
                logger.exception("Library file operation failed")
                raise ServiceError("library_io_error", file=error.filename) from error
            except ServiceError:
                raise
            except Exception as error:
                logger.exception("Library operation failed: %s", method.__name__)
                raise ServiceError("library_operation_failed", operation=method.__name__) from error
    return call


class ModLibrary:
    """Store mods, retain verified official originals, and track installed sources.

    One reentrant lock serializes state changes and UnityPy work in this service.
    Call long operations on the caller's worker thread.
    """

    def __init__(self, root: Path, catalog: Catalog, game: GameAssets, settings: Settings) -> None:
        self.root = Path(root).resolve()
        self.catalog = catalog
        self.game = game
        self.settings = settings
        self._lock = threading.RLock()
        self._hashes = Fingerprints()
        self._records: dict[str, dict[str, Any]] = {}
        self._favorites: set[str] = set()
        self._applied: dict[str, dict[str, str]] = {}
        self._index_signature: tuple = ()
        self._index: dict[str, list[Path]] = {}
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads((self.root / "state.json").read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1:
                return
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
                if record["kind"] not in ("spr", "lobby") or not isinstance(record["seen"], bool):
                    continue
                if all((self.root / "mods" / mod_id / f).is_file() for f in files):
                    records[mod_id] = record
            favorites = {key for key in data.get("favorites", []) if isinstance(key, str)}
            applied = {
                path: record for path, record in data.get("applied", {}).items()
                if isinstance(path, str) and isinstance(record, dict)
                and isinstance(record.get("source"), str) and isinstance(record.get("sha1"), str)
            }
            self._records, self._favorites, self._applied = records, favorites, applied
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            logger.warning("Ignoring unreadable library state", exc_info=True)

    def _save(self) -> None:
        atomic_json(self.root / "state.json", {
            "version": 1, "mods": list(self._records.values()),
            "favorites": sorted(self._favorites), "applied": self._applied,
        })

    def _variant(self, key: str) -> Any:
        try:
            return self.catalog.variant(key)
        except KeyError as error:
            raise ServiceError("variant_not_found", variant=key) from error

    def _record(self, mod_id: str) -> dict[str, Any]:
        try:
            return self._records[mod_id]
        except KeyError as error:
            raise ServiceError("mod_not_found", id=mod_id) from error

    def _paths(self, record: dict[str, Any]) -> list[Path]:
        directory = self.root / "mods" / record["id"]
        paths = [directory / name for name in record["files"]]
        if any(not path.resolve().is_relative_to(directory.resolve()) for path in paths):
            raise ServiceError("mod_unsupported", file=paths[0])
        return paths

    def _entry(self, record: dict[str, Any]) -> ModEntry:
        paths = self._paths(record)
        parsed = parse_filename(paths[0].name)
        return ModEntry(record["id"], paths[0], record["label"], record["target"], record["kind"],
                        record["added"], not record["seen"], sum(p.stat().st_size for p in paths),
                        parsed.date, parsed.crc)

    @_serialized
    def mods(self) -> list[ModEntry]:
        """Return the mod entries in insertion order."""
        return [self._entry(record) for record in self._records.values()]

    @_serialized
    def add(self, paths: list[Path]) -> list[ModEntry]:
        """Store one mod per core and date, deduplicating complete bundle sets. In dev mode (devmode) only files
        inside the dev roots are taken."""
        for path in paths:
            devmode.check_read(path)
        return self._add(paths)

    def _add(self, paths: list[Path]) -> list[ModEntry]:
        known = {frozenset((path.name, self._hashes.get(path).sha1) for path in self._paths(record))
                 for record in self._records.values()}
        groups: dict[tuple[str, str], dict[str, Path]] = {}
        for source in map(Path, paths):
            name = source.name.removesuffix(".backup") if source.name.endswith(".bundle.backup") else source.name
            parsed = parse_filename(name)
            kind: Kind | None = "spr" if parsed.core.lower().endswith("_spr") else (
                "lobby" if parsed.core.lower().endswith(HOME_SUFFIXES) else None)
            variant = self.catalog.variant_for_core(parsed.core.lower()) if kind else None
            if not name.endswith(".bundle") or not parsed.prefix or not parsed.crc or kind is None or variant is None:
                raise ServiceError("mod_unsupported", file=source)
            group = groups.setdefault((parsed.core.lower(), parsed.date), {})
            if name in group and self._hashes.get(group[name]).sha1 != self._hashes.get(source).sha1:
                raise ServiceError("mod_unsupported", file=source)
            group[name] = source

        added = []
        for group in groups.values():
            signature = frozenset((name, self._hashes.get(source).sha1) for name, source in group.items())
            if signature in known:
                continue
            names = sorted(group)
            parsed = parse_filename(names[0])
            variant = self.catalog.variant_for_core(parsed.core.lower())
            kind = "spr" if parsed.core.lower().endswith("_spr") else "lobby"
            mod_id = uuid.uuid4().hex
            directory = self.root / "mods" / mod_id
            record = {"id": mod_id, "files": names, "label": parsed.core, "target": variant.key,
                      "kind": kind, "added": datetime.now(timezone.utc).isoformat(), "seen": False}
            try:
                for name in names:
                    atomic_copy(group[name], directory / name)
                self._records[mod_id] = record
                self._save()
            except OSError:
                self._records.pop(mod_id, None)
                shutil.rmtree(directory, ignore_errors=True)
                raise
            known.add(signature)
            added.append(self._entry(record))
        return added

    @_serialized
    def remove(self, mod_id: str) -> None:
        """Remove a stored mod while retaining restore copies and applied history.

        A mod the game still shows (one of its game files is unchanged since the
        library put the mod there) is refused: the library is the only place it
        is kept once another source replaces it. ``mod_in_use`` names the file in
        the current game folder, ``mod_in_use_elsewhere`` the other game folder
        (``folder``) where it is in use, to be switched there first.
        """
        record = self._record(mod_id)
        in_use = self._in_use(mod_id)
        if in_use:
            dirs = self._resource_dirs()
            here = [path for path in in_use if any(path.is_relative_to(d) for d in dirs)]
            if here:
                raise ServiceError("mod_in_use", id=mod_id, file=here[0])
            # not limited to this game folder: removed, the mod would be left only in the other folder's game files,
            # lost to a check in its launcher or a game update there
            raise ServiceError("mod_in_use_elsewhere", id=mod_id, file=in_use[0], folder=_game_folder(in_use[0]))
        del self._records[mod_id]
        try:
            self._save()
        except OSError:
            self._records[mod_id] = record
            raise
        shutil.rmtree(self.root / "mods" / mod_id)

    @_serialized
    def rename(self, mod_id: str, label: str) -> None:
        """Change a mod's display label."""
        record = self._record(mod_id)
        old = record["label"]
        record["label"] = label
        try:
            self._save()
        except OSError:
            record["label"] = old
            raise

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

    def _resource_dirs(self) -> list[Path]:
        return [Path(directory).resolve() for directory in self.settings.resource_dirs()]

    def _scan(self) -> dict[str, list[Path]]:
        directories = self._resource_dirs()
        signature = tuple((str(d), d.stat().st_mtime_ns) for d in directories)
        if signature != self._index_signature:
            index: dict[str, list[Path]] = {}
            for directory in directories:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if entry.name.endswith(".bundle") and entry.is_file(follow_symlinks=False):
                            parsed = parse_filename(entry.name)
                            index.setdefault(parsed.core.lower(), []).append(Path(entry.path))
            self._index = {key: sorted(paths) for key, paths in index.items()}
            self._index_signature = signature
        return self._index

    def _game_files(self, key: str, kind: Kind | None = None) -> list[Path]:
        variant = self._variant(key)
        index = self._scan()
        return [path for current, value in (("spr", variant.spr), ("lobby", variant.lobby))
                if value and (kind is None or current == kind) for path in index.get(value.lower(), [])]

    def _is_official(self, path: Path) -> bool:
        parsed = parse_filename(path.name)
        fingerprint = self._hashes.get(path)
        return fingerprint.trailing == 0 and bool(parsed.crc) and fingerprint.crc == int(parsed.crc)

    def _original_path(self, game_file: Path) -> Path:
        return self.root / "originals" / game_file.name

    def _official_for(self, game_file: Path) -> Path:
        check_resource_path(game_file, self._resource_dirs())
        original = self._original_path(game_file)
        if original.exists():
            if not self._is_official(original):
                raise ServiceError("original_invalid", file=original)
            return original
        if not self._is_official(game_file):
            raise ServiceError("original_unavailable", file=game_file)
        return game_file

    def _keep_original(self, game_file: Path) -> None:
        official = self._official_for(game_file)
        original = self._original_path(game_file)
        if official != original:
            atomic_copy(official, original)
            if not self._is_official(original):
                original.unlink()
                raise ServiceError("original_invalid", file=game_file)

    def _carried(self, path: Path) -> str:
        """What a game file carries: the source the library put there while the file is unchanged since, else
        "official" or "unknown" (changed outside the library)."""
        record = self._applied.get(str(path.resolve()), {})
        if record.get("sha1") == self._hashes.get(path).sha1:
            return record["source"]
        return "official" if self._is_official(path) else "unknown"

    def _in_use(self, mod_id: str) -> list[Path]:
        """The game files that still carry the mod, in this install or another one the library wrote to. A part the
        mod left official (it replaces its kind as a unit) carries nothing of it."""
        paths = []
        for name, record in self._applied.items():
            if record.get("source") != f"mod:{mod_id}":
                continue
            path = Path(name)
            try:
                if path.is_file() and self._hashes.get(path).sha1 == record["sha1"] and not self._is_official(path):
                    paths.append(path)
            except OSError:
                continue
        return paths

    def _keep_replaced(self, targets: list[Path]) -> list[str]:
        """Store the game files about to be replaced that are kept nowhere else as library mods, and return the ids
        of the mods added. Official files go to originals/ (_keep_original), mods of the library stay in mods/, and
        another variant's files can be adapted again; what is left is a file changed outside the library (another
        tool, a manual copy) or a mod removed from the library before removing an applied mod was refused."""
        keep = []
        for target in targets:
            carried = self._carried(target)
            # an official part a removed mod left untouched goes to originals/ like any official file
            if carried == "unknown" or (carried.startswith("mod:") and carried[4:] not in self._records
                                        and not self._is_official(target)):
                keep.append(target)
        if not keep:
            return []
        added = self._add(keep)
        for entry in added:
            logger.info("Kept the replaced game file %s as mod %s", entry.file.name, entry.id)
        return [entry.id for entry in added]

    def _drop_mods(self, mod_ids: list[str]) -> None:
        """Forget mods _keep_replaced added for a replacement that was rolled back (their files are in the game
        again). A state that cannot be saved still lists them; loading drops records without files."""
        if not mod_ids:
            return
        for mod_id in mod_ids:
            self._records.pop(mod_id, None)
        try:
            self._save()
        except OSError:
            logger.warning("Could not save the library state after a rollback", exc_info=True)
        for mod_id in mod_ids:
            shutil.rmtree(self.root / "mods" / mod_id, ignore_errors=True)

    def _needed_elsewhere(self, name: str, mine: set[str]) -> bool:
        """Whether another install (another game folder sharing this library) may still need the kept original of
        a file name: a file of that name the library wrote to outside ``mine`` (resolved paths) needs it."""
        return any(self._needs_original(Path(other), record) for other, record in self._applied.items()
                   if other not in mine and Path(other).name == name)

    def _needs_original(self, path: Path, record: dict[str, str]) -> bool:
        """Whether a game file the library wrote to may still need the kept original of its name: while it is not
        official. The file decides, not the record, which is stale once the file changed since (verified in the
        launcher, switched by another tool) or is gone from its folder (an install moved, a game update). Only a
        file whose folder cannot be seen at all (an unmounted drive) is judged by its record."""
        try:
            if not path.parent.is_dir():
                return record.get("source") != "official"
            if not path.is_file():
                return False
            # still modded, by the library or changed outside it since: the kept copy is the only official file the
            # library has to switch that install back
            return not self._is_official(path)
        except OSError:
            return True

    def _release_original(self, game_file: Path) -> bool:
        """Delete a kept original once its game file is verified official again: byte for byte the kept copy,
        official by the CRC in its name, and needed by no other install."""
        original = self._original_path(game_file)
        try:
            if not original.is_file() or not game_file.is_file():
                return False
            if (self._hashes.get(game_file).sha1 != self._hashes.get(original).sha1
                    or not self._is_official(game_file)
                    or self._needed_elsewhere(game_file.name, {str(game_file.resolve())})):
                return False
            original.unlink()
        except OSError:
            logger.warning("Could not release the kept original of %s", game_file, exc_info=True)
            return False
        logger.info("Released the kept original of %s", game_file.name)
        return True

    def _prune(self) -> list[Path]:
        directory = self.root / "originals"
        if not directory.is_dir():
            return []
        dirs = self._resource_dirs()
        index = self._scan()
        current = {path.name: path for paths in index.values() for path in paths}

        def part(path: Path) -> tuple[str, str | None]:
            parsed = parse_filename(path.name)
            return parsed.prefix, parsed.res_type

        released, stale = [], []
        for original in sorted(directory.glob("*.bundle")):
            game_file = current.get(original.name)
            if game_file is not None:
                if self._release_original(game_file):
                    released.append(original)
                continue
            # The name carries the CRC: after a game update the old file is gone and its copy can never be restored.
            # Only the install's own records tell which folder it was in; without one it may be another install's.
            owners = [Path(name) for name in self._applied if Path(name).name == original.name]
            mine = [path for path in owners if any(path.is_relative_to(d) for d in dirs) and not path.exists()]
            if not mine or self._needed_elsewhere(original.name, {str(path) for path in mine}):
                continue
            parsed = parse_filename(original.name)
            core = parsed.core.lower()
            # a successor is dated after the old file: an older official file of the same part (a downgrade, an old
            # copy of the folder put back) does not replace the only official copy of the newer one
            superseded = bool(parsed.date)
            for path in mine:
                successors = [other for other in index.get(core, [])
                              if other.parent == path.parent and part(other) == part(path)
                              and parse_filename(other.name).date > parsed.date]
                try:
                    if not successors or not all(self._is_official(other) for other in successors):
                        superseded = False
                except OSError:
                    superseded = False
            if not superseded:
                continue
            try:
                original.unlink()
            except OSError:
                logger.warning("Could not delete the outdated original %s", original, exc_info=True)
                continue
            logger.info("Deleted the original %s, replaced by a game update", original.name)
            released.append(original)
            stale.extend(str(path) for path in mine)
        if stale:
            old_applied = dict(self._applied)
            for name in stale:
                self._applied.pop(name, None)
            try:
                self._save()
            except OSError:
                self._applied = old_applied
                logger.warning("Could not save the library state after pruning", exc_info=True)
        return released

    @_serialized
    def prune(self) -> list[Path]:
        """Delete the kept originals no longer needed and return them: those whose game file is verified official
        again (restored, or verified in the game's launcher), and those of files a game update replaced with a
        verified official file of the same part. Originals of another install's files are kept."""
        return self._prune()

    @_serialized
    def state(self, variant_key: str) -> VariantState:
        """Inspect all game parts using headers and cached hashes, without UnityPy."""
        files = []
        for path in self._game_files(variant_key):
            parsed = parse_filename(path.name)
            fingerprint = self._hashes.get(path)
            official = self._is_official(path)
            applied = self._carried(path)
            crc = "ok" if official else "fixed" if (
                fingerprint.trailing is not None and fingerprint.trailing > 0
                and parsed.crc and fingerprint.crc == int(parsed.crc)) else "needs_fix"
            original = self._original_path(path)
            files.append(GameFileState(path, parsed.core, "spr" if parsed.core.lower().endswith("_spr") else "lobby",
                                       applied, crc, original.exists() and self._is_official(original),
                                       parsed.date, fingerprint.size))
        sources = {file.applied for file in files}
        crc = "needs_fix" if any(f.crc == "needs_fix" for f in files) else (
            "fixed" if any(f.crc == "fixed" for f in files) else "ok")
        return VariantState(variant_key, files, sources.pop() if len(sources) == 1 else "unknown",
                            crc, any(f.original for f in files))

    @_serialized
    def modified(self) -> dict[str, str]:
        """Variants whose portrait files are not official, from cheap checks only (no hashing): the library's own
        records while the file is unchanged since it wrote it, else trailing bytes after the bundle data.
        Returns {variant key: source}, the source being "mod:<id>", "variant:<key>" or "unknown"."""
        out: dict[str, str] = {}
        for core, paths in self._scan().items():
            if not core.endswith("_spr"):
                continue
            variant = self.catalog.variant_for_core(core)
            if variant is None:
                continue
            sources = set()
            for path in paths:
                record = self._applied.get(str(path.resolve()))
                try:
                    stat = path.stat()
                except OSError:
                    continue
                if record and record.get("size") == stat.st_size and record.get("mtime") == stat.st_mtime_ns:
                    if record["source"] != "official":
                        sources.add(record["source"])
                elif Bundle.get_trailing_bytes(path):
                    sources.add("unknown")
            if sources:
                out[variant.key] = sources.pop() if len(sources) == 1 else "unknown"
        return out

    @_serialized
    def preview_bundles(self, mod_id: str) -> list[Path]:
        """Return missing official parts followed by the mod's overriding parts.

        Parts match by prefix and resource type, independent of date and CRC.
        Pass this order to ``GameAssets.spine_files_from`` so mod assets win.
        """
        record = self._record(mod_id)
        paths = self._paths(record)
        def part(path: Path) -> tuple[str, str | None]:
            parsed = parse_filename(path.name)
            return parsed.prefix, parsed.res_type
        replaced = {part(path) for path in paths}
        others = [self._official_for(path) for path in self._game_files(record["target"], record["kind"])
                  if part(path) not in replaced]
        return others + paths

    def _plan(self, record: dict[str, Any], log: LogFunc) -> list[mod_install.ModGroup]:
        groups = mod_install.plan_mod_install(self._paths(record), self._resource_dirs(), log)
        if not groups or any(file.action not in (mod_install.InstallAction.DIRECT_REPLACE,
                                                 mod_install.InstallAction.UPDATE)
                             for group in groups for file in group.files):
            raise ServiceError("game_file_not_found", variant=record["target"])
        return groups

    @staticmethod
    def _plan_targets(groups: list[mod_install.ModGroup]) -> list[Path]:
        return sorted({path for group in groups for path in (
            group.target_paths + [file.existing_path for file in group.files if file.existing_path is not None])})

    def _stage_official(self, paths: list[Path], directory: Path) -> dict[Path, Path]:
        staged = {}
        directory.mkdir(parents=True, exist_ok=True)
        for path in paths:
            target = directory / path.name
            if target in staged.values():
                raise ServiceError("game_file_conflict", file=path)
            atomic_copy(self._official_for(path), target)
            staged[path] = target
        return staged

    def _commit(self, replacements: dict[Path, Path], source: str, log: LogFunc,
                progress: ProgressCallback | None = None) -> list[Path]:
        """Write prepared files over game files as one unit, keeping what they replace: the official file in
        originals/ (once), a file kept nowhere else as a library mod (_keep_replaced). Every written part is rolled
        back on failure. Afterwards, kept originals no longer needed are deleted (_prune), whatever the outcome."""
        try:
            return self._write(replacements, source, log, progress)
        finally:
            try:
                self._prune()
            except Exception:  # never in the way of the switch itself; the next prune tries again
                logger.warning("Could not prune the kept originals", exc_info=True)

    def _write(self, replacements: dict[Path, Path], source: str, log: LogFunc,
               progress: ProgressCallback | None = None) -> list[Path]:
        for target, prepared in replacements.items():
            check_resource_path(target, self._resource_dirs())
            if self._hashes.get(prepared).trailing is None:
                raise ServiceError("bundle_invalid", file=prepared)
        changed = {target: prepared for target, prepared in replacements.items()
                   if self._hashes.get(target).sha1 != self._hashes.get(prepared).sha1}
        old_applied = dict(self._applied)
        records = {str(target.resolve()): {"source": source, "sha1": self._hashes.get(prepared).sha1}
                   for target, prepared in replacements.items()}
        if not changed:
            for target in replacements:
                stat = target.stat()
                records[str(target.resolve())].update(size=stat.st_size, mtime=stat.st_mtime_ns)
            if any(self._applied.get(path) != record for path, record in records.items()):
                self._applied.update(records)
                try:
                    self._save()
                except OSError:
                    self._applied = old_applied
                    raise
            return []
        written = []
        with writable_game_files(list(changed), self._resource_dirs()), tempfile.TemporaryDirectory() as temporary:
            for target in changed:
                self._keep_original(target)
            kept = self._keep_replaced(list(changed))
            rollback = {}
            try:
                for i, target in enumerate(changed):
                    backup = Path(temporary) / str(i)
                    shutil.copyfile(target, backup)
                    rollback[target] = backup
            except Exception:
                self._drop_mods(kept)
                raise
            saving_state = False
            try:
                for i, (target, prepared) in enumerate(changed.items(), 1):
                    check_resource_path(target, self._resource_dirs())
                    atomic_copy(prepared, target)
                    written.append(target)
                    log(f"Installed {target.name}")
                    if progress:
                        progress(i, len(changed), target.name)
                saving_state = True
                for target in replacements:
                    stat = target.stat()
                    records[str(target.resolve())].update(size=stat.st_size, mtime=stat.st_mtime_ns)
                self._applied.update(records)
                self._save()
            except Exception as error:
                self._applied = old_applied
                restored = True
                for target in reversed(written):
                    try:
                        atomic_copy(rollback[target], target)
                    except OSError:
                        restored = False
                        logger.exception("Could not roll back game file %s", target)
                if restored:
                    # what they kept is in the game again; a part left half written keeps them
                    self._drop_mods(kept)
                if isinstance(error, OSError):
                    code = "library_io_error" if saving_state else "game_file_locked"
                    raise ServiceError(code, file=error.filename) from error
                raise
        return written

    def _stage_adapted(self, sources: list[Path], targets: list[Path], directory: Path,
                       log: LogFunc) -> dict[Path, Path]:
        staged = self._stage_official(targets, directory / "targets")
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

    @_serialized
    def apply(self, variant_key: str, source: str, log: LogFunc = no_log,
              progress: ProgressCallback | None = None, kind: Kind | None = "spr") -> ApplyResult:
        """Install one kind from a mod, variant, or originals; None selects both.

        A mod replaces all parts of its own kind as a unit. Another variant's
        mod must belong to the same family and is adapted to official targets.
        """
        variant = self._variant(variant_key)
        if source == "official":
            return self.restore(variant_key, log, kind)
        with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX) as temporary:
            work = Path(temporary)
            if source.startswith("mod:"):
                record = self._record(source[4:])
                if (kind is not None and record["kind"] != kind) or (
                        self._variant(record["target"]).family != variant.family):
                    raise ServiceError("mod_target_mismatch", id=record["id"], variant=variant_key)
                targets = self._game_files(variant_key, record["kind"])
                if not targets:
                    raise ServiceError("game_file_not_found", variant=variant_key)
                if record["target"] != variant_key:
                    replacements = self._stage_adapted(self.preview_bundles(record["id"]), targets,
                                                       work / record["kind"], log)
                    files = self._commit(replacements, source, log, progress)
                    return ApplyResult(variant_key, source, files, unchanged=not files)
                groups = self._plan(record, log)
                allowed = set(targets)
                planned = self._plan_targets(groups)
                if any(path not in allowed for path in planned):
                    raise ServiceError("game_file_outside_resources", file=next(p for p in planned if p not in allowed))
                staged = self._stage_official(targets, work / "targets")
                # Execute only against temporary copies. The classic installer may
                # copy directly or rebuild; all real game writes go through _commit.
                staged_groups = [replace(group, files=[replace(file,
                    existing_path=staged.get(file.existing_path),
                    need_crc_fix=self.settings.crc_needed(file.existing_path)
                    if file.existing_path else False) for file in group.files],
                    target_paths=[staged[path] for path in group.target_paths]) for group in groups]
                result = mod_install.execute_mod_install(
                    staged_groups, work / "output", self.settings.asset_types(),
                    self.settings.save_options(self.settings.crc_needed(targets[0])),
                    self.settings.spine_options(), anim_check=self.settings.anim_check_options(),
                    create_backup=False, log=log, progress_callback=progress)
                if result.failed_groups:
                    raise ServiceError("mod_apply_failed", id=record["id"])
                replacements = staged
            elif source.startswith("variant:"):
                other = source[8:]
                self._variant(other)
                replacements = {}
                for current in (("spr", "lobby") if kind is None else (kind,)):
                    targets = self._game_files(variant_key, current)
                    sources = self._game_files(other, current)
                    if not targets or not sources:
                        continue
                    replacements.update(self._stage_adapted(
                        [self._official_for(path) for path in sources], targets, work / current, log))
                if not replacements:
                    raise ServiceError("game_file_not_found", variant=variant_key)
            else:
                raise ServiceError("source_unsupported", source=source)
            files = self._commit(replacements, source, log, progress)
            return ApplyResult(variant_key, source, files, unchanged=not files)

    @_serialized
    def restore(self, variant_key: str, log: LogFunc = no_log, kind: Kind | None = "spr") -> ApplyResult:
        """Restore one kind to official bytes; None restores portrait and lobby."""
        targets = self._game_files(variant_key, kind)
        if not targets:
            raise ServiceError("game_file_not_found", variant=variant_key)
        replacements = {path: self._official_for(path) for path in targets}
        files = self._commit(replacements, "official", log)
        return ApplyResult(variant_key, "official", files, unchanged=not files)

    @_serialized
    def update(self, mod_id: str, log: LogFunc = no_log,
               progress: ProgressCallback | None = None) -> UpdateResult:
        """Rebuild a mod against current official bundles and retain its old files."""
        record = self._record(mod_id)
        paths = self._paths(record)
        targets = self._plan_targets(self._plan(record, log))
        with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX + "update-") as temporary:
            output = Path(temporary)
            generated = []
            all_unchanged = True
            for i, target in enumerate(targets, 1):
                if progress:
                    progress(i, len(targets), target.name)
                result = core.process_mod_update(
                    paths, [self._official_for(target)], output, self.settings.asset_types(),
                    self.settings.save_options(self.settings.crc_needed(target)), self.settings.spine_options(),
                    skip_unchanged=True, match_strategy="cont_name_type",
                    anim_check=self.settings.anim_check_options(), log=log)
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
                    atomic_copy(self._official_for(target), output / target.name)
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
            return UpdateResult(self._entry(record), self._paths(record), previous)

    @_serialized
    def extract(self, target: str, out_dir: Path, log: LogFunc = no_log) -> Path:
        """Extract game or mod bundles into a folder named after their core."""
        if target.startswith("mod:"):
            paths = self._paths(self._record(target[4:]))
        elif target.startswith("variant:"):
            paths = self._game_files(target[8:])
        else:
            raise ServiceError("source_unsupported", source=target)
        if not paths:
            raise ServiceError("game_file_not_found", target=target)
        folder = Path(out_dir).resolve() / parse_filename(paths[0].name).core
        folder.mkdir(parents=True, exist_ok=True)
        success, _ = core.process_asset_extraction(paths, folder, spine_options=self.settings.spine_options(False), log=log)
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
    def compare(self, mod_id: str) -> CompareResult:
        """Hash raw assets against the current official files, even when a mod is installed."""
        record = self._record(mod_id)
        targets = self._plan_targets(self._plan(record, no_log))
        try:
            mod = self._asset_hashes(self._paths(record))
            official = self._asset_hashes([self._official_for(path) for path in targets])
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
